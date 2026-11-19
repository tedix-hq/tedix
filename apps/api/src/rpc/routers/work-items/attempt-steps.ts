/**
 * Run log and steering: a runner reports the steps of its run, people and
 * tedis read them, and the Work Item's owner or steward sends a follow-up or
 * stops the run.
 */

import {
	appendWorkAttemptSteps,
	listWorkAttemptSteps,
	sendWorkAttemptMessage,
} from "@tedix/db/queries/work-items/attempt-steps";
import { WORK_RUN_STEER_SCOPE } from "@tedix/api-contract/schemas/work-attempt-steps";
import type { WorkAttemptMessageRow } from "@tedix/db/schema/work-items";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../../orpc";
import { resolveAttemptIdentity } from "./factory-lifecycle";
import {
	assertWorkItemAccess,
	authOs,
	rethrowWorkItemWriteError,
	workItemStewardActor,
} from "./policy-helpers";

const runnerOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Only the executor holding the Attempt may report its steps; the handler checks organization scope and the Attempt fence",
		},
		"mcp:work.write",
	),
);
const readerOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The handler verifies Work Item organization access before reading the run's rows",
		},
		"mcp:work.read",
		WORK_RUN_STEER_SCOPE,
	),
);
const steeringOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The handler checks organization scope and requires the Work Item's owner or steward",
		},
		"mcp:work.write",
		WORK_RUN_STEER_SCOPE,
	),
);

function pendingMessage(row: WorkAttemptMessageRow) {
	return {
		id: row.id,
		kind: row.kind,
		body: row.body,
		senderType: row.senderType,
		senderId: row.senderId,
		interrupt: row.interrupt,
		createdAt: row.createdAt,
	};
}

function storedMessage(row: WorkAttemptMessageRow) {
	return {
		...pendingMessage(row),
		deliveredAt: row.deliveredAt,
		appliedAt: row.appliedAt,
	};
}

export const appendAttemptStepsProcedure = runnerOs.appendAttemptSteps.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const { executor, external } = await resolveAttemptIdentity(
			context,
			workItem.orgId,
		);
		try {
			const result = await appendWorkAttemptSteps(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: input.attemptId,
				executor: { type: executor.type, id: executor.id },
				sessionId:
					executor.type === "external_agent" ? executor.sessionId : undefined,
				externalSessionKey: external?.externalSessionKey,
				steps: input.steps,
				appliedMessageIds: input.appliedMessageIds,
			});
			// A question the run asks is passed to the chat that started the run.
			// Only a step stored by this call counts, so a retried report tells
			// the chat once; telling it must not delay or fail the runner.
			const stored = new Set(result.acceptedSeqs);
			const questions = input.steps.filter(
				(step) => step.kind === "question" && stored.has(step.seq),
			);
			if (questions.length && executor.type === "external_agent") {
				const { notifyAgentRunQuestion } =
					await import("../../../services/agent-run-ended-notice");
				const notices = Promise.all(
					questions.map((step) =>
						notifyAgentRunQuestion(context, workItem, {
							attemptId: input.attemptId,
							seq: step.seq,
							text: step.text,
							choices: step.choices,
						}),
					),
				);
				if (context.waitUntil) context.waitUntil(notices);
				else await notices;
			}
			return {
				accepted: result.accepted,
				pending: result.pending.map(pendingMessage),
			};
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const listAttemptStepsProcedure = readerOs.listAttemptSteps.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		try {
			const result = await listWorkAttemptSteps(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: input.attemptId,
				afterSeq: input.afterSeq,
				limit: input.limit,
			});
			return {
				attemptId: result.attemptId,
				live: result.live,
				steps: result.steps.map((step) => ({
					seq: step.seq,
					at: step.at,
					kind: step.kind,
					text: step.text,
					...(step.choices?.length ? { choices: step.choices } : {}),
				})),
				messages: result.messages.map(storedMessage),
			};
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

async function steerRun(
	context: BaseContext,
	params: {
		id: string;
		kind: "follow_up" | "stop";
		body: string;
		interrupt?: boolean;
	},
) {
	const workItem = await assertWorkItemAccess(context, params.id);
	// The same rule as completing the Work Item: its owner or steward. An
	// agent can never qualify here while its own run is still in progress.
	const actor = await workItemStewardActor(context, workItem, "completion");
	const message = await sendWorkAttemptMessage(context.db, {
		orgId: workItem.orgId,
		workItemId: workItem.id,
		kind: params.kind,
		body: params.body,
		sender: { type: actor.type, id: actor.id },
		interrupt: params.interrupt,
	});
	if (!message) throw createError(ErrorCodes.CONFLICT, "No run is in progress");
	return storedMessage(message);
}

export const sendAttemptMessageProcedure =
	steeringOs.sendAttemptMessage.handler(({ input, context }) =>
		steerRun(context, {
			id: input.id,
			kind: "follow_up",
			body: input.body,
			interrupt: input.interrupt,
		}),
	);

export const stopAttemptProcedure = steeringOs.stopAttempt.handler(
	({ input, context }) =>
		steerRun(context, { id: input.id, kind: "stop", body: "" }),
);
