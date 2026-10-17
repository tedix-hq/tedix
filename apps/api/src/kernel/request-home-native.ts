import type { KernelRequestPolicy } from "@tedix/api-contract/schemas/kernel-request";
import type { KernelRequestRow } from "@tedix/db/schema/kernel-requests";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import {
	listSubmissionsByRun,
	listAttemptsBySubmission,
} from "@tedix/db/queries/runtime-submissions/read-models";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	getKernelRequest,
	projectKernelRequestOnHomeRun,
} from "@tedix/db/queries/kernel-requests";
import type { BaseContext } from "../rpc/orpc";
import { resolveKernelConversationAccess } from "./conversation-access";
import { applyKernelRequestEvent, driveKernelRequest } from "./request-driver";
import { kernelAcceptanceReader } from "./request-target-readers";

/** Direct Home turns already have admitted submissions; do not invent a tedi or Work Attempt. */
export async function reconcileNativeHomeRequest(
	context: BaseContext,
	initial: KernelRequestRow,
	policy: KernelRequestPolicy,
) {
	async function readExecution() {
		const submission = (
			await listSubmissionsByRun(
				context.db,
				initial.organizationId,
				initial.sourceId,
			)
		).find(
			(s) =>
				s.subjectKind === "kernel" &&
				s.sourceKind === "home" &&
				s.conversationId === initial.conversationId,
		);
		if (!submission?.currentAttemptId) return null;
		const attempts = await listAttemptsBySubmission(context.db, submission.id);
		const attempt = attempts.at(-1);
		if (
			!attempt ||
			attempt.id !== submission.currentAttemptId ||
			attempt.organizationId !== initial.organizationId
		)
			return null;
		const outcome =
			submission.status === "settled" && attempt.status === "settled"
				? ("succeeded" as const)
				: submission.status === "failed" && attempt.status === "failed"
					? ("failed" as const)
					: submission.status === "canceled" && attempt.status === "canceled"
						? ("cancelled" as const)
						: null;
		return { attemptId: attempt.id, outcome, startedAt: attempt.startedAt };
	}
	async function readHomeResponse() {
		const member = await getMemberByUserId(
			context.db,
			initial.organizationId,
			initial.ownerUserId,
		);
		if (
			member?.status !== "active" ||
			!initial.conversationId ||
			!(
				await resolveKernelConversationAccess(context.db, {
					organizationId: initial.organizationId,
					conversationId: initial.conversationId,
					descopeUserId: initial.ownerUserId,
					required: "read",
				})
			).allowed
		)
			throw new Error("Home source access unavailable");
		const execution = await readExecution();
		const run = await getKernelRuntimeRun(context.db, {
			organizationId: initial.organizationId,
			id: initial.sourceId,
		});
		if (
			execution?.outcome !== "succeeded" ||
			run?.status !== "completed" ||
			run.conversationId !== initial.conversationId ||
			run.delegatedTediId ||
			run.childRunId ||
			!run.outputMessageId
		)
			throw new Error("Native Home response is not settled");
		const events = await listKernelRuntimeEvents(context.db, {
			organizationId: initial.organizationId,
			runId: initial.sourceId,
			order: "desc",
			limit: 100,
		});
		const response = events.find(
			(e) =>
				e.kind === "message.completed" &&
				e.conversationId === initial.conversationId &&
				e.messageId === run.outputMessageId &&
				e.payload?.role === "assistant" &&
				typeof e.payload.content === "string" &&
				e.payload.content.trim().length > 0 &&
				Date.parse(e.createdAt) >= Date.parse(execution.startedAt),
		);
		if (!response) throw new Error("Durable Home reply unavailable");
		return { attemptId: execution.attemptId, receiptRef: response.id };
	}
	const execution = await readExecution();
	if (!execution) return initial;
	const now = () => new Date().toISOString();
	let row = initial;
	if (row.snapshot.state === "received")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "file", workItemId: null },
			policy,
			now(),
		);
	if (row.snapshot.state === "filed")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{
				kind: "brief",
				revision: 1,
				checks: row.snapshot.checks.length
					? row.snapshot.checks
					: [{ kind: "home_response" }],
			},
			policy,
			now(),
		);
	if (row.snapshot.state === "briefed")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "start", attemptId: execution.attemptId },
			policy,
			now(),
		);
	if (row.snapshot.attemptId && row.snapshot.attemptId !== execution.attemptId)
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{
				kind: "successor",
				previousAttemptId: row.snapshot.attemptId,
				attemptId: execution.attemptId,
			},
			policy,
			now(),
		);
	row =
		(await driveKernelRequest(
			context.db,
			row,
			policy,
			{
				readExecution: async () =>
					(await readExecution()) ?? {
						attemptId: "unavailable",
						outcome: null,
					},
				deliverReport: async (current, intentId) => {
					const fresh = await getKernelRequest(context.db, current);
					if (
						fresh?.version !== current.version ||
						fresh.snapshot.delivery?.intentId !== intentId
					)
						throw new Error("Home acknowledgment superseded");
					const receipt = await readHomeResponse();
					if (receipt.attemptId !== current.snapshot.attemptId)
						throw new Error("Home attempt superseded");
					return { status: "acknowledged", receiptRef: receipt.receiptRef };
				},
			},
			{ ...kernelAcceptanceReader(context, row, policy), readHomeResponse },
			now,
		)) ?? row;
	await projectKernelRequestOnHomeRun(context.db, row);
	return row;
}
