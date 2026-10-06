import "@orpc/openapi/extensions/route";
/**
 * Jobs Contract for oRPC
 * Type-safe API contract for background job tracking endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	AppIdParamSchema,
	PaginationMetaSchema,
	PaginationSchema,
} from "../schemas/common";

// =============================================================================
// SCHEMAS
// =============================================================================

export const JobStatusSchema = z.enum([
	"pending",
	"running",
	"completed",
	"failed",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobTypeSchema = z.enum([
	"discover_items",
	"scrape",
	"ai_sync",
	"blog_generation",
	"mcp_eval",
]);
export type JobType = z.infer<typeof JobTypeSchema>;

export const JobSchema = z.object({
	id: z.string(),
	type: JobTypeSchema,
	status: JobStatusSchema,
	appId: z.string(),
	payload: z.unknown().nullable(),
	result: z.unknown().nullable(),
	error: z.string().nullable(),
	progress: z.unknown().nullable(),
	createdAt: z.string().nullable(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const JobIdParamSchema = z.object({
	jobId: z.string().min(1, "Job ID is required"),
});

// =============================================================================
// CONTRACT DEFINITION
// =============================================================================

/**
 * Jobs Contract - background job tracking
 *
 * All endpoints are app-scoped via appId parameter
 */
export const jobsContract = {
	/**
	 * Get a job by ID
	 * GET /apps/{appId}/jobs/{jobId}
	 */
	getJob: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/jobs/{jobId}",
			tags: ["jobs"],
			summary: "Get job by ID",
			description:
				"Get detailed information about a background job including status, progress, and result",
		})
		.input(AppIdParamSchema.extend(JobIdParamSchema.shape))
		.output(JobSchema),

	/**
	 * List jobs for an app
	 * GET /apps/{appId}/jobs
	 */
	listJobs: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/jobs",
			tags: ["jobs"],
			summary: "List jobs",
			description:
				"List background jobs for an app with optional status filter and pagination",
		})
		.input(
			AppIdParamSchema.extend({
				...PaginationSchema.shape,
				status: JobStatusSchema.optional(),
			}),
		)
		.output(
			z.object({
				data: z.array(JobSchema),
				pagination: PaginationMetaSchema,
			}),
		),
};

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type JobsContract = typeof jobsContract;
