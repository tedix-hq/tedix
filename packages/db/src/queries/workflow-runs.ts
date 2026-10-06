import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type NewWorkflowRunLedger,
	type WorkflowRunLedger,
	type WorkflowRunStatus,
	workflowRunLedger,
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
	await db.insert(workflowRunLedger).values(values);

	const [record] = await db
		.select()
		.from(workflowRunLedger)
		.where(eq(workflowRunLedger.id, id))
		.limit(1);
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
	await db
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
		.where(eq(workflowRunLedger.id, id));

	const [record] = await db
		.select()
		.from(workflowRunLedger)
		.where(eq(workflowRunLedger.id, id))
		.limit(1);
	return record ?? null;
}

export async function getRecentWorkflowRunRecords(
	db: DbClient,
	options: { workflowType?: string; limit?: number } = {},
): Promise<WorkflowRunLedger[]> {
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
 * type. The two-stage query avoids a global recent-run sample, which can hide
 * quiet workflow types behind one noisy workflow.
 */
export async function getLatestWorkflowRunRecordsByTypes(
	db: DbClient,
	workflowTypes: string[],
): Promise<WorkflowRunLedger[]> {
	const types = [...new Set(workflowTypes)];
	if (types.length === 0) return [];

	const maxima = await db
		.select({
			workflowType: workflowRunLedger.workflowType,
			startedAt: sql<string>`max(${workflowRunLedger.startedAt})`,
		})
		.from(workflowRunLedger)
		.where(inArray(workflowRunLedger.workflowType, types))
		.groupBy(workflowRunLedger.workflowType);
	if (maxima.length === 0) return [];

	const latest = await db
		.select()
		.from(workflowRunLedger)
		.where(
			or(
				...maxima.map((row) =>
					and(
						eq(workflowRunLedger.workflowType, row.workflowType),
						eq(workflowRunLedger.startedAt, row.startedAt),
					),
				),
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

export async function deleteOldWorkflowRunRecords(
	db: DbClient,
	olderThanDays = 90,
): Promise<number> {
	const cutoff = new Date(
		Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const result = await db
		.delete(workflowRunLedger)
		.where(lt(workflowRunLedger.startedAt, cutoff));
	return result.meta?.changes ?? 0;
}
