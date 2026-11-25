import { and, desc, eq, getColumns, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	type DocsRelease,
	type DocsSite,
	docsReleases as d1DocsReleases,
	docsSites as d1DocsSites,
} from "../../schema/docs-sites";
import {
	docsSites as pgDocsSites,
	docsReleases as pgDocsReleases,
} from "../../schema-pg/core";
import { getDocsBuild } from "./builds";
import { getDocsSiteById } from "./sites";
import { docsNow } from "./clock";

function releaseOrder(db: DbQueryClient) {
	return coreStore(db) === "postgres"
		? sql`${coreTable(db, d1DocsReleases)}.${sql.identifier("release_order")}`
		: sql`rowid`;
}

function pgRow(
	alias: string,
	table: typeof d1DocsSites | typeof d1DocsReleases,
) {
	return sql`jsonb_build_object(${sql.join(
		Object.entries(getColumns(table)).flatMap(([key, column]) => [
			sql`${key}::text`,
			sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`,
		]),
		sql`, `,
	)})`;
}

interface DocsActorParams {
	type: string;
	id: string;
	sessionId: string | null;
}

export interface DocsReleaseGuard {
	sourceRevision: string;
	previousBuildId: string;
	previousReleaseId: string;
	canonicalUrl: string;
	repositoryUrl: string;
}

export interface ActivateDocsBuildParams {
	buildId: string;
	orgSlug: string;
	siteId: string;
	action: DocsRelease["action"];
	actor: DocsActorParams;
	guard?: DocsReleaseGuard;
}

export interface ActivateDocsBuildResult {
	site: DocsSite;
	release: DocsRelease;
}

export function listDocsReleases(
	db: DbQueryClient,
	siteId: string,
): Promise<DocsRelease[]> {
	const docsReleases = coreTable(db, d1DocsReleases);
	return db
		.select()
		.from(docsReleases)
		.where(eq(docsReleases.siteId, siteId))
		.orderBy(desc(docsReleases.createdAt), desc(releaseOrder(db)))
		.limit(50);
}

export async function activateDocsBuild(
	db: DbQueryClient,
	params: ActivateDocsBuildParams,
): Promise<ActivateDocsBuildResult> {
	const docsSites = coreTable(db, d1DocsSites);
	const docsReleases = coreTable(db, d1DocsReleases);
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

	const guard = params.guard;
	if (
		guard &&
		(params.action !== "publish" ||
			site.activeBuildId !== guard.previousBuildId ||
			build.sourceBranch !== "main" ||
			build.sourceRevision !== guard.sourceRevision ||
			build.proposalId ||
			build.phase !== "ready" ||
			!build.manifestKey ||
			build.requestedByType !== params.actor.type ||
			build.requestedById !== params.actor.id)
	) {
		throw new Error("Documentation build does not match its delegated release");
	}

	const releaseId = crypto.randomUUID();
	const activationScope = and(
		eq(docsSites.id, params.siteId),
		eq(docsSites.orgSlug, params.orgSlug),
		coreStore(db) === "postgres"
			? sql`${docsSites.activeBuildId} IS NOT DISTINCT FROM ${site.activeBuildId}`
			: sql`${docsSites.activeBuildId} is ${site.activeBuildId}`,
		guard &&
			and(
				// A source-row CAS is rechecked after a Pg row-lock wait;
				// a latest-receipt subquery alone can retain its old snapshot.
				coreStore(db) === "postgres"
					? sql`${docsSites}.${sql.identifier("active_release_id")} = ${guard.previousReleaseId}`
					: undefined,
				eq(docsSites.canonicalUrl, guard.canonicalUrl),
				eq(docsSites.status, "active"),
				eq(docsSites.accessMode, "public"),
				eq(docsSites.sourceProvider, "github"),
				eq(docsSites.sourceAuthMode, "public"),
				eq(docsSites.repositoryUrl, guard.repositoryUrl),
				eq(docsSites.branch, "main"),
				eq(docsSites.contentRoot, "docs/public"),
				sql`(${db
					.select({
						id: sql`case when ${docsReleases.action} = 'publish' then ${docsReleases.id} end`,
					})
					.from(docsReleases)
					.where(eq(docsReleases.siteId, params.siteId))
					.orderBy(desc(docsReleases.createdAt), desc(releaseOrder(db)))
					.limit(1)}) = ${guard.previousReleaseId}`,
			),
	);
	const releaseValues = {
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
		createdAt: sql<string>`${docsNow(db)}`.as("created_at"),
	};

	if (coreStore(db) === "postgres") {
		// The shared D1 type omits data-modifying CTEs supported by both Pg drivers.
		const pgDb = db as unknown as PostgresJsDatabase;
		// Consume exactly the CAS-returned row; no connection-local changes() or
		// later snapshot can create a receipt for another activation.
		const activated = pgDb.$with("activated").as(
			pgDb
				.update(pgDocsSites)
				.set({ activeBuildId: params.buildId, updatedAt: docsNow(db) })
				.where(activationScope)
				.returning({
					...getColumns(pgDocsSites),
					receiptId:
						sql<string>`${docsSites}.${sql.identifier("active_release_id")}`.as(
							"receipt_id",
						),
				}),
		);
		const recorded = pgDb.$with("recorded").as(
			pgDb
				.insert(pgDocsReleases)
				.select(
					pgDb
						.select({ ...releaseValues, id: activated.receiptId })
						.from(activated),
				)
				.returning(),
		);
		const [result] = await pgDb
			.with(activated, recorded)
			.select({
				site: sql<DocsSite>`${pgRow("activated", d1DocsSites)}`.as("site"),
				release: sql<DocsRelease>`${pgRow("recorded", d1DocsReleases)}`.as(
					"release",
				),
			})
			.from(activated)
			.innerJoin(recorded, sql`true`);
		if (!result)
			throw new Error(
				"Documentation release lost a concurrent activation race",
			);
		return result;
	}

	const activateSite = db
		.update(docsSites)
		.set({ activeBuildId: params.buildId, updatedAt: docsNow(db) })
		.where(activationScope);
	const recordRelease = db
		.insert(docsReleases)
		.select(
			db
				.select(releaseValues)
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
