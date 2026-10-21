/**
 * Resolve the original MCP request metadata for a registered tool callback.
 *
 * The SDK callback normally exposes `mcpReq._meta`, but the compact-session
 * direct-tool path may omit it after resolving a deferred aggregate tool. The
 * per-request ServerContext retains the original `params._meta`; merge that
 * fallback first so Tasks, elicitation, payment, and trace capabilities survive
 * deferred dispatch without allowing it to override callback-local metadata.
 */
export function resolveToolRequestMeta(
	callbackMeta: Record<string, unknown> | undefined,
	requestMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!callbackMeta && !requestMeta) return undefined;
	return { ...(requestMeta ?? {}), ...(callbackMeta ?? {}) };
}
