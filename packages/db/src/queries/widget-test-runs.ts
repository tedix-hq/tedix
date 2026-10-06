/**
 * Widget Test Run Query Helpers
 * Database queries for persisting and retrieving widget test runs.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { generatedWidgetArtifacts } from "../schema/generated-widget-artifacts";
import {
	type NewWidgetTestRun,
	type WidgetTestRun,
	widgetTestRuns,
} from "../schema/widget-test-runs";
import { prefixedColumns } from "../utils/select";

export interface WidgetVisualDiffBaseline {
	source: "published_artifact" | "qa_passed_artifact" | "passed_run";
	runId: string;
	artifactId: string | null;
	artifactStatus: string | null;
	screenshotUrl: string;
	createdAt: string | null;
	publishedAt: string | null;
}

function firstScreenshotUrl(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	for (const screenshot of value) {
		if (
			screenshot &&
			typeof screenshot === "object" &&
			"url" in screenshot &&
			typeof screenshot.url === "string"
		) {
			return screenshot.url;
		}
	}
	return null;
}

/**
 * Insert a widget test run
 */
export async function insertWidgetTestRun(
	db: DbClient,
	run: NewWidgetTestRun,
): Promise<void> {
	await db.insert(widgetTestRuns).values(run);
}

/**
 * Get a widget test run by ID (org-scoped)
 */
export async function getWidgetTestRunById(
	db: DbClient,
	id: string,
	organizationId: string,
): Promise<WidgetTestRun | undefined> {
	const rows = await db
		.select()
		.from(widgetTestRuns)
		.where(
			and(
				eq(widgetTestRuns.id, id),
				eq(widgetTestRuns.organizationId, organizationId),
			),
		)
		.limit(1);
	return rows[0];
}

/**
 * List widget test runs for an app (org-scoped)
 */
export async function listWidgetTestRunsByApp(
	db: DbClient,
	appSlug: string,
	organizationId: string,
	limit = 50,
): Promise<WidgetTestRun[]> {
	return db
		.select()
		.from(widgetTestRuns)
		.where(
			and(
				eq(widgetTestRuns.appSlug, appSlug),
				eq(widgetTestRuns.organizationId, organizationId),
			),
		)
		.orderBy(desc(widgetTestRuns.createdAt))
		.limit(limit);
}

/**
 * List widget test runs for an organization
 */
export async function listWidgetTestRunsByOrg(
	db: DbClient,
	organizationId: string,
	limit = 50,
): Promise<WidgetTestRun[]> {
	return db
		.select()
		.from(widgetTestRuns)
		.where(eq(widgetTestRuns.organizationId, organizationId))
		.orderBy(desc(widgetTestRuns.createdAt))
		.limit(limit);
}

/**
 * Find the latest promoted/passed screenshot to use as a Browser QA baseline.
 *
 * Generated widget artifacts are authoritative when present because "published"
 * is the promotion boundary. Passed test runs cover QA baselines that have not
 * been promoted into generated artifact records yet.
 */
export async function getLatestWidgetVisualDiffBaseline(
	db: DbClient,
	params: {
		organizationId: string;
		appId: string;
		appSlug: string;
		toolName: string;
		appToolId?: string | null;
		toolId?: string | null;
	},
): Promise<WidgetVisualDiffBaseline | undefined> {
	const artifactConditions = [
		eq(generatedWidgetArtifacts.organizationId, params.organizationId),
		eq(generatedWidgetArtifacts.appId, params.appId),
		inArray(generatedWidgetArtifacts.status, ["published", "qa_passed"]),
		eq(widgetTestRuns.passed, true),
	];

	if (params.appToolId) {
		artifactConditions.push(
			eq(generatedWidgetArtifacts.appToolId, params.appToolId),
		);
	} else if (params.toolId) {
		artifactConditions.push(eq(generatedWidgetArtifacts.toolId, params.toolId));
	} else {
		artifactConditions.push(
			eq(generatedWidgetArtifacts.toolName, params.toolName),
		);
	}

	// `prefixedColumns`, not per-column table references: distinct TS keys still
	// emit the raw column names, so the artifact's and the run's `id` both came
	// back as `id`, D1 collapsed them, and every later column shifted left. The
	// baseline then carried the run's screenshot JSON as its `runId` and the
	// artifact's `published_at` as its `createdAt`.
	const artifactRows = await db
		.select({
			artifact: prefixedColumns(generatedWidgetArtifacts, "artifact"),
			run: prefixedColumns(widgetTestRuns, "run"),
		})
		.from(generatedWidgetArtifacts)
		.innerJoin(
			widgetTestRuns,
			eq(generatedWidgetArtifacts.widgetTestRunId, widgetTestRuns.id),
		)
		.where(and(...artifactConditions))
		.orderBy(
			sql`CASE ${generatedWidgetArtifacts.status} WHEN 'published' THEN 0 ELSE 1 END`,
			desc(generatedWidgetArtifacts.publishedAt),
			desc(generatedWidgetArtifacts.updatedAt),
			desc(generatedWidgetArtifacts.createdAt),
		)
		.limit(10);

	for (const row of artifactRows) {
		const screenshotUrl =
			row.artifact.screenshotUrl ?? firstScreenshotUrl(row.run.screenshots);
		if (!screenshotUrl) continue;
		return {
			source:
				row.artifact.status === "published"
					? "published_artifact"
					: "qa_passed_artifact",
			runId: row.run.id,
			artifactId: row.artifact.id,
			artifactStatus: row.artifact.status,
			screenshotUrl,
			createdAt: row.run.createdAt,
			publishedAt: row.artifact.publishedAt ?? null,
		};
	}

	const runRows = await db
		.select({
			id: widgetTestRuns.id,
			screenshots: widgetTestRuns.screenshots,
			createdAt: widgetTestRuns.createdAt,
		})
		.from(widgetTestRuns)
		.where(
			and(
				eq(widgetTestRuns.organizationId, params.organizationId),
				eq(widgetTestRuns.appSlug, params.appSlug),
				eq(widgetTestRuns.toolName, params.toolName),
				eq(widgetTestRuns.passed, true),
			),
		)
		.orderBy(desc(widgetTestRuns.createdAt))
		.limit(10);

	for (const row of runRows) {
		const screenshotUrl = firstScreenshotUrl(row.screenshots);
		if (!screenshotUrl) continue;
		return {
			source: "passed_run",
			runId: row.id,
			artifactId: null,
			artifactStatus: null,
			screenshotUrl,
			createdAt: row.createdAt,
			publishedAt: null,
		};
	}

	return undefined;
}
