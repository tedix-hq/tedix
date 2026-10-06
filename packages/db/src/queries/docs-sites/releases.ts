import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type DocsRelease,
	type DocsSite,
	docsReleases,
	docsSites,
} from "../../schema/docs-sites";
import { getDocsBuild } from "./builds";
import { getDocsSiteById } from "./sites";

interface DocsActorParams {
	type: string;
	id: string;
	sessionId: string | null;
}

export interface ActivateDocsBuildParams {
	buildId: string;
	orgSlug: string;
	siteId: string;
	action: DocsRelease["action"];
	actor: DocsActorParams;
}

export interface ActivateDocsBuildResult {
	site: DocsSite;
	release: DocsRelease;
}

export function listDocsReleases(
	db: DbQueryClient,
	siteId: string,
): Promise<DocsRelease[]> {
	return db
		.select()
		.from(docsReleases)
		.where(eq(docsReleases.siteId, siteId))
		.orderBy(desc(docsReleases.createdAt))
		.limit(50);
}

export async function activateDocsBuild(
	db: DbQueryClient,
	params: ActivateDocsBuildParams,
): Promise<ActivateDocsBuildResult> {
	const site = await getDocsSiteById(db, params.siteId);
	if (!site || site.orgSlug !== params.orgSlug) {
		throw new Error("Documentation site not found");
	}
	if (site.activeBuildId === params.buildId) {
		throw new Error("Documentation build is already active");
	}
	const build = await getDocsBuild(db, params.buildId);
	if (!build || build.siteId !== params.siteId || build.status !== "complete") {
		throw new Error("Completed documentation build not found");
	}

	const releaseId = crypto.randomUUID();
	const activateSite = db
		.update(docsSites)
		.set({
			activeBuildId: params.buildId,
			updatedAt: sql`(datetime('now'))`,
		})
		.where(
			and(
				eq(docsSites.id, params.siteId),
				eq(docsSites.orgSlug, params.orgSlug),
				sql`${docsSites.activeBuildId} is ${site.activeBuildId}`,
			),
		);
	const recordRelease = db
		.insert(docsReleases)
		.select(
			db
				.select({
					id: sql<string>`${releaseId}`.as("id"),
					siteId: sql<string>`${params.siteId}`.as("site_id"),
					buildId: sql<string>`${params.buildId}`.as("build_id"),
					previousBuildId: sql<string | null>`${site.activeBuildId}`.as(
						"previous_build_id",
					),
					action: sql<DocsRelease["action"]>`${params.action}`.as("action"),
					actorType: sql<string>`${params.actor.type}`.as("actor_type"),
					actorId: sql<string>`${params.actor.id}`.as("actor_id"),
					actorSessionId: sql<string | null>`${params.actor.sessionId}`.as(
						"actor_session_id",
					),
					createdAt: sql<string>`datetime('now')`.as("created_at"),
				})
				.from(docsSites)
				.where(and(eq(docsSites.id, params.siteId), sql`changes() = 1`)),
		)
		.returning();

	const [, releaseRows] = await db.batch([activateSite, recordRelease]);
	const release = releaseRows[0];
	if (!release) {
		throw new Error("Documentation release lost a concurrent activation race");
	}

	const activated = await getDocsSiteById(db, params.siteId);
	if (!activated || activated.activeBuildId !== params.buildId) {
		throw new Error("Documentation release lost a concurrent activation race");
	}
	return { site: activated, release };
}
