# Rust slice1 allocator launch policy

Launch with `sh /absolute/path/scripts/run-rust-gateway.sh`; set
`OMNI_RUST_BINARY` for an installed binary. The launcher defaults
`MIMALLOC_PURGE_DELAY=1` before exec, preserving explicit operator overrides.
Equivalent service configuration: `Environment=MIMALLOC_PURGE_DELAY=1`.
The bare Rust binary still uses mimalloc's default10ms policy unless configured.
Measurements with this launcher are deployment-policy measurements, not claims
about an unconfigured binary. No workload or rate settings change.

Mimalloc v2 delays freeing resident spans until allocator activity revisits
scheduled purge work. Burst traffic followed by idle can leave free pages
resident beyond the recovery target. Observed workers/Finishers and pending
writer work reached zero, configured limiter/key populations stayed fixed,
while anonymous RSS persisted. Reducing purge delay to1ms returned more pages
during the tail of normal traffic without forced idle GC or periodic purge.

Targeted uncapped same-shape measurements: default10ms many-chunks1.358ms/req;
1ms1.370ms/req; immediate purge0ms1.500ms/req. Cancellation1ms early delta
+7.875MiB at10s versus default observed~+20–29MiB. These are diagnostic samples,
not final acceptance. Immediate purge was rejected for its higher CPU cost.
No blanket leak-free claim: counters cover selected owners, not all heap blocks.
Full-run RSS and CPU must pass together under the declared deployment policy.
