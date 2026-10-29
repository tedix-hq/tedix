import { createRouterClient } from "@orpc/server";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import type { BaseContext } from "../../orpc";
import type {
	HomeToolWritePayload,
	KernelWriteExecutionResult,
} from "./write-executor";

/** Execute only after the stored Home write has passed approval and its claim. */
export async function executeOwnerSkillCertification(
	context: BaseContext,
	payload: HomeToolWritePayload,
): Promise<KernelWriteExecutionResult | null> {
	if (
		payload.toolName !== "skills.run_workflow" ||
		payload.args.certification !== true
	)
		return null;
	// Keep the original authenticated caller. A receipt or an initiating user id
	// alone cannot turn a tedi, service, or external agent into a human owner.
	if (
		context.authType !== "user" ||
		!context.user?.sub ||
		context.user.sub !== payload.initiatedByUserId ||
		context.organizationId !== payload.organizationId ||
		context.tediId ||
		context.externalAgentPrincipalId ||
		payload.initiatedByAgentPrincipalId
	)
		return {
			ok: false,
			error: "Certification requires the initiating signed-in owner or admin.",
		};
	const member = await getMemberByUserId(
		context.db,
		payload.organizationId,
		context.user.sub,
	);
	if (member?.status !== "active" || !["owner", "admin"].includes(member.role))
		return {
			ok: false,
			error: "Certification requires an active organization owner or admin.",
		};
	if (
		typeof payload.args.tediId !== "string" ||
		typeof payload.args.expectedSkillRevision !== "number" ||
		typeof payload.args.idempotencyKey !== "string"
	)
		return {
			ok: false,
			error: "Request a new test pinned to the current skill version.",
		};
	const { skillsRunWorkflow } =
		await import("../cognitive-skill-runs/run-start");
	const run = createRouterClient(skillsRunWorkflow, { context });
	// The procedure still checks ownership, revision, permissions and dispatch.
	const data = await run({ ...payload.args, tediId: payload.args.tediId });
	return { ok: true, data };
}
