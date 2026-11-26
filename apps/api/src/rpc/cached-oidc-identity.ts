import { isD1CoreStore } from "@tedix/db/core-store/scope";
import { createDbSession } from "@tedix/db/client";
import { readAuthContextCacheVersion } from "@tedix/db/queries/auth-context-cache";
import { resolveOidcSessionContext } from "@tedix/db/queries/oidc-sessions";
import type { BaseContext } from "./context";
import { IDENTITY_CACHE_TTL_MS, readCachedIdentity } from "./identity-cache";

export async function resolveCachedOidcIdentity(
	context: BaseContext,
	credentialDigest: string,
) {
	const now = () => Math.floor(Date.now() / 1000);
	if (typeof caches === "undefined" || context.env.ENVIRONMENT !== "production")
		return resolveOidcSessionContext(context.db, credentialDigest, now());
	const primary = isD1CoreStore(context.env)
		? createDbSession(context.env.DB, undefined, "first-primary")
		: { db: context.db };
	try {
		const result = await readCachedIdentity({
			cache: await caches.open("tedix-auth-identity-v1"),
			origin: context.url.origin,
			scope: JSON.stringify(["oidc", context.headers.get("X-Tedix-Tenant-Id")]),
			credential: credentialDigest,
			expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
			valueExpiresAt: (value) => (value?.session.expiresAt ?? 0) * 1000,
			readVersion: () => readAuthContextCacheVersion(primary.db),
			load: () =>
				resolveOidcSessionContext(primary.db, credentialDigest, now()),
		});
		(context.serverTiming ??= []).push(
			`auth-identity-cache;desc="${result.hit ? "hit" : "miss"}"`,
		);
		return result.value;
	} finally {
		if (context.dbMetrics && "metrics" in primary) {
			context.dbMetrics.queries += primary.metrics.queries;
			context.dbMetrics.rowsRead += primary.metrics.rowsRead;
			context.dbMetrics.rowsWritten += primary.metrics.rowsWritten;
			context.dbMetrics.withoutMeta += primary.metrics.withoutMeta;
		}
	}
}
