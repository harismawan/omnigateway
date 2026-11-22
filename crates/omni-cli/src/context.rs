use omni_control::config::{Config, load_config, process_env};
use omni_ir::js::trim;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

fn absolute(base: &Path, value: &str) -> PathBuf {
    let joined = base.join(value);
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            p => out.push(p.as_os_str()),
        }
    }
    out
}
/// `createContext`: installation root, database path and deferred config.
/// Resolving prints the ambient-database warning, as TS does before a command
/// runs; opening the store is a separate, later step.
pub struct Context {
    pub root_source: &'static str,
    pub warnings: Vec<String>,
    pub env: HashMap<String, String>,
    pub root: PathBuf,
    pub path: PathBuf,
    pub(crate) config: Result<Config, omni_control::config::ConfigError>,
}

pub fn open(flags: &HashMap<String, String>) -> Result<omni_store::SqliteStore, String> {
    resolve(flags)?.open()
}

pub fn resolve(flags: &HashMap<String, String>) -> Result<Context, String> {
    let mut env = process_env();
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let flag_root = flags.get("root").filter(|s| !s.is_empty());
    let root_source = if flag_root.is_some() {
        "flag"
    } else if env.get("OMNI_ROOT").is_some_and(|s| !s.is_empty()) {
        "env"
    } else if [".env", "omnigateway.db", "apps/gateway/src/index.ts"]
        .iter()
        .any(|p| cwd.join(p).exists())
    {
        "cwd"
    } else {
        "default"
    };
    let root = if let Some(r) = flag_root.or_else(|| env.get("OMNI_ROOT").filter(|s| !s.is_empty()))
    {
        absolute(&cwd, r)
    } else if [".env", "omnigateway.db", "apps/gateway/src/index.ts"]
        .iter()
        .any(|p| cwd.join(p).exists())
    {
        cwd
    } else {
        std::env::home_dir()
            .ok_or("could not resolve account home directory")?
            .join(".config/omnigateway")
    };
    let mut file_env = HashMap::new();
    let file = root.join(".env");
    if file.exists() {
        for raw in std::fs::read_to_string(file)
            .map_err(|e| e.to_string())?
            .split('\n')
        {
            let line = trim(raw);
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let line = trim(line.strip_prefix("export ").unwrap_or(line));
            if let Some((key, value)) = line.split_once('=') {
                if key.is_empty() {
                    continue;
                }
                let mut value = trim(value);
                if value.len() >= 2
                    && (value.starts_with('"') && value.ends_with('"')
                        || value.starts_with('\'') && value.ends_with('\''))
                {
                    value = &value[1..value.len() - 1];
                }
                file_env.insert(trim(key).to_owned(), value.to_owned());
            }
        }
    }
    let db_flag = flags.get("db").filter(|s| !trim(s).is_empty());
    let suppressed =
        if flag_root.is_some() && db_flag.is_none() && !file_env.contains_key("OMNI_DB_PATH") {
            env.get("OMNI_DB_PATH")
                .map(|s| trim(s).to_owned())
                .filter(|s| !s.is_empty())
        } else {
            None
        };
    env.extend(file_env);
    if suppressed.is_some() {
        env.remove("OMNI_DB_PATH");
    }
    let config = load_config(&env, omni_store::rollup::host_day_offset_minutes);
    let path = absolute(
        &root,
        db_flag
            .map(String::as_str)
            .or_else(|| config.as_ref().ok().map(|c| c.database_path.as_str()))
            .unwrap_or("omnigateway.db"),
    );
    let mut warnings = Vec::new();
    if let Some(old) = suppressed {
        let warning = format!(
            "ignoring OMNI_DB_PATH={old} from the environment because --root was given; using {}",
            path.display()
        );
        eprintln!("{warning}");
        warnings.push(warning);
    }
    Ok(Context {
        root_source,
        warnings,
        root,
        path,
        config,
        env,
    })
}

impl Context {
    pub fn encryption_key(&self) -> Result<String, String> {
        self.config
            .as_ref()
            .map(|c| c.encryption_key.clone())
            .map_err(|e| e.to_string())
    }
    pub fn base_url(&self) -> Result<String, String> {
        self.config
            .as_ref()
            .map(|c| c.base_url.clone())
            .map_err(|e| e.to_string())
    }
    pub fn open(self) -> Result<omni_store::SqliteStore, String> {
        self.open_with(false)
    }
    pub fn open_migrate(self) -> Result<omni_store::SqliteStore, String> {
        self.open_with(true)
    }
    fn open_with(self, migrate: bool) -> Result<omni_store::SqliteStore, String> {
        let Config {
            day_offset_minutes, ..
        } = self.config.map_err(|e| e.to_string())?;
        // No encrypted fields are read. Keep config validation, defer the existing
        // crypto KDF until a future command actually needs credentials.
        omni_store::SqliteStore::open(self.path, day_offset_minutes).map_err(|e| match &e {
            omni_store::StoreError::Sqlite(sql)
                if sql.sqlite_error_code() == Some(rusqlite::ErrorCode::CannotOpen) =>
            {
                "unable to open database file".into()
            }
            _ if migrate => migrate_error(e),
            _ => e.to_string(),
        })
    }
}

pub(crate) fn migrate_error(error: omni_store::StoreError) -> String {
    match error {
        omni_store::StoreError::Migration { source, .. } => migrate_error(*source),
        omni_store::StoreError::Sqlite(rusqlite::Error::SqlInputError { msg, .. }) => msg,
        error => error.to_string(),
    }
}
