/**
 * Registration-method classification for callers of Tedix MCP resources.
 *
 * OAuth access tokens expose the authorization-server client id, but not an
 * RFC 7591 registration receipt. Tedix can still classify the three MCP
 * registration modes without a management-plane lookup:
 * - CIMD client ids are HTTPS metadata-document URLs;
 * - controlled first-party clients have known static or managed identities;
 * - any other interactive OAuth client id is the DCR compatibility cohort.
 */

/**
 * OAuth Client ID Metadata Document (CIMD) identity for the Tedix CLI. CIMD is
 * an IETF Internet-Draft and is distinct from RFC 9728 protected-resource
 * metadata.
 * One HTTPS identity works across every tenant resource without creating a
 * fresh DCR client for each login.
 */
export const TEDIX_CLI_OAUTH_CLIENT_ID =
	"https://os.tedix.dev/.well-known/oauth-client/tedix-cli.json";

/** Stable CIMD identity used for catalog-bound outbound MCP connections. */
export const TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID =
	"https://api.tedix.dev/.well-known/oauth-client/tedix-mcp.json";
export const TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI =
	"https://api.tedix.dev/oauth/mcp/callback";
export const TEDIX_CLI_OAUTH_REDIRECT_URI =
	"https://os.tedix.dev/cli/oauth/callback";

const TEDIX_CLI_RELAY_STATE_RE = /^[A-Za-z0-9_-]{1,180}$/;

export function encodeTedixCliOAuthRelayState(
	state: string,
	port: number,
): string {
	if (!TEDIX_CLI_RELAY_STATE_RE.test(state)) {
		throw new Error("Invalid OAuth state nonce");
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Invalid OAuth callback port");
	}
	return `${state}.${port}`;
}

export type McpClientRegistrationMethod = "pre_registered" | "cimd" | "dcr";

export type McpCallerAuthType =
	| "user"
	| "m2m"
	| "tedi"
	| "service"
	| "apiKey"
	| "oauth"
	| "external_agent"
	| "anonymous";

export function classifyMcpClientRegistrationMethod(input: {
	authType?: McpCallerAuthType;
	clientId?: string;
}): McpClientRegistrationMethod | undefined {
	const clientId = input.clientId?.trim();
	if (!clientId) return undefined;

	if (clientId.startsWith("https://")) return "cimd";
	if (
		clientId === TEDIX_CLI_OAUTH_CLIENT_ID ||
		input.authType === "m2m" ||
		input.authType === "tedi" ||
		input.authType === "external_agent"
	) {
		return "pre_registered";
	}
	if (input.authType === "oauth") return "dcr";
	return undefined;
}
