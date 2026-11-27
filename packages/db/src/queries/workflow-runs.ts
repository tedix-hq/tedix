import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, getColumns, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds } from "../core-store/dialect";
import {
	type NewWorkflowRunLedger,
	type WorkflowRunLedger,
	type WorkflowRunStatus,
	workflowRunLedger as schemaWorkflowRunLedger,
} from "../schema/workflow-runs";

export type WorkflowRunRecordInput = {
	workflowType: string;
	workflowId: string;
	trigger: string;
	target?: string | null;
	status?: WorkflowRunStatus;
	totalCount?: number;
	successCount?: number;
	errorCount?: number;
	output?: Record<string, JsonValue> | null;
	error?: string | null;
};

export async function createWorkflowRunRecord(
	db: DbClient,
	input: WorkflowRunRecordInput,
): Promise<WorkflowRunLedger> {
	const workflowRunLedger = coreTable(db, schemaWorkflowRunLedger);
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const values: NewWorkflowRunLedger = {
		id,
		workflowType: input.workflowType,
		workflowId: input.workflowId,
		trigger: input.trigger,
		target: input.target ?? null,
		status: input.status ?? "running",
		startedAt: now,
		totalCount: input.totalCount ?? 0,
		successCount: input.successCount ?? 0,
		errorCount: input.errorCount ?? 0,
		output: input.output ?? null,
		error: input.error ?? null,
	};
	const [record] = await db
		.insert(workflowRunLedger)
		.values(values)
		.returning();
	if (!record) throw new Error(`Failed to create workflow run record: ${id}`);
	return record;
}

export async function completeWorkflowRunRecord(
	db: DbClient,
	id: string,
	update: {
		status: Exclude<WorkflowRunStatus, "queued" | "running">;
		totalCount?: number;
		successCount?: number;
		errorCount?: number;
		output?: Record<string, JsonValue> | null;
		error?: string | null;
	},
): Promise<WorkflowRunLedger | null> {
	const workflowRunLedger = coreTable(db, schemaWorkflowRunLedger);
	const [record] = await db
		.update(workflowRunLedger)
		.set({
			status: update.status,
			completedAt: new Date().toISOString(),
			totalCount: update.totalCount,
			successCount: update.successCount,
			errorCount: update.errorCount,
			output: update.output ?? null,
			error: update.error ?? null,
		})
		.where(eq(workflowRunLedger.id, id))
		.returning();
	return record ?? null;
}

export async function getRecentWorkflowRunRecords(
	db: DbClient,
	options: { workflowType?: string; limit?: number } = {},
): Promise<WorkflowRunLedger[]> {
	const workflowRunLedger = coreTable(db, schemaWorkflowRunLedger);
	const limit = options.limit ?? 20;
	const query = db
		.select()
		.from(workflowRunLedger)
		.orderBy(desc(workflowRunLedger.startedAt))
		.limit(limit);

	if (options.workflowType) {
		return query.where(
			eq(workflowRunLedger.workflowType, options.workflowType),
		);
	}

	return query;
}

/**
 * Return the latest durable ledger row for every requested platform workflow
 * type. The per-type maximum avoids a global recent-run sample, which can hide
 * quiet workflow types behind one noisy workflow.
 */
export async function getLatestWorkflowRunRecordsByTypes(
	db: DbClient,
	workflowTypes: string[],
): Promise<WorkflowRunLedger[]> {
	const workflowRunLedger = coreTable(db, schemaWorkflowRunLedger);
	const types = [...new Set(workflowTypes)];
	if (types.length === 0) return [];

	const maxima = db
		.select({
			workflowType: workflowRunLedger.workflowType,
			startedAt: sql<string>`max(${workflowRunLedger.startedAt})`.as(
				"max_started_at",
			),
		})
		.from(workflowRunLedger)
		.where(anyIds(db, workflowRunLedger.workflowType, types))
		.groupBy(workflowRunLedger.workflowType)
		.as("maxima");

	const latest = await db
		.select(getColumns(workflowRunLedger))
		.from(workflowRunLedger)
		.innerJoin(
			maxima,
			and(
				eq(workflowRunLedger.workflowType, maxima.workflowType),
				eq(workflowRunLedger.startedAt, maxima.startedAt),
			),
		)
		.orderBy(desc(workflowRunLedger.startedAt), desc(workflowRunLedger.id));

	const seen = new Set<string>();
	return latest.filter((row) => {
		if (seen.has(row.workflowType)) return false;
		seen.add(row.workflowType);
		return true;
	});
}
