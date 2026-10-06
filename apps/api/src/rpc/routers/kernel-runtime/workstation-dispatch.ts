import type { BaseContext } from "../../orpc";
import {
	type WorkstationDispatchTrigger,
	dispatchWorkstationWorkOrder,
} from "../kernel/workstation-dispatch";
import { recordHomeDelegationDispatchFailure } from "../kernel/run-store";
import { kernelDelegateRunner } from "./policy-normalization";

/** Dispatch an admitted work order through the certified workstation adapter. */
export function runWorkstationWorkOrderDispatch(
	context: BaseContext,
	input: {
		content: string;
		conversationId: string;
		delegateToTediId: string;
		existingMetadata?: Record<string, unknown> | null;
		existingRuntimeMetadata?: Record<string, unknown> | null;
		organizationId: string;
		runId: string;
		trigger: WorkstationDispatchTrigger;
		userMessageId: string;
		workItemId?: string | null;
		workOrder: Record<string, unknown> | null;
	},
) {
	return dispatchWorkstationWorkOrder(
		{
			db: context.db,
			enqueue: (args) =>
				kernelDelegateRunner({
					context,
					childRunId: args.childRunId,
					content: args.content,
					delegateToTediId: args.delegateToTediId,
					metadata: args.metadata,
				}),
			recordDispatchFailure: (args) =>
				recordHomeDelegationDispatchFailure(context, args),
		},
		{
			content: input.content,
			conversationId: input.conversationId,
			existingMetadata: input.existingMetadata,
			existingRuntimeMetadata: input.existingRuntimeMetadata,
			organizationId: input.organizationId,
			runId: input.runId,
			targetTediId: input.delegateToTediId,
			trigger: input.trigger,
			userMessageId: input.userMessageId,
			workItemId: input.workItemId,
			workOrder: input.workOrder,
		},
	);
}
