/**
 * Jobs Router (oRPC)
 * Background job tracking endpoints
 *
 * REST Endpoints:
 * GET /apps/{appId}/jobs/{jobId} - Get job by ID
 * GET /apps/{appId}/jobs          - List jobs for an app
 */

import { implement } from "@orpc/server";
import { jobsContract } from "@tedix/api-contract/contracts/jobs";
import {
	countJobsByApp,
	getJobById,
	getJobsByApp,
} from "@tedix/db/queries/jobs";
import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
import type { JobStatus } from "@tedix/db/schema/jobs";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

// =============================================================================
// IMPLEMENTER
// =============================================================================

const jobsOs = implement(jobsContract).$context<BaseContext>();
const authedJobsOs = jobsOs.use(withAuth);

// =============================================================================
// PROCEDURES
// =============================================================================

/**
 * Get job by ID - GET /apps/{appId}/jobs/{jobId}
 */
export const getJobContract = authedJobsOs.getJob
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, jobId } = input;
		const orgId = requireOrgId(context);

		const app = await getAppByIdForOrganization(db, appId, orgId);
		if (!app) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}

		const job = await getJobById(db, jobId);
		if (!job) {
			throw createError(ErrorCodes.NOT_FOUND, "Job not found");
		}

		// Verify job belongs to app
		if (job.appId !== appId) {
			throw createError(ErrorCodes.NOT_FOUND, "Job not found");
		}

		return job;
	});

/**
 * List jobs for an app - GET /apps/{appId}/jobs
 */
export const listJobsContract = authedJobsOs.listJobs
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, status, limit, offset } = input;
		const orgId = requireOrgId(context);

		const app = await getAppByIdForOrganization(db, appId, orgId);
		if (!app) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}

		const statusFilter = status as JobStatus | undefined;

		const [data, total] = await Promise.all([
			getJobsByApp(db, appId, {
				status: statusFilter,
				limit: limit + 1,
				offset,
			}),
			countJobsByApp(db, appId, { status: statusFilter }),
		]);

		const hasMore = data.length > limit;
		const page = hasMore ? data.slice(0, limit) : data;

		return {
			data: page,
			pagination: {
				limit,
				offset,
				total,
				hasMore,
			},
		};
	});

// =============================================================================
// ROUTER
// =============================================================================

export const jobsContractRouter = authedJobsOs.router({
	getJob: getJobContract,
	listJobs: listJobsContract,
});
