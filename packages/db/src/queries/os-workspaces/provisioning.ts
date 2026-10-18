import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbQueryClient } from "../../query-client";
import { projects } from "../../schema/projects";
import { workItems, workItemRelations } from "../../schema/work-items";
import { workMilestones, workMilestoneItems } from "../../schema/work-factory";
import { skillSchedules } from "../../schema/cognitive";
import {
	osOutputs,
	osOutputRevisions,
	osWorkspaceProjects,
	osWorkspaceResources,
} from "../../schema/os-workspaces";

export interface BlueprintProvisioningRows {
	projects: (typeof projects.$inferInsert)[];
	milestones: (typeof workMilestones.$inferInsert)[];
	items: (typeof workItems.$inferInsert)[];
	relations: (typeof workItemRelations.$inferInsert)[];
	milestoneItems: (typeof workMilestoneItems.$inferInsert)[];
	outputs: (typeof osOutputs.$inferInsert)[];
	outputRevisions: (typeof osOutputRevisions.$inferInsert)[];
	projectLinks: (typeof osWorkspaceProjects.$inferInsert)[];
	schedules: (typeof skillSchedules.$inferInsert)[];
}

/** Single-row statements keep even wide Work rows below D1's 100-bind ceiling. */
export function buildBlueprintProvisioningStatements(
	db: DbQueryClient,
	rows: BlueprintProvisioningRows,
): BatchItem<"sqlite">[] {
	return [
		...rows.projects.map((row) => db.insert(projects).values(row)),
		...rows.projectLinks.map((row) =>
			db.insert(osWorkspaceProjects).values(row),
		),
		...rows.milestones.map((row) => db.insert(workMilestones).values(row)),
		...rows.items.map((row) => db.insert(workItems).values(row)),
		...rows.relations.map((row) => db.insert(workItemRelations).values(row)),
		...rows.milestoneItems.map((row) =>
			db.insert(workMilestoneItems).values(row),
		),
		...rows.outputs.map((row) => db.insert(osOutputs).values(row)),
		...rows.outputRevisions.map((row) =>
			db.insert(osOutputRevisions).values(row),
		),
		...rows.schedules.map((row) => db.insert(skillSchedules).values(row)),
	];
}

export async function getBlueprintApplyReceipt(
	db: DbQueryClient,
	organizationId: string,
	workspaceId: string,
) {
	const [row] = await db
		.select({ metadata: osWorkspaceResources.metadata })
		.from(osWorkspaceResources)
		.where(
			and(
				eq(osWorkspaceResources.organizationId, organizationId),
				eq(osWorkspaceResources.workspaceId, workspaceId),
				eq(osWorkspaceResources.slot, "blueprint-apply-receipt"),
			),
		)
		.limit(1);
	return row?.metadata;
}
