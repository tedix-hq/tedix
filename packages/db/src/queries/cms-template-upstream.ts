import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import type { CmsTemplateUpstreamReport } from "@tedix/api-contract/schemas/cms-template-upstream";
import { projects } from "../schema/projects";
import { workItems } from "../schema/work-items";

export async function findOpenCmsTemplateUpstreamWork(
	db: DbQueryClient,
	orgId: string,
	projectId: string,
	title: string,
) {
	const [row] = await db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.projectId, projectId),
				eq(workItems.title, title),
				inArray(workItems.disposition, ["proposed", "accepted"]),
			),
		)
		.orderBy(workItems.createdAt)
		.limit(1);
	return row?.id ?? null;
}

export async function listCmsTemplateUpstreamProjects(
	db: DbQueryClient,
	orgId?: string,
) {
	return db
		.select()
		.from(projects)
		.where(
			and(
				isNull(projects.archivedAt),
				orgId ? eq(projects.orgId, orgId) : undefined,
				sql`json_extract(${projects.metadata}, '$.cmsTemplateUpstreamCheck.enabled') = 1`,
			),
		)
		.orderBy(projects.id);
}

export async function saveCmsTemplateUpstreamReport(
	db: DbQueryClient,
	projectId: string,
	orgId: string,
	report: CmsTemplateUpstreamReport,
) {
	await db
		.update(projects)
		.set({
			metadata: sql`json_set(coalesce(${projects.metadata}, '{}'), '$.cmsTemplateUpstreamReport', json(${JSON.stringify(report)}))`,
		})
		.where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
}
