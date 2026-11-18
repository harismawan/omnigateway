//! Frozen lifecycle decisions, with effects injected independently of the host.
use std::{collections::HashMap, sync::Arc};

use crate::api::ApiError;
use omni_ir::error::ErrorCode;
use serde_json::{Value, json};

pub type CommandResult = Result<(i32, String), String>;
pub type CommandRunner = Arc<dyn Fn(Vec<String>) -> CommandResult + Send + Sync>;

#[derive(Clone)]
pub struct Lifecycle {
    pub env: HashMap<String, String>,
    pub container: bool,
    pub run: CommandRunner,
}

impl std::fmt::Debug for Lifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lifecycle").finish_non_exhaustive()
    }
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            env: std::env::vars().collect(),
            container: std::path::Path::new("/.dockerenv").exists(),
            run: Arc::new(|argv| {
                let output = std::process::Command::new(&argv[0])
                    .args(&argv[1..])
                    .output()
                    .map_err(|e| e.to_string())?;
                Ok((
                    output.status.code().unwrap_or(1),
                    String::from_utf8_lossy(&output.stderr).into_owned(),
                ))
            }),
        }
    }
}

impl Lifecycle {
    pub fn describe(&self) -> Value {
        if self.env.contains_key("JOURNAL_STREAM") {
            json!({"supervisor":"systemd","canRestart":true,"canShutdown":true})
        } else if self.container {
            json!({"supervisor":"container","canRestart":true,"canShutdown":true,"note":"restart exits the container and relies on its restart policy, which cannot be read from inside it"})
        } else {
            json!({"supervisor":"none","canRestart":false,"canShutdown":true})
        }
    }

    /// Returns whether the caller should defer a clean stop after flushing HTTP.
    pub async fn restart(&self, cluster: bool) -> Result<bool, ApiError> {
        if cluster {
            return Err(ApiError::gateway(
                ErrorCode::BadRequest,
                "this is one replica of a cluster; roll the deployment to restart the fleet",
            ));
        }
        if !self.env.contains_key("JOURNAL_STREAM") {
            return if self.container {
                Ok(true)
            } else {
                Err(ApiError::gateway(
                    ErrorCode::Conflict,
                    "this installation has no supervisor that would restart the gateway",
                ))
            };
        }
        let mut argv = vec!["systemctl".to_owned()];
        if self.env.contains_key("MANAGERPID") {
            argv.push("--user".into());
        }
        argv.extend(["--no-block", "restart", "omnigateway.service"].map(str::to_owned));
        let runner = self.run.clone();
        let (code, stderr) = tokio::task::spawn_blocking(move || runner(argv))
            .await
            .map_err(|_| ApiError::internal())?
            .map_err(|_| ApiError::internal())?;
        if code != 0 {
            let detail: String = stderr
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(200)
                .collect();
            let suffix = if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            };
            return Err(ApiError::gateway(
                ErrorCode::Internal,
                format!("systemctl restart failed with exit {code}{suffix}"),
            ));
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(env: &[(&str, &str)], container: bool) -> Lifecycle {
        Lifecycle {
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            container,
            run: Arc::new(|_| panic!("host command forbidden")),
        }
    }

    #[tokio::test]
    async fn supervision_and_stubbed_commands() {
        let none = fixture(&[], false);
        assert_eq!(
            none.describe(),
            json!({"supervisor":"none","canRestart":false,"canShutdown":true})
        );
        assert!(none.restart(false).await.is_err());
        let container = fixture(&[], true);
        assert!(container.restart(false).await.expect("container exits"));
        assert!(container.restart(true).await.is_err());
        for user in [false, true] {
            let mut lifecycle = fixture(&[("JOURNAL_STREAM", "")], true);
            if user {
                lifecycle.env.insert("MANAGERPID".into(), "".into());
            }
            assert_eq!(lifecycle.describe()["supervisor"], "systemd");
            lifecycle.run = Arc::new(move |argv| {
                let mut expected = vec!["systemctl"];
                if user {
                    expected.push("--user");
                }
                expected.extend(["--no-block", "restart", "omnigateway.service"]);
                assert_eq!(argv, expected);
                Ok((0, String::new()))
            });
            assert!(!lifecycle.restart(false).await.expect("queued job"));
            lifecycle.run = Arc::new(|_| Ok((5, " refused \nsecret second line".into())));
            let ApiError::Gateway(error) =
                lifecycle.restart(false).await.expect_err("command refusal")
            else {
                panic!("gateway error")
            };
            assert_eq!(
                error.message,
                "systemctl restart failed with exit 5: refused"
            );
        }
    }
}
