import { HTTPException } from "hono/http-exception";
import { fileAgentReview } from "../../../services/agent-review";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authOs } from "./policy-helpers";

export const fileAgentReviewProcedure = authOs.fileAgentReview
	.use(withAuthorization("tedis:update", "mcp:work.write"))
	.handler(async ({ input, context }) => {
		try {
			const receipt = await fileAgentReview(
				context.db,
				context.env,
				input,
				requireOrgId(context),
			);
			return { receiptUrl: receipt.receiptUrl, status: receipt.status };
		} catch (error) {
			if (
				error instanceof HTTPException &&
				(error.status === 400 || error.status === 413)
			) {
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			}
			if (error instanceof HTTPException && error.status === 429) {
				throw createError(ErrorCodes.TOO_MANY_REQUESTS, error.message);
			}
			// Do not put database/provider error text or the report in RPC logs.
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Review intake unavailable; retry the identical payload",
			);
		}
	});
