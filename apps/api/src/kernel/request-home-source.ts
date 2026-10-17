import {
	KernelRequestPolicySchema,
	KernelAcceptanceCheckSchema,
	type KernelAcceptanceCheck,
	type KernelRequestPolicy,
} from "@tedix/api-contract/schemas/kernel-request";
import {
	getKernelRequest,
	receiveKernelRequest,
	listDueKernelRequests,
	transitionKernelRequest,
	publishKernelRequestReport,
	projectKernelRequestOnHomeRun,
} from "@tedix/db/queries/kernel-requests";
import type { KernelRequestRow } from "@tedix/db/schema/kernel-requests";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getActivePolicyPackDefinition } from "@tedix/db/queries/kernel-runtime-support";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { BaseContext } from "../rpc/orpc";
import { applyKernelRequestEvent, driveKernelRequest } from "./request-driver";
import {
	receivedKernelRequest,
	kernelRequestReportMessageId,
} from "./request-coordinator";
import { kernelAcceptanceReader } from "./request-target-readers";

export async function readKernelRequestPolicy(
	context: BaseContext,
	organizationId: string,
) {
	const definition = await getActivePolicyPackDefinition(
		context.db,
		organizationId,
	);
	if (definition?.kernelRequestCoordinator === undefined) return null;
	const policy = KernelRequestPolicySchema.parse(
		definition.kernelRequestCoordinator,
	);
	return policy.enabled ? policy : null;
}

/** Called after ingress auth and before planner/model work; private text stays in the source. */
export async function captureHomeKernelRequest(
	context: BaseContext,
	p: {
		organizationId: string;
		runId: string;
		conversationId: string;
		checks?: KernelAcceptanceCheck[];
	},
) {
	const ownerUserId = context.descopeUserId ?? context.user?.sub;
	if (!ownerUserId) {
		if (p.checks?.length)
			throw new Error("Acceptance requires an authenticated source owner");
		return;
	}
	const policy = await readKernelRequestPolicy(context, p.organizationId);
	if (!policy || policy.homeCaptureEnabled === false) {
		if (p.checks?.length)
			throw new Error("Kernel request acceptance is not configured");
		return;
	}
	const now = new Date().toISOString();
	if (
		policy.homeConversationIds &&
		!policy.homeConversationIds.includes(p.conversationId)
	) {
		if (p.checks?.length)
			throw new Error(
				"Conversation is outside the configured acceptance cohort",
			);
		return;
	}
	const row = await receiveKernelRequest(context.db, {
		id: `home:${p.runId}`,
		organizationId: p.organizationId,
		ownerUserId,
		sourceKind: "home",
		sourceId: p.runId,
		conversationId: p.conversationId,
		snapshot: { ...receivedKernelRequest(), checks: p.checks ?? [] },
		nextOwner: policy.nextOwner,
		nextAction: "file_request",
		nextDueAt: new Date(Date.now() + policy.retryMs).toISOString(),
		lastEventId: `home:${p.runId}:1`,
		createdAt: now,
		updatedAt: now,
	});
	return row?.id;
}

