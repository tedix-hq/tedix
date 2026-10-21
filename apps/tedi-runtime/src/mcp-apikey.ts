/**
 * Isolate MCP — `sk_` API-key validator.
 *
 * Validates the `token.startsWith("sk_")` branch for an org-scoped `sk_` key
 * whose organization matches the tedi's organization on the `/mcp` endpoint.
 *
 * Wired into `createMcpAuthMiddleware({ apiKeyValidator })` in `index.ts`. The
 * shared middleware invokes this with the raw `X-API-Key` header value and
 * expects an `McpAuthContext` on success or `null` on any failure.
 *
 * The package-owned runtime bootstrap facade keeps SQL out of this Worker
 * without importing Drizzle's peer-specialized runtime graph. Parsing and
 * hashing remain local to avoid importing schema modules for this hot path.
 */
import { isIPv6 } from "node:net";
import { logTediMcpFailure } from "./mcp-failure-log";
import {
	findTediRuntimeApiKeyByHash,
	recordTediRuntimeApiKeyUsage,
} from "@tedix/db/queries/tedi-runtime-bootstrap";
import { TEDI_MCP_SCOPES } from "@tedix/mcp-shared/auth/scopes";
import type { McpAuthContext } from "@tedix/mcp-shared/auth/types";

interface ApiKeyValidatorTedi {
	/** Internal organizations.id UUID this tedi belongs to. */
	orgId: string | null;
}

/**
 * SHA-256 hex of the raw key — mirrors `hashApiKey` from
 * `@tedix/db/schema/api-keys` (inlined to avoid importing the Drizzle graph).
 */
async function hashApiKey(key: string): Promise<string> {
	const data = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function ipToInt(ip: string): number | null {
	const octets = ip.split(".");
	if (octets.length !== 4) return null;
	let result = 0;
	for (const octet of octets) {
		if (!/^\d+$/.test(octet)) return null;
		const num = Number(octet);
		if (num > 255) return null;
		result = (result << 8) | num;
	}
	return result >>> 0;
}

function matchesIpOrCidr(clientIp: string, pattern: string): boolean {
	const clientInt = ipToInt(clientIp);
	if (!pattern.includes("/")) {
		// Preserve exact IPv6 literals without adding IPv6 CIDR matching.
		return clientIp === pattern && (clientInt !== null || isIPv6(clientIp));
	}
	if (clientInt === null) return false;

	const parts = pattern.split("/");
	const [subnet, prefixStr] = parts;
	if (parts.length !== 2 || !subnet || !prefixStr) return false;
	if (!/^\d+$/.test(prefixStr)) return false;
	const prefix = Number(prefixStr);
	if (prefix > 32) return false;

	const subnetInt = ipToInt(subnet);
	if (subnetInt === null) return false;

	const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
	return (clientInt & mask) === (subnetInt & mask);
}

/**
 * Only SQL null and a genuine empty array mean unrestricted access.
 * Invalid configured entries invalidate the entire restriction, even if a
 * different entry would match. The column is JSON-mode text in Drizzle.
 */
function parseIpAllowlist(raw: string | null): string[] | null {
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!Array.isArray(parsed) ||
			!parsed.every(
				(ip) =>
					typeof ip === "string" && matchesIpOrCidr(ip.split("/")[0] ?? "", ip),
			)
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Build an `apiKeyValidator` closure for `createMcpAuthMiddleware`.
 *
 * @param db - The isolate `DB` (D1) binding — used via the raw prepared-
 *   statement API (NOT Drizzle; see the file header note).
 * @param tedi - Resolved tedi (for the org-match check).
 * @param request - The inbound request (for IP allowlist + usage telemetry).
 */
export function createIsolateApiKeyValidator(
	db: D1Database,
	tedi: ApiKeyValidatorTedi,
	request: Request,
): (key: string) => Promise<McpAuthContext | null> {
	return async (key: string): Promise<McpAuthContext | null> => {
		if (!key.startsWith("sk_")) return null;

		try {
			const keyHash = await hashApiKey(key);
			const apiKey = await findTediRuntimeApiKeyByHash(
				db,
				keyHash,
				new Date().toISOString(),
			);

			if (!apiKey) return null;
			if (apiKey.status !== "active") return null;
			if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
				return null;
			}

			// Org match — critical. Reject keys from a different organization.
			if (!tedi.orgId || apiKey.organizationId !== tedi.orgId) {
				return null;
			}

			// Optional IP allowlist enforcement (CIDR or exact).
			const allowedIps = parseIpAllowlist(apiKey.ipAllowlist);
			if (allowedIps === null) return null;
			if (allowedIps.length > 0) {
				const clientIp =
					request.headers.get("CF-Connecting-IP") ??
					request.headers.get("X-Forwarded-For");
				if (
					!clientIp ||
					!allowedIps.some((ip) => matchesIpOrCidr(clientIp, ip))
				) {
					return null;
				}
			}

			// Fire-and-forget usage telemetry — never block auth on it.
			void recordTediRuntimeApiKeyUsage(
				db,
				apiKey.id,
				new Date().toISOString(),
			).catch((error) => {
				logTediMcpFailure("tedi.mcp.api_key_usage_failed", error);
			});

			// An org-scoped `sk_` key is a trusted org-level credential: grant the
			// canonical tedi MCP scope set. `orgId` here is the internal
			// organizations.id UUID (matching apiKey.organizationId), NOT a Descope
			// tenant id — the downstream org guard in index.ts only compares orgId
			// for authMethod === "jwt", so this does not collide with that check.
			return {
				authenticated: true,
				authMethod: "api-key",
				orgId: apiKey.organizationId,
				scopes: [...TEDI_MCP_SCOPES],
			};
		} catch (error) {
			logTediMcpFailure("tedi.mcp.api_key_validation_failed", error);
			return null;
		}
	};
}
