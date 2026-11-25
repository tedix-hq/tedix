import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { projects } from "../../schema/projects";
import { workItems, workItemRelations } from "../../schema/work-items";
import { workCaseItems, workCases } from "../../schema/work-factory";
import { skillSchedules } from "../../schema/cognitive";
import {
	osWorkspaceProjects,
	osWorkspaceResources,
} from "../../schema/os-workspaces";
import {
	type osOutputs,
	type osOutputRevisions,
} from "../../tenant-store/outputs-schema";

export interface BlueprintProvisioningRows {
	projects: (typeof projects.$inferInsert)[];
	epics: (typeof workCases.$inferInsert)[];
	items: (typeof workItems.$inferInsert)[];
	relations: (typeof workItemRelations.$inferInsert)[];
	epicItems: (typeof workCaseItems.$inferInsert)[];
	outputs: (typeof osOutputs.$inferInsert)[];
	outputRevisions: (typeof osOutputRevisions.$inferInsert)[];
	projectLinks: (typeof osWorkspaceProjects.$inferInsert)[];
	schedules: (typeof skillSchedules.$inferInsert)[];
}

type ProvisioningStatement = BatchItem<"sqlite"> & {
	toSQL(): { params: unknown[] };
};

/** Group by the actual bound values: wide Work rows need smaller D1 chunks. */
function provisioningInserts<T>(
	db: DbQueryClient,
	rows: T[],
	insert: (rows: T[]) => ProvisioningStatement,
): ProvisioningStatement[] {
	if (!rows.length) return [];
	if (coreStore(db) === "postgres") return [insert(rows)];
	const statements: ProvisioningStatement[] = [];
	let group: T[] = [];
	let pending: ProvisioningStatement | undefined;
	for (const row of rows) {
		const next = insert([...group, row]);
		if (next.toSQL().params.length > 100 && pending) {
			statements.push(pending);
			group = [row];
			pending = insert(group);
		} else {
			group.push(row);
			pending = next;
		}
		if (pending.toSQL().params.length > 100)
			throw new Error("A blueprint provisioning row exceeds the D1 bind limit");
	}
	if (pending) statements.push(pending);
	return statements;
}

/** Every table's set inserts are constructed before submitting the owning batch. */
export function buildBlueprintProvisioningStatements(
	db: DbQueryClient,
	rows: BlueprintProvisioningRows,
): BatchItem<"sqlite">[] {
	if (rows.outputs.length || rows.outputRevisions.length)
		throw new Error(
			"Blueprint document writes require the workspace object service",
		);
	const projectsTable = coreTable(db, projects);
	const projectLinks = coreTable(db, osWorkspaceProjects);
	const cases = coreTable(db, workCases);
	const items = coreTable(db, workItems);
	const relations = coreTable(db, workItemRelations);
	const caseItems = coreTable(db, workCaseItems);
	const schedules = coreTable(db, skillSchedules);
	return [
		...provisioningInserts(db, rows.projects, (values) =>
			db.insert(projectsTable).values(values),
		),
		...provisioningInserts(db, rows.projectLinks, (values) =>
			db.insert(projectLinks).values(values),
		),
		...provisioningInserts(db, rows.epics, (values) =>
			db.insert(cases).values(values),
		),
		...provisioningInserts(db, rows.items, (values) =>
			db.insert(items).values(values),
		),
		...provisioningInserts(db, rows.relations, (values) =>
			db.insert(relations).values(values),
		),
		...provisioningInserts(db, rows.epicItems, (values) =>
			db.insert(caseItems).values(values),
		),
		...provisioningInserts(db, rows.schedules, (values) =>
			db.insert(schedules).values(values),
		),
	];
}

export async function getBlueprintApplyReceipt(
	db: DbQueryClient,
	organizationId: string,
	workspaceId: string,
) {
	const osWorkspaceResourcesTable = coreTable(db, osWorkspaceResources);
	const [row] = await db
		.select({ metadata: osWorkspaceResourcesTable.metadata })
		.from(osWorkspaceResourcesTable)
		.where(
			and(
				eq(osWorkspaceResourcesTable.organizationId, organizationId),
				eq(osWorkspaceResourcesTable.workspaceId, workspaceId),
				eq(osWorkspaceResourcesTable.slot, "blueprint-apply-receipt"),
			),
		)
		.limit(1);
	return row?.metadata;
}
