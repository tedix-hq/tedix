import {
	CreateFactoryInputSchema,
	FactoryControlInputSchema,
} from "@tedix/api-contract/schemas/factories";
import { getApprovalRequestById } from "@tedix/db/queries/approvals";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { canonicalJson } from "../lib/blueprint-digest";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";

/** Only a saved human approval for this exact factory call earns operator authority. */
export async function factoryApprovalContext(
	context: BaseContext,
	callable: string,
	input: unknown,
): Promise<BaseContext> {
	const id = context.headers.get("X-Tedix-Approved-Factory-Request");
	if (!id || context.authType !== "service-binding" || context.tediId)
		return context;
	const approval = await getApprovalRequestById(context.db, id);
	const payload = approval?.payload;
	const schema =
		callable === "projects.create_factory"
			? CreateFactoryInputSchema
			: FactoryControlInputSchema;
	const stored = schema.safeParse(payload?.args);
	const current = schema.safeParse(input);
	if (
		!approval ||
		approval.orgId !== context.organizationId ||
		approval.status !== "approved" ||
		!approval.resolvedBy ||
		approval.resolvedBy === "policy" ||
		payload?.kind !== "home_tool_write" ||
		payload.toolName !== callable ||
		payload.organizationId !== context.organizationId ||
		payload.initiatedByUserId !== context.descopeUserId ||
		!stored.success ||
		!current.success ||
		canonicalJson(stored.data) !== canonicalJson(current.data)
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Factory operation does not match its saved human approval",
		);
	}
	const run =
		typeof payload.homeRunId === "string"
			? await getKernelRuntimeRun(context.db, {
					id: payload.homeRunId,
					organizationId: approval.orgId,
				})
			: null;
	if (
		run?.status !== "running" ||
		run.conversationId !== payload.conversationId ||
		!run.metadata?.kernelWriteExecutedAt
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Factory approval is not executing in its claimed Home run",
		);
	return {
		...context,
		factoryOperatorApproval: { requestId: id, userId: approval.resolvedBy },
	};
}
