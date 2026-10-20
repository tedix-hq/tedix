import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { ManagedConnection, BoundedPriorDiscovery } from "./connections";

// A legacy verdict can silently mask a server upgrade, so prior discovery is
// deliberately process-local and short-lived even when credentials are stable.
export const SDK_PRIOR_DISCOVERY_TTL_MS = 60_000;

export const DISCOVERY_NEGOTIATION_TTL_MS = 60_000;

export const MAX_DISCOVERY_NEGOTIATION_TTL_MS = 5 * 60_000;

export const TRANSIENT_DISCOVERY_NEGOTIATION_TTL_MS = 5_000;

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export async function discoveryDigest(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalJson(value)),
	);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

export function discoveryEndpoint(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "invalid-mcp-endpoint";
	}
}

export function priorDiscoveryFromConnection(
	connection: ManagedConnection,
	now = Date.now(),
): BoundedPriorDiscovery | undefined {
	if (connection.mode !== "sdk" || now >= connection.priorDiscoveryExpiresAt) {
		return undefined;
	}
	const discover = connection.client.getDiscoverResult();
	if (!discover) return undefined;
	return {
		prior: { kind: "modern", discover },
		authContextKey: connection.authContextKey,
		expiresAt: connection.priorDiscoveryExpiresAt,
	};
}

export async function requestHeadersIdentity(
	headers: Record<string, string>,
): Promise<string> {
	const canonical = Object.entries(headers)
		.map(([name, value]) => [name.toLowerCase(), value] as const)
		.sort(([left], [right]) => left.localeCompare(right));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(canonical)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Normalize a declared `capabilities.extensions` map (from `server/discover`
 * or a legacy `initialize` result) to plain per-extension records.
 */
export function normalizeDeclaredExtensions(
	value: unknown,
): Record<string, Record<string, unknown>> {
	if (!isRecord(value)) return {};
	const extensions: Record<string, Record<string, unknown>> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isRecord(entry)) extensions[key] = entry;
	}
	return extensions;
}
