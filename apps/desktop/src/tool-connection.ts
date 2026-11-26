import type { McpAuthorization } from "@tedix/api-contract/schemas/mcp-grant";
export type Connection = "signed-in" | "signed-out" | "unknown";

export function checkedTedixAccount(output: string): string | undefined {
	return /, as ([^\s,]+)\.\s*$/m.exec(output)?.[1];
}

/** Only compare emails; an opaque ID cannot be compared to the app's email. */
export function tedixAccountSummary(
	account: string | undefined,
	appEmail: string,
): { text: string; mismatch: boolean } {
	if (!account) return { text: "Tedix account: not checked", mismatch: false };
	const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const mismatch =
		email.test(account) &&
		email.test(appEmail) &&
		account.toLowerCase() !== appEmail.toLowerCase();
	return {
		text: `Tedix account last checked: ${account}${mismatch ? " (different from this app)" : ""}`,
		mismatch,
	};
}

export type VerificationTarget = {
	command: string;
	version: string;
	user: string;
	org: string;
};
export type VerifiedConnection = VerificationTarget & { at: number };

export function recentConnectionCheck(
	entry: VerifiedConnection | undefined,
	target: VerificationTarget | undefined,
	now: number,
): boolean {
	if (
		!entry ||
		!target ||
		entry.command !== target.command ||
		entry.version !== target.version ||
		entry.user !== target.user ||
		entry.org !== target.org
	)
		return false;
	const age = now - entry.at;
	return age >= 0 && age < 24 * 60 * 60_000;
}

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
	// Tedix refused the sign-in Devin stored; only a new sign-in gets past that.
	if (/Streamable HTTP returned 40[13] for 'tedix'/.test(line))
		return "signed-out";
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

export type AgentGrant = Pick<
	McpAuthorization,
	"status" | "providerStatus" | "expiresAt" | "lastSuccessfulCallAt"
>;

/** A client name is not an installation id; never pick one of several matches. */
export function agentGrant(
	id: string,
	grants: McpAuthorization[],
	clientIds?: readonly string[],
): AgentGrant | undefined {
	const names: Record<string, RegExp> = {
		claude: /^claude[ -]code$/i,
		codex: /^codex(?: cli)?$/i,
		devin: /^devin$/i,
		opencode: /^opencode$/i,
	};
	const named = grants.filter((grant) =>
		names[id]?.test(grant.clientName ?? ""),
	);
	// This Mac's stored token names its OAuth client id, so several installs of
	// one agent stay distinguishable. When the local read cannot see this
	// install (a Keychain-only store, a second app sign-in), keep the old
	// unambiguous name match instead of reporting nothing.
	if (clientIds?.length) {
		const own = named.filter((grant) => clientIds.includes(grant.clientId));
		if (own.length > 0) return own.length === 1 ? own[0] : undefined;
	}
	return named.length === 1 ? named[0] : undefined;
}

export function duplicateClaudeConnection(output: string): boolean {
	const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
	return lines.some(
		(line) =>
			/claude\.ai/i.test(line) &&
			/https:\/\/connect\.mcp\.tedix\.dev\/mcp(?:[\s)]|$)/.test(line),
	);
}

export type ConnectionProblem = {
	text: string;
	action: "signin" | "account" | "remove" | "check";
};
export function agentConnectionProblem(input: {
	connection: Connection | "checking";
	mismatch: boolean;
	duplicate?: boolean;
	grant?: AgentGrant;
	grantUnavailable?: boolean;
	now: number;
}): ConnectionProblem | undefined {
	if (input.mismatch)
		return {
			text: "This agent is signed in to a different Tedix account.",
			action: "account",
		};
	if (input.duplicate)
		return {
			text: "Two Tedix connections: the Claude connector can replace the plugin. Check connection uses the plugin. Remove the extra Tedix connector in Claude to use the plugin in your chats too.",
			action: "remove",
		};
	const grant = input.grant;
	const expiry = grant?.expiresAt ? Date.parse(grant.expiresAt) : NaN;
	if (
		input.connection === "signed-out" ||
		grant?.status === "revoked" ||
		grant?.providerStatus === "missing" ||
		expiry <= input.now
	)
		return {
			text: "Your Tedix sign-in has ended. Sign in again before running tasks.",
			action: "signin",
		};
	if (expiry <= input.now + 10 * 60_000)
		return {
			text: "Your Tedix sign-in ends within 10 minutes.",
			action: "signin",
		};
	if (
		input.grantUnavailable ||
		grant?.providerStatus === "unavailable" ||
		grant?.providerStatus === "not_checked"
	)
		return {
			text: "Tedix couldn’t check this sign-in.",
			action: "check",
		};
	return undefined;
}
