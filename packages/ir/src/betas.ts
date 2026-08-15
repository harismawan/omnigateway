/**
 * Anthropic beta names the gateway itself reasons about.
 *
 * A beta the gateway has no opinion on rides through untouched — the client
 * asked for it and `vendor` already carries the field it authorises. This file
 * is only for the ones where forwarding blindly is wrong.
 */

/**
 * The 1M-context beta.
 *
 * Claude Code emits this whenever the operator typed `[1m]` after a model name.
 * The suffix never reaches the wire; the header always does. Forwarding it to a
 * model that does not have a 1M window is an upstream 400 on a request the
 * client believed was fine, and forwarding it to a provider with no beta
 * mechanism at all loses it silently while the client goes on filling a
 * megabyte of context against a much smaller cap. Either way the decision
 * belongs to the resolved target, not to the client.
 */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** The window a target must hold for {@link CONTEXT_1M_BETA} to mean anything. */
export const CONTEXT_1M_TOKENS = 1_000_000;
