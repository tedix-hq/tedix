/** Background-job query helpers, isolated from app and item query graphs. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { Job, JobStatus, JobType, NewJob } from "../schema/jobs";
import { jobs } from "../schema/jobs";
import { getAffectedRows } from "../utils/d1-result";

/**
 * Create a new job
 */
export async function createJob(
	db: DbClient,
	data: {
		type: JobType;
		appId: string;
		payload?: Record<string, JsonValue>;
	},
): Promise<Job> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.insert(jobs).values({
		id,
		type: data.type,
		appId: data.appId,
		status: "pending",
		payload: data.payload,
		createdAt: now,
		updatedAt: now,
	});

	const job = await getJobById(db, id);
	if (!job) throw new Error("Failed to create job");
	return job;
}

/**
 * Get job by ID
 */
export async function getJobById(
	db: DbClient,
	id: string,
): Promise<Job | undefined> {
	return db.query.jobs.findFirst({ where: { id } });
}

/**
 * Get jobs by app
 */
export async function getJobsByApp(
	db: DbClient,
	appId: string,
	opts?: { limit?: number; offset?: number; status?: JobStatus },
) {
	const conditions = [eq(jobs.appId, appId)];
	if (opts?.status) {
		conditions.push(eq(jobs.status, opts.status));
	}

	const query = db
		.select()
		.from(jobs)
		.where(and(...conditions))
		.orderBy(desc(jobs.createdAt))
		.limit(opts?.limit ?? 50);

	if (opts?.offset !== undefined) {
		return query.offset(opts.offset);
	}

	return query;
}

/**
 * Count jobs by app (for pagination total)
 */
export async function countJobsByApp(
	db: DbClient,
	appId: string,
	opts?: { status?: JobStatus },
): Promise<number> {
	const conditions = [eq(jobs.appId, appId)];
	if (opts?.status) {
		conditions.push(eq(jobs.status, opts.status));
	}

	return db.$count(jobs, and(...conditions));
}

/**
 * Update job status
 */
export async function updateJobStatus(
	db: DbClient,
	id: string,
	status: JobStatus,
	data?: {
		result?: Record<string, JsonValue>;
		error?: string;
		progress?: Record<string, JsonValue>;
	},
): Promise<Job | undefined> {
	const now = new Date().toISOString();

	const updateData: Partial<NewJob> = {
		status,
		updatedAt: now,
	};

	// Set timestamps based on status
	if (status === "running") {
		updateData.startedAt = now;
	} else if (status === "completed" || status === "failed") {
		updateData.completedAt = now;
	}

	// Add optional data
	if (data?.result !== undefined) {
		updateData.result = data.result;
	}
	if (data?.error !== undefined) {
		updateData.error = data.error;
	}
	if (data?.progress !== undefined) {
		updateData.progress = data.progress;
	}

	await db.update(jobs).set(updateData).where(eq(jobs.id, id));

	return getJobById(db, id);
}

/**
 * Update job progress
 */
export async function updateJobProgress(
	db: DbClient,
	id: string,
	progress: Record<string, JsonValue>,
): Promise<Job | undefined> {
	const now = new Date().toISOString();

	await db
		.update(jobs)
		.set({
			progress,
			updatedAt: now,
		})
		.where(eq(jobs.id, id));

	return getJobById(db, id);
}

/**
 * Clean up old completed/failed jobs
 */
export async function cleanupOldJobs(
	db: DbClient,
	olderThanDays = 7,
): Promise<number> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - olderThanDays);
	const cutoffStr = cutoff.toISOString();

	const result = await db
		.delete(jobs)
		.where(
			and(
				or(eq(jobs.status, "completed"), eq(jobs.status, "failed")),
				sql`${jobs.completedAt} < ${cutoffStr}`,
			),
		);

	return getAffectedRows(result);
}