/** Execution links come from canonical Work or the admitted Home submission. */
export async function reconcileHomeKernelRequest(
	context: BaseContext,
	initial: KernelRequestRow,
	policy: KernelRequestPolicy,
) {
	let row = initial;
	if (
		row.sourceKind !== "home" ||
		row.snapshot.state === "learned" ||
		row.snapshot.state === "cancelled"
	)
		return row;
	const run = await getKernelRuntimeRun(context.db, {
		id: row.sourceId,
		organizationId: row.organizationId,
	});
	if (!run) return row;
	const workItemId =
		run.metadata?.workItemId ?? run.runtimeMetadata?.workItemId;
	if (typeof workItemId !== "string") {
		// Delegations must retain their canonical Work ownership, including while
		// dispatch is still establishing its link. Native answers use Home's ledger.
		if (run.delegatedTediId || run.childRunId || row.snapshot.workItemId)
			return row;
		return (await import("./request-home-native")).reconcileNativeHomeRequest(
			context,
			row,
			policy,
		);
	}
	const work = await getWorkItemById(
		context.db,
		workItemId,
		row.organizationId,
	);
	if (!work) return row;
	const attempts = await listWorkItemAttempts(context.db, {
		orgId: row.organizationId,
		workItemId,
		limit: 1,
	});
	const attempt = attempts.data[0];
	const now = () => new Date().toISOString();
	if (row.snapshot.state === "received")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "file", workItemId },
			policy,
			now(),
		);
	if (
		row.snapshot.state === "filed" ||
		(row.snapshot.state === "verifying" && row.snapshot.checks.length === 0)
	)
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{
				kind: "brief",
				revision: Math.max(work.version, row.snapshot.briefRevision + 1),
				checks: row.snapshot.checks.length
					? row.snapshot.checks.map((c) => KernelAcceptanceCheckSchema.parse(c))
					: [{ kind: "home_response" }],
			},
			policy,
			now(),
		);
	if (!attempt) return row;
	if (row.snapshot.state === "briefed")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "start", attemptId: attempt.id },
			policy,
			now(),
		);
	if (row.snapshot.attemptId && row.snapshot.attemptId !== attempt.id)
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{
				kind: "successor",
				previousAttemptId: row.snapshot.attemptId,
				attemptId: attempt.id,
			},
			policy,
			now(),
		);
	const reader = kernelAcceptanceReader(context, row, policy);
	if (
		attempt.outcome === "succeeded" &&
		row.snapshot.checks.every((c) => c.kind === "home_response") &&
		(row.snapshot.state === "running" || row.snapshot.state === "verifying") &&
		!row.snapshot.delivery
	) {
		// Completion reconciliation runs before the ordinary child reply is written.
		// Wait for that durable reply without spending the target-probe retry budget.
		try {
			await reader.readHomeResponse!();
		} catch {
			await projectKernelRequestOnHomeRun(context.db, row);
			return row;
		}
	}
	row =
		(await driveKernelRequest(
			context.db,
			row,
			policy,
			{
				readExecution: async () => {
					const latest = (
						await listWorkItemAttempts(context.db, {
							orgId: row.organizationId,
							workItemId,
							limit: 1,
						})
					).data[0];
					return {
						attemptId: latest?.id ?? "unavailable",
						outcome:
							latest?.outcome === "expired"
								? "failed"
								: (latest?.outcome ?? null),
					};
				},
				deliverReport: async (current, intentId) => {
					// The source is read again immediately before delivery; target readers already checked its ACLs.
					const fresh = await getKernelRequest(context.db, current);
					if (
						fresh?.snapshot.acceptanceKey !== current.snapshot.acceptanceKey ||
						fresh.snapshot.delivery?.intentId !== intentId
					)
						throw new Error("Acceptance superseded before delivery");
					const event = await publishKernelRequestReport(context.db, {
						...current,
						expectedVersion: current.version,
						acceptanceKey: current.snapshot.acceptanceKey!,
						attemptId: current.snapshot.attemptId!,
						workItemId,
						intentId,
						conversationId: current.conversationId!,
						runId: current.sourceId,
						messageId: kernelRequestReportMessageId(current.sourceId),
						now: now(),
						payload: {
							role: "assistant",
							channel: "home",
							content: `${current.snapshot.checks.every((c) => c.kind === "home_response") ? "Confirmed durable Home reply delivery only; factual correctness and external target state are not verified." : "Verified the requested target state."} ${current.snapshot.observations.flatMap((o) => o.evidenceRefs).join("\n")}`,
							metadata: {
								kernelRequestAcceptance: toJsonRecord(current.snapshot),
								requestId: current.id,
							},
						},
					});
					if (!event) throw new Error("Source report was not acknowledged");
					await (
						await import("../rpc/routers/kernel/conversation-index")
					).applyKernelConversationEvent(context.db, event);
					return { status: "acknowledged", receiptRef: event.id };
				},
			},
			reader,
			now,
		)) ?? row;
	await projectKernelRequestOnHomeRun(context.db, row);
	if (
		row.snapshot.state === "verifying" &&
		(row.snapshot.outcome === "failed" ||
			(row.snapshot.probeAttempts ?? 0) >= policy.maxProbeAttempts)
	) {
		await addWorkItemCommentIfAbsent(context.db, {
			id: `${row.id}:${row.snapshot.acceptanceKey}:repair`,
			orgId: row.organizationId,
			workItemId,
			authorType: "system",
			body: `Kernel acceptance ${row.snapshot.outcome}. Next owner: ${policy.nextOwner}. Repair the named target or restore its reader through a freshly admitted corrective execution. Preserve this request and prior execution settlement. Detailed checks remain in the originating conversation.`,
			createdAt: now(),
		});
	}
	return row;
}

export async function reconcileDueHomeKernelRequests(
	context: BaseContext,
	organizationId: string,
) {
	const policy = await readKernelRequestPolicy(context, organizationId);
	const rows = await listDueKernelRequests(context.db, {
		organizationId,
		now: new Date().toISOString(),
		limit: 20,
	});
	if (!policy) {
		// Preserve the configured interval already recorded on each request.
		// Paused tenants must yield the bounded cross-tenant recovery scan.
		for (const row of rows) {
			const retryMs = Math.max(
				1000,
				Date.parse(row.nextDueAt!) - Date.parse(row.updatedAt),
			);
			await transitionKernelRequest(context.db, {
				...row,
				expectedVersion: row.version,
				eventId: `${row.id}:${row.version + 1}`,
				nextAction: "restore_request_coordinator_configuration",
				nextDueAt: new Date(Date.now() + retryMs).toISOString(),
				now: new Date().toISOString(),
			});
		}
		return rows.length;
	}
	const deadline = Date.now() + policy.runBudgetMs;
	for (const row of rows) {
		if (Date.now() >= deadline) break;
		try {
			const updated =
				row.sourceKind === "home"
					? await reconcileHomeKernelRequest(context, row, policy)
					: await (
							await import("./request-local-source")
						).reconcileLocalKernelRequest(context, row, policy);
			if (updated.nextDueAt && updated.nextDueAt <= new Date().toISOString())
				await transitionKernelRequest(context.db, {
					...updated,
					expectedVersion: updated.version,
					eventId: `${updated.id}:${updated.version + 1}`,
					nextDueAt: new Date(Date.now() + policy.retryMs).toISOString(),
					now: new Date().toISOString(),
				});
		} catch (error) {
			await transitionKernelRequest(context.db, {
				...row,
				expectedVersion: row.version,
				eventId: `${row.id}:${row.version + 1}`,
				nextAction: "restore_request_reader",
				nextDueAt: new Date(Date.now() + policy.retryMs).toISOString(),
				now: new Date().toISOString(),
			});
			console.warn("[kernel-request] recovery deferred", {
				requestId: row.id,
				errorType: error instanceof Error ? error.name : "unknown",
			});
		}
	}
	return rows.length;
}
