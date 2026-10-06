import {
	TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
	TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI,
} from "@tedix/auth/oauth-client-registration";

export const TEDIX_OUTBOUND_MCP_CLIENT_METADATA = Object.freeze({
	client_id: TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
	client_name: "Tedix MCP Connections",
	client_uri: "https://tedix.dev",
	redirect_uris: [TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI],
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
});

export function handleOutboundMcpClientMetadata(
	request: Request,
): Response | null {
	const url = new URL(request.url);
	if (url.toString().split("?")[0] !== TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID) {
		return null;
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(null, {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	}
	return new Response(
		request.method === "HEAD"
			? null
			: JSON.stringify(TEDIX_OUTBOUND_MCP_CLIENT_METADATA),
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
