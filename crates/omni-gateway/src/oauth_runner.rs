//! Generic bounded OAuth exchange runner shared by the connect and refresh
//! hosts. Providers describe requests with pure builders; this runner performs
//! them under host-owned limits: a request cap, an origin check and a
//! per-request deadline. Modeled on `connect::AntigravityExchange`, whose
//! pinned single-provider path stays as it is.
use omni_ir::error::{ErrorCode, GatewayError};
use omni_providers::{
    http::{HttpClient, HttpRequest},
    oauth::AuthRequest,
};

/// The origins a provider's manifest declares. A fixed allowlist covers most
/// providers; a validator covers hosts published through discovery (grok).
pub(crate) enum Origins<'a> {
    Allowlist(&'a [&'a str]),
    /// Hosts published through discovery (grok), checked per request.
    Validator(&'a (dyn Fn(&url::Url) -> bool + Sync)),
}

pub(crate) struct ExchangeConfig<'a> {
    /// Provider id, used only in host-authored error strings.
    pub provider: &'a str,
    /// Step name in those strings: "exchange", "refresh", "begin".
    pub step: &'a str,
    pub max_requests: usize,
    pub origins: Origins<'a>,
}

pub(crate) struct ExchangeRunner<'a> {
    http: &'a dyn HttpClient,
    config: ExchangeConfig<'a>,
    sent: usize,
}

impl<'a> ExchangeRunner<'a> {
    pub(crate) fn new(http: &'a dyn HttpClient, config: ExchangeConfig<'a>) -> Self {
        Self {
            http,
            config,
            sent: 0,
        }
    }

    fn failure(&self, what: &str) -> GatewayError {
        // UPSTREAM, never AUTH: a broken flow or transport must not read as
        // the provider repudiating a credential.
        GatewayError::new(
            ErrorCode::Upstream,
            format!(
                "{} oauth {} {}",
                self.config.provider, self.config.step, what
            ),
        )
    }

    pub(crate) async fn send(
        &mut self,
        request: AuthRequest,
        seconds: u64,
    ) -> Result<(u16, String), GatewayError> {
        self.sent += 1;
        if self.sent > self.config.max_requests {
            return Err(self.failure(&format!(
                "asked for more than {} requests",
                self.config.max_requests
            )));
        }
        let url = url::Url::parse(&request.url).map_err(|_| self.failure("threw"))?;
        let allowed = match &self.config.origins {
            Origins::Allowlist(origins) => {
                origins.contains(&url.origin().ascii_serialization().as_str())
            }
            Origins::Validator(check) => check(&url),
        };
        if !allowed {
            return Err(
                self.failure("described a request to an origin its manifest does not declare")
            );
        }
        tokio::time::timeout(std::time::Duration::from_secs(seconds.min(30)), async {
            let response = self
                .http
                .send(HttpRequest {
                    provider: self.config.provider.into(),
                    url: request.url,
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    body_encoding: None,
                    request_id: None,
                })
                .await?;
            Ok::<_, omni_providers::http::HttpError>((response.status, response.body.text().await?))
        })
        .await
        .map_err(|_| self.failure("threw"))?
        .map_err(|_| self.failure("threw"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omni_providers::http::{Headers, HttpError, HttpResponse, ResponseBody};

    struct Scripted {
        status: u16,
        body: &'static str,
    }
    impl HttpClient for Scripted {
        fn send(
            &self,
            _: HttpRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
        > {
            Box::pin(async {
                Ok(HttpResponse {
                    status: self.status,
                    headers: Headers::new(),
                    body: ResponseBody::from_bytes(self.body),
                })
            })
        }
    }

    fn request(url: &str) -> AuthRequest {
        AuthRequest {
            url: url.into(),
            method: "POST".into(),
            headers: Vec::new(),
            body: "{}".into(),
        }
    }

    fn runner<'a>(
        http: &'a dyn HttpClient,
        max_requests: usize,
        origins: Origins<'a>,
    ) -> ExchangeRunner<'a> {
        ExchangeRunner::new(
            http,
            ExchangeConfig {
                provider: "fixture",
                step: "exchange",
                max_requests,
                origins,
            },
        )
    }

    #[tokio::test]
    async fn cap_and_origin_errors_mirror_the_pinned_runner() {
        let http = Scripted {
            status: 200,
            body: "{}",
        };
        let mut bounded = runner(&http, 1, Origins::Allowlist(&["https://good.test"]));
        assert_eq!(
            bounded
                .send(request("https://good.test/token"), 30)
                .await
                .expect("first"),
            (200, "{}".into())
        );
        let capped = bounded
            .send(request("https://good.test/token"), 30)
            .await
            .expect_err("cap");
        assert_eq!(capped.code, ErrorCode::Upstream);
        assert_eq!(
            capped.message,
            "fixture oauth exchange asked for more than 1 requests"
        );
        let mut stray = runner(&http, 4, Origins::Allowlist(&["https://good.test"]));
        assert_eq!(
            stray
                .send(request("https://evil.test/token"), 30)
                .await
                .expect_err("origin")
                .message,
            "fixture oauth exchange described a request to an origin its manifest does not declare"
        );
        assert_eq!(
            stray
                .send(request("not a url"), 30)
                .await
                .expect_err("parse")
                .message,
            "fixture oauth exchange threw"
        );
    }

    #[tokio::test]
    async fn validator_origins_and_refresh_step_strings() {
        let http = Scripted {
            status: 200,
            body: "{}",
        };
        let check = |url: &url::Url| {
            url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|h| h == "x.test" || h.ends_with(".x.test"))
        };
        let mut exchange = ExchangeRunner::new(
            &http,
            ExchangeConfig {
                provider: "fixture",
                step: "refresh",
                max_requests: 2,
                origins: Origins::Validator(&check),
            },
        );
        assert!(
            exchange
                .send(request("https://api.x.test/token"), 30)
                .await
                .is_ok()
        );
        assert_eq!(
            exchange
                .send(request("https://evilx.test/token"), 30)
                .await
                .expect_err("suffix")
                .message,
            "fixture oauth refresh described a request to an origin its manifest does not declare"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn requested_deadline_is_capped_at_thirty_seconds() {
        struct Hanging;
        impl HttpClient for Hanging {
            fn send(
                &self,
                _: HttpRequest,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
            > {
                Box::pin(std::future::pending())
            }
        }
        let mut exchange = runner(&Hanging, 4, Origins::Allowlist(&["https://good.test"]));
        let started = tokio::time::Instant::now();
        let error = exchange
            .send(request("https://good.test/token"), 120)
            .await
            .expect_err("timeout");
        assert_eq!(error.message, "fixture oauth exchange threw");
        assert_eq!(
            started.elapsed(),
            std::time::Duration::from_secs(30),
            "the host ceiling, not the requested deadline"
        );
    }
}
