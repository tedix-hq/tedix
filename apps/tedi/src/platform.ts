/**
 * Platform URL and origin helpers for the tedi runtime.
 *
 * Keep environment routing in one place so runtime proxying, Worker env and
 * MCP auto-connect seeding stay aligned.
 */

export function getPlatformDomain(env: string): string {
	switch (String(env || "")) {
		case "production":
			return "tedix.dev";
		default:
			return "tedix.tech";
	}
}

export function buildApiBaseUrl(platformDomain: string): string {
	return `https://api.${platformDomain}`;
}

export function buildOsBaseUrl(platformDomain: string): string {
	return `https://os.${platformDomain}`;
}

export function buildMcpBaseUrl(platformDomain: string): string {
	return `https://mcp.${platformDomain}`;
}

export function buildRuntimeBaseUrl(
	slug: string,
	platformDomain: string,
): string {
	return `https://${slug}.tedi.${platformDomain}`;
}
