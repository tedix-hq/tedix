export type Connection = "signed-in" | "signed-out" | "unknown";

export function opencodeConnection(output: string): Connection {
	const status = output
		.replace(/\x1b\[[0-9;]*m/g, "")
		.match(/^\s*(?:●\s+)?[✓✗⚠○]\s+tedix[ \t]+([^\r\n]+)/m)?.[1]
		?.trim();
	if (status === "connected") return "signed-in";
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
	reported: unknown,
	remembered: boolean,
): Connection {
	// A tool that reports its state must not be masked by an earlier sign-in.
	if (live === "signed-out" || reported === false) return "signed-out";
	if (live !== undefined) return live;
	if (typeof reported === "boolean")
		return reported ? "signed-in" : "signed-out";
	return remembered ? "signed-in" : "unknown";
}
