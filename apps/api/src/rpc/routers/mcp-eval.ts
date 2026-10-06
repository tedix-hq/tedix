/**
 * MCP Eval Router
 *
 * Starts async LLM-powered MCP eval workflows and returns jobId for polling.
 */

import { implement } from "@orpc/server";
import { mcpEvalContract } from "@tedix/api-contract/contracts/mcp-eval";
import { createJob } from "@tedix/db/queries/jobs";
import { getAppBySlug } from "@tedix/db/queries/apps";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

const mcpEvalOs = implement(mcpEvalContract).$context<BaseContext>();
const authed = mcpEvalOs.use(withAuth).use(withFleetAuthority);

const TEDIX_ADMIN_APP_SLUG = "tedix";

export const mcpEvalContractRouter = mcpEvalOs.router({
	run: authed.run
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			const { appSlug, model, customTests } = input;
			const { db, env } = context;

			if (!env.MCP_EVAL_WORKFLOW) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"MCP_EVAL_WORKFLOW not configured",
				);
			}

			const adminApp = await getAppBySlug(db, TEDIX_ADMIN_APP_SLUG);
			if (!adminApp) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					`Tedix admin app "${TEDIX_ADMIN_APP_SLUG}" is not provisioned`,
				);
			}
			const job = await createJob(db, {
				type: "mcp_eval",
				appId: adminApp.id,
				payload: toJsonRecord({ appSlug, model, customTests }),
			});

			// Start workflow
			await env.MCP_EVAL_WORKFLOW.create({
				id: job.id,
				params: {
					jobId: job.id,
					appSlug,
					model,
					customTests,
				},
			});

			return {
				jobId: job.id,
				status: "pending" as const,
				message: `MCP eval started for ${appSlug}. Poll with get_job_status (appId: ${adminApp.id}, jobId: ${job.id})`,
			};
		}),
});
