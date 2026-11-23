export type Connection = "signed-in" | "signed-out" | "unknown";

export function opencodeConnection(output: string): Connection {
	const status = output
		.replace(/\x1b\[[0-9;]*m/g, "")
		.match(/^\s*(?:●\s+)?[✓✗⚠○]\s+tedix[ \t]+([^\r\n]+)/m)?.[1]
		?.trim();
	if (status === "connected" || status === "connected (OAuth)")
		return "signed-in";
	return /^(?:needs auth|failed:.*\b40[13]\b)/i.test(status ?? "")
		? "signed-out"
		: "unknown";
}

export function devinConnection(line: string): Connection | undefined {
	const status =
		/toolbox::tools::mcp: output_channel="MCP: tedix" MCP server 'tedix' (.*)$/.exec(
			line,
		)?.[1];
	if (status === "connected successfully") return "signed-in";
	if (!status?.startsWith("connection failed:")) return;
	return /auth(?:orization)? required|invalid_grant|\b401\b/i.test(status)
		? "signed-out"
		: "unknown";
}

export function toolConnection(
	live: Connection | undefined,
	verified: boolean,
): Connection {
	if (live === "signed-out") return live;
	return verified || live === "signed-in" ? "signed-in" : "unknown";
}
