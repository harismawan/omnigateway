# Qoder (experimental)

Qoder uses its global browser device login. Choose **Qoder** in Accounts, open
the authorization link and approve. Polling completes automatically. Reconnect
retains the gateway-generated device identity; no local CLI credentials or real
machine information are read. The Qoder CLI binary is not required.

Models are fetched at login and refresh, not per chat. The model picker merges
public account snapshots without changing saved targets. If the first model
listing is temporarily unavailable, enter the model ID manually. Refresh retains
the last successful snapshot during transient failures. Different accounts may
have different access; pin a target to an account when necessary.

Qoder does not supply known dollar token prices here. **Price unavailable** does
not mean free: enter your own accounting rates. Subscription credits are not
dollar token prices. Quota meters remain unknown; no quota probe is implemented.

Text, reasoning, portable tools and model-supported images use the native CLI
protocol. Parallel tool arguments are buffered until the upstream stream ends
to preserve valid tool blocks. Unsupported features are recorded as degradations.
`OMNI_QODER_CLI_VERSION` overrides the default CLI profile version `1.1.82`.

## Verification limits

This integration was derived from public `@qoder-ai/qodercli` 1.1.82. Native
encoding/signing was compared with its WASM; encryption and mocked login,
refresh, discovery, streaming and collection have automated tests. **Live account
login and inference have not been verified.** Server enforcement of an UMID
machine token remains unknown. If UMID is mandatory, this is a compatibility
blocker, not a reason to read local credentials or launch the CLI silently.

PAT, service accounts, China-region endpoints, local credential import, voice and
image generation are not supported. Tokens and encrypted inference envelopes
remain in encrypted credential secrets, not public account metadata.
