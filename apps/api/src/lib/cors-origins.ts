/**
 * CORS origin resolution for the API worker.
 *
 * First-party Tedix domains are always allowed. A self-hosted installation
 * runs its UI surfaces on customer-owned domains the hardcoded list can never
 * know, so origins derived from the installation's own configured surface URLs
 * (OS_URL, MCP_UI_URL, MCP_URL, TEDI_DEV_BASE_URL) are allowed too,
 * plus any origins listed in the optional CORS_ALLOWED_ORIGINS csv var for
 * browser surfaces the API has no URL var for. Found live on the OSS
 * clean-account certification: an OS installation on a non-first-party origin
 * got no access-control-allow-origin and every oRPC call died in the browser.
 *
 * The matching itself is the shared `@tedix/worker-kit/cors` policy engine;
 * this module only builds the API's policy. Note worker-kit also rejects
 * non-normalized origins (`url.origin !== origin`): a serialized origin that
 * differs only by a trailing slash, an explicit default port or host case is
 * denied rather than echoed back as received.
 */

import {
	type CorsOriginPolicy,
	resolveCorsOrigin as resolveOriginAgainstPolicy,
} from "@tedix/worker-kit/cors";

const FIRST_PARTY_ORIGINS = new Set([
	// Production (tedix.dev)
	"https://api.tedix.dev",
	"https://mcp.tedix.dev",
	"https://mcp-ui.tedix.dev",
	"https://os.tedix.dev",
	"https://gateway.tedix.dev",
	"https://tedix.dev",
	// Local (tedix.tech dev tunnel; apex tedix.tech is an external site)
	"https://api.tedix.tech",
	"https://mcp.tedix.tech",
	"https://mcp-ui.tedix.tech",
	"https://os.tedix.tech",
	"https://gateway.tedix.tech",
	"https://landing.tedix.tech",
	// Local development
	"http://localhost:3000",
	"http://localhost:3001",
	"http://localhost:3003",
	"http://localhost:3006",
	"http://localhost:3010",
	"http://localhost:8787",
]);

export interface CorsOriginEnv {
	OS_URL?: string;
	MCP_UI_URL?: string;
	MCP_URL?: string;
	TEDI_DEV_BASE_URL?: string;
	CORS_ALLOWED_ORIGINS?: string;
}

function originOf(value: string | undefined): string | null {
	if (!value) return null;
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

/** Origins this installation's own configuration declares. */
export function installationOrigins(env: CorsOriginEnv): Set<string> {
	const origins = new Set<string>();
	for (const value of [
		env.OS_URL,
		env.MCP_UI_URL,
		env.MCP_URL,
		env.TEDI_DEV_BASE_URL,
	]) {
		const origin = originOf(value);
		if (origin) origins.add(origin);
	}
	for (const entry of (env.CORS_ALLOWED_ORIGINS ?? "").split(",")) {
		const origin = originOf(entry.trim());
		if (origin) origins.add(origin);
	}
	return origins;
}

/**
 * The API's origin policy. HTTPS subdomain suffixes cover the two cases that
 * cannot be enumerated ahead of time: dev tunnel origins (any *.tedix.tech
 * subdomain — NOT the apex, tedix.tech itself is an external site) and Tedix
 * OS tenant origins ({slug}.os.tedix.dev is one multi-tenant Worker). CORS
 * here is not authorization — every request still authenticates and
 * re-derives its organization server-side. allowLocalhost stays false:
 * the local dev origins are exact entries in FIRST_PARTY_ORIGINS.
 */
function corsOriginPolicy(env: CorsOriginEnv): CorsOriginPolicy {
	return {
		exactOrigins: new Set([
			...FIRST_PARTY_ORIGINS,
			...installationOrigins(env),
		]),
		httpsSubdomainSuffixes: ["tedix.tech", "os.tedix.dev"],
		allowLocalhost: false,
	};
}

/** Full CORS decision: return the origin to echo, or undefined to deny. */
export function resolveCorsOrigin(
	requestOrigin: string,
	env: CorsOriginEnv,
): string | undefined {
	return (
		resolveOriginAgainstPolicy(requestOrigin, corsOriginPolicy(env)) ??
		undefined
	);
}
