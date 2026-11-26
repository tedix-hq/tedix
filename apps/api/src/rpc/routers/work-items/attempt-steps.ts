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
import { workItemCreatedByActor } from "@tedix/db/queries/work-items/specification-access";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import { findWorkToolApprovalWait } from "@tedix/db/queries/work-items/tool-approval-wait";
import { verifiedActiveWorkActor } from "../work-items-principal";
import { WORK_RUN_STEER_SCOPE } from "@tedix/api-contract/schemas/work-attempt-steps";
import type {
	WorkAttemptMessageRow,
	WorkItem,
} from "@tedix/db/schema/work-items";
import { writeRunSteeringRecord } from "../../../services/machine-change-records";
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
				"The handler checks organization scope and requires the owner, steward or live delegating parent Attempt",
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
			return {
				approvalWait:
					executor.type === "external_agent"
						? await findWorkToolApprovalWait(context.db, {
								orgId: workItem.orgId,
								workItemId: workItem.id,
								workVersion: workItem.version,
								attemptId: input.attemptId,
								now: new Date().toISOString(),
							})
						: undefined,
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

/**
 * A run that ended on a question waits for its answer, and the person who
 * created the Work Item may give it even when they are not its owner or
 * steward: the message only resumes that run. Live-run steering and stops
 * still require the steward path, so this fallback applies solely to an
 * unanswered question on the newest ended run of the current Work version.
 */
async function creatorRunAnswerActor(
	context: BaseContext,
	workItem: WorkItem,
	denied: unknown,
) {
	if (!isRecord(denied) || denied.code !== ErrorCodes.FORBIDDEN) throw denied;
	if (workItem.disposition !== "accepted") throw denied;
	const actor = await verifiedActiveWorkActor(context, workItem.orgId);
	const run = await listWorkAttemptSteps(context.db, {
		orgId: workItem.orgId,
		workItemId: workItem.id,
	});
	const continuation = workItem.metadata?.questionContinuation;
	const answered =
		isRecord(continuation) && continuation.attemptId === run.attemptId;
	if (
		run.live ||
		!run.attemptId ||
		run.questionVersion !== workItem.version ||
		answered ||
		!(await workItemCreatedByActor(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			actor: { type: actor.type, id: actor.id },
		}))
	)
		throw denied;
	return actor;
}

async function steerRun(
	context: BaseContext,
	params: {
		id: string;
		attemptId?: string;
		kind: "follow_up" | "stop";
		body: string;
		interrupt?: boolean;
	},
) {
	const workItem = await assertWorkItemAccess(context, params.id);
	let actor;
	const delegation = workItem.metadata?.childDelegation as
		| { parentAttemptId?: string }
		| undefined;
	if (
		delegation?.parentAttemptId &&
		workItem.parentWorkItemId &&
		(context.externalAgentPrincipalId ||
			context.ownerHostSessionId ||
			context.tediId)
	) {
		const parent = await verifiedActiveWorkActor(context, workItem.orgId);
		if (parent.type !== "user") {
			await getAuthoritativeWorkItemAttempt(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.parentWorkItemId,
				attemptId: delegation.parentAttemptId,
				executor: parent,
				sessionId: parent.sessionId,
				externalSessionKey:
					parent.type === "external_agent"
						? parent.externalSessionKey
						: undefined,
			});
			actor = parent;
		}
	}
	actor ??= await workItemStewardActor(context, workItem, "completion").catch(
		(error) =>
			params.kind === "follow_up"
				? creatorRunAnswerActor(context, workItem, error)
				: Promise.reject(error),
	);
	const message = await sendWorkAttemptMessage(context.db, {
		orgId: workItem.orgId,
		workItemId: workItem.id,
		attemptId: params.attemptId,
		kind: params.kind,
		body: params.body,
		sender: { type: actor.type, id: actor.id },
		interrupt: params.interrupt,
	});
	if (!message)
		throw createError(
			ErrorCodes.CONFLICT,
			params.kind === "stop"
				? "No run is in progress"
				: "This run no longer accepts a message",
		);
	// A tedi steers over the tedi runtime's service binding, which the MCP
	// gateway never sees, so its steering is recorded here. A member steering
	// through the gateway is recorded there; one steering from the app is not
	// recorded yet.
	if (actor.type === "tedi")
		await writeRunSteeringRecord({
			orgId: workItem.orgId,
			workItemId: workItem.id,
			messageId: message.id,
			tediId: actor.id,
			kind: params.kind,
			interrupt: message.interrupt,
			body: params.body,
		});
	return storedMessage(message);
}

export const sendAttemptMessageProcedure =
	steeringOs.sendAttemptMessage.handler(({ input, context }) =>
		steerRun(context, {
			id: input.id,
			kind: "follow_up",
			attemptId: input.attemptId,
			body: input.body,
			interrupt: input.interrupt,
		}),
	);

export const stopAttemptProcedure = steeringOs.stopAttempt.handler(
	({ input, context }) =>
		steerRun(context, { id: input.id, kind: "stop", body: "" }),
);
