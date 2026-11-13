export const CONFIG_DIAGNOSTICS = [
  "OMNI_ENCRYPTION_KEY must be set to at least ",
  'OMNI_PORT must be an integer between 1 and 65535, got "',
  "OMNI_CLUSTER_MODE=true needs OMNI_DATABASE_URL to be a postgres:// URL",
  "OMNI_CLUSTER_MODE=true needs OMNI_REDIS_URL",
  "OMNI_DATABASE_URL and OMNI_REDIS_URL are cluster-mode settings; set OMNI_CLUSTER_MODE=true or unset them",
  'OMNI_METRICS_MAX_SERIES must be a positive integer, got "',
  'OMNI_TRACE_SAMPLE must be between 0 and 1, got "',
];
