import { HTTPException } from "hono/http-exception";
import { fileAgentReview } from "../../../services/agent-review";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import { authOs } from "./policy-helpers";

export const fileAgentReviewProcedure = authOs.fileAgentReview
	.use(withAuthorization("tedis:update", "mcp:work.write"))
	.handler(async ({ input, context }) => {
		// Share the anonymous intake's global wake-cost cap; RPC authentication
		// must not become a way around submission limits.
		let allowed: boolean;
		try {
			allowed = (
				await context.env.AGENT_REVIEW_RATE_LIMITER.limit({
					key: "agent-review:global",
				})
			).success;
		} catch {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Review intake unavailable",
			);
		}
		if (!allowed)
			throw createError(
				ErrorCodes.TOO_MANY_REQUESTS,
				"Review intake busy; retry after 60 seconds",
			);
		try {
			const receipt = await fileAgentReview(context.db, context.env, input);
			return { receiptUrl: receipt.receiptUrl, status: receipt.status };
		} catch (error) {
			if (
				error instanceof HTTPException &&
				(error.status === 400 || error.status === 413)
			) {
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			}
			// Do not put database/provider error text or the report in RPC logs.
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Review intake unavailable; retry the identical payload",
			);
		}
	});
