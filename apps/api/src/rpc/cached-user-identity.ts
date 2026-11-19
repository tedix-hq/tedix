import { createDbSession } from "@tedix/db/client";
import { readAuthContextCacheVersion } from "@tedix/db/queries/auth-context-cache";
import { resolveUserTenantIdentityContext } from "@tedix/db/queries/principal-identities";
import type { BaseContext } from "./context";
import { readCachedIdentity } from "./identity-cache";

export async function resolveCachedUserIdentity(
	context: BaseContext,
	credential: string,
	expiresAt: number,
	input: Parameters<typeof resolveUserTenantIdentityContext>[1],
) {
	if (typeof caches === "undefined" || context.env.ENVIRONMENT !== "production")
		return resolveUserTenantIdentityContext(context.db, input);
	// Ignore caller bookmarks and replica eligibility for authorization's fence and fill.
	const primary = createDbSession(context.env.DB, undefined, "first-primary");
	try {
		const result = await readCachedIdentity({
			cache: await caches.open("tedix-auth-identity-v1"),
			origin: context.url.origin,
			scope: JSON.stringify([input.organizationIdentity, input.userIdentity]),
			credential,
			expiresAt,
			readVersion: () => readAuthContextCacheVersion(primary.db),
			load: () => resolveUserTenantIdentityContext(primary.db, input),
			serialize: (value) => value && { ...value, reviewProject: undefined },
		});
		(context.serverTiming ??= []).push(
			`auth-identity-cache;desc="${result.hit ? "hit" : "miss"}"`,
		);
		if (result.hit && result.value && input.reviewProjectId) {
			const { getProjectById } = await import("@tedix/db/queries/projects");
			result.value.reviewProject = {
				id: input.reviewProjectId,
				project: await getProjectById(primary.db, input.reviewProjectId),
			};
		}
		return result.value;
	} finally {
		if (context.dbMetrics) {
			context.dbMetrics.queries += primary.metrics.queries;
			context.dbMetrics.rowsRead += primary.metrics.rowsRead;
			context.dbMetrics.rowsWritten += primary.metrics.rowsWritten;
			context.dbMetrics.withoutMeta += primary.metrics.withoutMeta;
		}
	}
}
