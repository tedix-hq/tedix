import {
	TEDIX_CLI_OAUTH_CLIENT_ID,
	TEDIX_CLI_OAUTH_REDIRECT_URI,
	TEDIX_DEVIN_OAUTH_CLIENT_ID,
	TEDIX_OPENCODE_OAUTH_CLIENT_ID,
	TEDIX_OPENCODE_OAUTH_REDIRECT_URI,
} from "@tedix/auth/oauth-client-registration";

export const TEDIX_CLI_REDIRECT_URI = TEDIX_CLI_OAUTH_REDIRECT_URI;

/**
 * Descope CIMD document for the public, PKCE-only Tedix CLI client.
 * The client id is the exact HTTPS URL serving this object. Redirects remain
 * exact and HTTPS-only. OS relays the authorization response to the CLI's
 * state-bound loopback listener; resource scopes are requested from each
 * gateway's RFC 9728 metadata and narrowed by the CLI's member/admin profile
 * selector.
 */
export const TEDIX_CLI_CLIENT_METADATA = Object.freeze({
	client_id: TEDIX_CLI_OAUTH_CLIENT_ID,
	client_name: "Tedix CLI",
	client_uri: "https://tedix.dev",
	logo_uri: "https://os.tedix.dev/images/tedi-astronaut-waving.png",
	redirect_uris: [TEDIX_CLI_REDIRECT_URI],
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
});

const CLIENT_METADATA = [
	TEDIX_CLI_CLIENT_METADATA,
	{
		client_id: TEDIX_DEVIN_OAUTH_CLIENT_ID,
		client_name: "Devin",
		client_uri: "https://devin.ai",
		redirect_uris: [
			"https://api.devin.ai/mcp/oauth/callback",
			"http://localhost:8765/callback",
		],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		scope: "mcp:apps.read mcp:work.read",
	},
	{
		client_id: TEDIX_OPENCODE_OAUTH_CLIENT_ID,
		client_name: "OpenCode",
		client_uri: "https://opencode.ai",
		redirect_uris: [TEDIX_OPENCODE_OAUTH_REDIRECT_URI],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	},
];

export function handleOAuthClientMetadata(request: Request): Response | null {
	const url = new URL(request.url);
	const metadata = CLIENT_METADATA.find(
		(client) => client.client_id === url.toString().split("?")[0],
	);
	if (!metadata) return null;
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(null, {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	}
	return new Response(
		request.method === "HEAD" ? null : JSON.stringify(metadata),
		{
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "public, max-age=300, must-revalidate",
				"X-Content-Type-Options": "nosniff",
				"X-Robots-Tag": "noindex, nofollow, noarchive",
			},
		},
	);
}
