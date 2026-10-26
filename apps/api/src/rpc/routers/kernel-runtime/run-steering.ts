import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { controlRuntimeRunSteering } from "@tedix/provisioning";
import { getProvisioningConfig } from "../tedis/helpers";
import type { BaseContext } from "../../orpc";
import { ErrorCodes, createError } from "../../orpc";
import type { KernelDO } from "../../../kernel/kernel-do";
import type {
	RuntimeRunSteeringInput,
	RunSteeringMessage,
} from "@tedix/api-contract/schemas/kernel-runtime";

export async function controlHomeRunSteering(
	context: BaseContext,
	run: Pick<
		KernelRuntimeRun,
		| "id"
		| "organizationId"
		| "conversationId"
		| "childRunId"
		| "childConversationId"
		| "delegatedTediId"
	>,
	command:
		| { action: "enqueue"; id: string; content: string }
		| { action: "inspect" | "withdraw" },
): Promise<RunSteeringMessage[]> {
	if (run.childRunId && run.delegatedTediId) {
		const tedi = await getTediByIdForOrganization(
			context.db,
			run.delegatedTediId,
			run.organizationId,
		);
		if (!tedi)
			throw createError(ErrorCodes.NOT_FOUND, "Delegated tedi not found");
		const config = getProvisioningConfig(tedi, context.env);
		if (!config || !run.childConversationId)
			throw createError(
				ErrorCodes.CONFLICT,
				"Delegated conversation is not ready for steering",
			);
		return (
			await controlRuntimeRunSteering(config, {
				...command,
				runId: run.childRunId,
				sessionKey: run.childConversationId,
			})
		).messages;
	}
	const kernel = (context.env as { KERNEL?: DurableObjectNamespace<KernelDO> })
		.KERNEL;
	if (!kernel)
		throw createError(
			ErrorCodes.CONFLICT,
			"Home runtime is unavailable for steering",
		);
	const input: RuntimeRunSteeringInput = {
		...command,
		runId: run.id,
		sessionKey: run.conversationId,
	};
	return kernel
		.get(kernel.idFromName(run.organizationId))
		.controlRunSteering(input);
}
