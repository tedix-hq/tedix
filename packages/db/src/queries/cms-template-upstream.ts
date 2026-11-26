import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
import { coreStore, jsonRead, pgTextArray } from "../core-store/dialect";
import type { CmsTemplateUpstreamReport } from "@tedix/api-contract/schemas/cms-template-upstream";
import { projects as schemaProjects } from "../schema/projects";
import { workItems as schemaWorkItems } from "../schema/work-items";

export async function findOpenCmsTemplateUpstreamWork(
	db: DbQueryClient,
	orgId: string,
	projectId: string,
	title: string,
) {
	const workItems = coreTable(db, schemaWorkItems);
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
	const projects = coreTable(db, schemaProjects);
	return db
		.select()
		.from(projects)
		.where(
			and(
				isNull(projects.archivedAt),
				orgId ? eq(projects.orgId, orgId) : undefined,
				coreStore(db) === "postgres"
					? sql`(${jsonRead(db, projects.metadata, ["cmsTemplateUpstreamCheck", "enabled"], "boolean")} = true OR ${jsonRead(db, projects.metadata, ["cmsTemplateUpstreamCheck", "enabled"], "number")} = 1)`
					: sql`json_extract(${projects.metadata}, '$.cmsTemplateUpstreamCheck.enabled') = 1`,
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
	const projects = coreTable(db, schemaProjects);
	await db
		.update(projects)
		.set({
			metadata:
				coreStore(db) === "postgres"
					? sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), ${pgTextArray(["cmsTemplateUpstreamReport"])}::text[], ${JSON.stringify(report)}::text::jsonb, true)`
					: sql`json_set(coalesce(${projects.metadata}, '{}'), '$.cmsTemplateUpstreamReport', json(${JSON.stringify(report)}))`,
		})
		.where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
}
