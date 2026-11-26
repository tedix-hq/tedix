import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds, jsonRead } from "../core-store/dialect";
import { batchNonEmpty } from "../utils/batch";
import { organizations as schemaOrganizations } from "../schema/organizations";
import {
	siteReconciliationFindings as schemaFindings,
	siteReconciliationRuns as schemaRuns,
} from "../schema/site-reconciliation";

export interface SiteFindingInput {
	siteId: string;
	slug: string;
	type: "cms" | "docs";
	code: string;
	severity: "warning" | "error";
	detail: string;
}

export async function listSiteReconciliationOrganizations(
	db: DbClient,
	limit = 100,
) {
	const organizations = coreTable(db, schemaOrganizations);
	return db
		.select({ id: organizations.id, slug: organizations.slug })
		.from(organizations)
		.where(sql`${jsonRead(db, organizations.metadata, ["retiredAt"])} IS NULL`)
		.orderBy(organizations.id)
		.limit(limit);
}

export async function recordSiteReconciliation(
	db: DbClient,
	input: {
		runId: string;
		organizationId: string;
		source: "manual" | "scheduled";
		startedAt: string;
		completedAt: string;
		sitesChecked: number;
		findings: SiteFindingInput[];
	},
) {
	const siteReconciliationFindings = coreTable(db, schemaFindings);
	const siteReconciliationRuns = coreTable(db, schemaRuns);
	const open = await db
		.select()
		.from(siteReconciliationFindings)
		.where(
			and(
				eq(siteReconciliationFindings.organizationId, input.organizationId),
				isNull(siteReconciliationFindings.resolvedAt),
			),
		);
	const byKey = new Map(
		open.map((finding) => [`${finding.siteId}:${finding.code}`, finding]),
	);
	const statements: Array<
		| ReturnType<ReturnType<typeof db.insert>["values"]>
		| ReturnType<ReturnType<ReturnType<typeof db.update>["set"]>["where"]>
	> = [
		db.insert(siteReconciliationRuns).values({
			id: input.runId,
			organizationId: input.organizationId,
			source: input.source,
			startedAt: input.startedAt,
			completedAt: input.completedAt,
			sitesChecked: input.sitesChecked,
			issueCount: input.findings.length,
		}),
	];
	const activeIds = input.findings
		.map((finding) => byKey.get(`${finding.siteId}:${finding.code}`)?.id)
		.filter((id): id is string => Boolean(id));
	if (open.length)
		statements.push(
			db
				.update(siteReconciliationFindings)
				.set({ resolvedAt: input.completedAt })
				.where(
					and(
						eq(siteReconciliationFindings.organizationId, input.organizationId),
						isNull(siteReconciliationFindings.resolvedAt),
						activeIds.length
							? sql`NOT (${anyIds(db, siteReconciliationFindings.id, activeIds)})`
							: sql`1 = 1`,
					),
				),
		);
	for (const finding of input.findings) {
		const current = byKey.get(`${finding.siteId}:${finding.code}`);
		if (current)
			statements.push(
				db
					.update(siteReconciliationFindings)
					.set({
						runId: input.runId,
						siteSlug: finding.slug,
						siteType: finding.type,
						severity: finding.severity,
						detail: finding.detail,
						lastDetectedAt: input.completedAt,
					})
					.where(eq(siteReconciliationFindings.id, current.id)),
			);
		else
			statements.push(
				db.insert(siteReconciliationFindings).values({
					id: crypto.randomUUID(),
					runId: input.runId,
					organizationId: input.organizationId,
					siteId: finding.siteId,
					siteSlug: finding.slug,
					siteType: finding.type,
					code: finding.code,
					severity: finding.severity,
					detail: finding.detail,
					firstDetectedAt: input.completedAt,
					lastDetectedAt: input.completedAt,
				}),
			);
	}

	await db.batch(batchNonEmpty(statements));
}

export async function getLatestSiteReconciliation(
	db: DbClient,
	organizationId: string,
) {
	const siteReconciliationFindings = coreTable(db, schemaFindings);
	const siteReconciliationRuns = coreTable(db, schemaRuns);
	const [run] = await db
		.select()
		.from(siteReconciliationRuns)
		.where(eq(siteReconciliationRuns.organizationId, organizationId))
		.orderBy(desc(siteReconciliationRuns.completedAt))
		.limit(1);
	if (!run) return null;
	const findings = await db
		.select()
		.from(siteReconciliationFindings)
		.where(
			and(
				eq(siteReconciliationFindings.organizationId, organizationId),
				isNull(siteReconciliationFindings.resolvedAt),
			),
		)
		.orderBy(
			desc(siteReconciliationFindings.severity),
			siteReconciliationFindings.siteSlug,
		);
	return { run, findings };
}
