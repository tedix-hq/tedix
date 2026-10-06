const OAUTH_CALLBACK_QUERY = /(\/oauth\/mcp\/callback)\?[^\s]*/g;

/** Remove provider codes and sealed state from Hono's request log line. */
export function redactRequestLogMessage(message: string): string {
	return message.replace(OAUTH_CALLBACK_QUERY, "$1?[query-redacted]");
}
