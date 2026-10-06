import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const docsSites = sqliteTable(
	"docs_sites",
	{
		id: text("id").primaryKey(),
		orgSlug: text("org_slug")
			.notNull()
			.references(() => organizations.slug, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		title: text("title").notNull(),
		description: text("description").notNull(),
		locale: text("locale").notNull().default("en"),
		canonicalUrl: text("canonical_url").notNull(),
		sourceProvider: text("source_provider", {
			enum: ["artifacts", "github", "gitlab", "generic"],
		}).notNull(),
		sourceAuthMode: text("source_auth_mode", {
			enum: ["public", "connection"],
		})
			.notNull()
			.default("public"),
		repositoryUrl: text("repository_url"),
		artifactsRepository: text("artifacts_repository"),
		branch: text("branch").notNull().default("main"),
		contentRoot: text("content_root").notNull().default("docs"),
		accessMode: text("access_mode", { enum: ["public", "organization"] })
			.notNull()
			.default("public"),
		status: text("status", { enum: ["active", "paused"] })
			.notNull()
			.default("active"),
		activeBuildId: text("active_build_id"),
		latestBuildId: text("latest_build_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [
		uniqueIndex("docs_sites_slug_unique").on(table.slug),
		index("docs_sites_org_slug_idx").on(table.orgSlug),
	],
);

export const docsBuilds = sqliteTable(
	"docs_builds",
	{
		id: text("id").primaryKey(),
		siteId: text("site_id")
			.notNull()
			.references(() => docsSites.id, { onDelete: "cascade" }),
		status: text("status", {
			enum: ["queued", "running", "complete", "failed"],
		})
			.notNull()
			.default("queued"),
		phase: text("phase").notNull().default("queued"),
		sourceBranch: text("source_branch"),
		sourceRevision: text("source_revision"),
		proposalId: text("proposal_id"),
		manifestKey: text("manifest_key"),
		error: text("error"),
		requestedByType: text("requested_by_type"),
		requestedById: text("requested_by_id"),
		requestedBySessionId: text("requested_by_session_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		startedAt: text("started_at"),
		finishedAt: text("finished_at"),
	},
	(table) => [
		index("docs_builds_site_created_idx").on(table.siteId, table.createdAt),
		index("docs_builds_status_idx").on(table.status),
	],
);

export const docsChanges = sqliteTable(
	"docs_changes",
	{
		id: text("id").primaryKey(),
		siteId: text("site_id")
			.notNull()
			.references(() => docsSites.id, { onDelete: "cascade" }),
		status: text("status", {
			enum: ["proposed", "validating", "validated", "committed", "rejected"],
		})
			.notNull()
			.default("proposed"),
		path: text("path").notNull(),
		message: text("message").notNull(),
		baseRevision: text("base_revision").notNull(),
		proposalBranch: text("proposal_branch").notNull(),
		proposalRevision: text("proposal_revision").notNull(),
		contentSha256: text("content_sha256").notNull(),
		previewBuildId: text("preview_build_id"),
		committedRevision: text("committed_revision"),
		proposedByType: text("proposed_by_type").notNull(),
		proposedById: text("proposed_by_id").notNull(),
		proposedBySessionId: text("proposed_by_session_id"),
		committedByType: text("committed_by_type"),
		committedById: text("committed_by_id"),
		committedBySessionId: text("committed_by_session_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		committedAt: text("committed_at"),
	},
	(table) => [
		index("docs_changes_site_created_idx").on(table.siteId, table.createdAt),
		index("docs_changes_status_idx").on(table.status),
	],
);

export const docsReleases = sqliteTable(
	"docs_releases",
	{
		id: text("id").primaryKey(),
		siteId: text("site_id")
			.notNull()
			.references(() => docsSites.id, { onDelete: "cascade" }),
		buildId: text("build_id")
			.notNull()
			.references(() => docsBuilds.id, { onDelete: "restrict" }),
		previousBuildId: text("previous_build_id"),
		action: text("action", { enum: ["publish", "rollback"] }).notNull(),
		actorType: text("actor_type").notNull(),
		actorId: text("actor_id").notNull(),
		actorSessionId: text("actor_session_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [
		index("docs_releases_site_created_idx").on(table.siteId, table.createdAt),
		index("docs_releases_build_idx").on(table.buildId),
	],
);

export type DocsSite = typeof docsSites.$inferSelect;
export type NewDocsSite = typeof docsSites.$inferInsert;
export type DocsBuild = typeof docsBuilds.$inferSelect;
export type NewDocsBuild = typeof docsBuilds.$inferInsert;
export type DocsChange = typeof docsChanges.$inferSelect;
export type NewDocsChange = typeof docsChanges.$inferInsert;
export type DocsRelease = typeof docsReleases.$inferSelect;
export type NewDocsRelease = typeof docsReleases.$inferInsert;
