import {
	KernelRequestPolicySchema,
	KernelAcceptanceCheckSchema,
	type KernelAcceptanceCheck,
	type KernelRequestPolicy,
} from "@tedix/api-contract/schemas/kernel-request";
import {
	getKernelRequest,
	receiveKernelRequest,
	listDueKernelRequestsWithHomeRuns,
	transitionKernelRequests,
	type TransitionKernelRequestParams,
	publishKernelRequestReport,
	projectKernelRequestOnHomeRun,
} from "@tedix/db/queries/kernel-requests";
import type { KernelRequestRow } from "@tedix/db/schema/kernel-requests";
import {
	getKernelRuntimeRun,
	type KernelRuntimeRun,
} from "@tedix/db/queries/kernel-runtime-runs";
import { getActivePolicyPackDefinition } from "@tedix/db/queries/kernel-runtime-support";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";
import { toJsonRecord } from "@tedix/db/utils/json";
import { withD1Ledger } from "@tedix/db/slow-query";
import type { BaseContext } from "../rpc/orpc";
import { applyKernelRequestEvent, driveKernelRequest } from "./request-driver";
import {
	receivedKernelRequest,
	kernelRequestReportMessageId,
	kernelRequestAcceptanceReport,
	kernelWorkOrder,
} from "./request-coordinator";
import { kernelAcceptanceReader } from "./request-target-readers";

export async function readKernelRequestPolicy(
	context: Pick<BaseContext, "db">,
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
	sourceRun?: KernelRuntimeRun | null,
) {
	let row = initial;
	if (
		row.sourceKind !== "home" ||
		row.snapshot.state === "learned" ||
		row.snapshot.state === "cancelled"
	)
		return row;
	const run =
		sourceRun === undefined
			? await getKernelRuntimeRun(context.db, {
					id: row.sourceId,
					organizationId: row.organizationId,
				})
			: sourceRun;
	if (!run) return row;
	if (run.id !== row.sourceId || run.organizationId !== row.organizationId)
		throw new Error("Home source scope mismatch");
	const project = async () => {
		if (
			run.metadata?.kernelRequestId !== row.id ||
			JSON.stringify(run.metadata?.kernelRequestAcceptance) !==
				JSON.stringify(row.snapshot)
		)
			await projectKernelRequestOnHomeRun(context.db, row);
	};
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
			run,
		);
	}
	const [work, attempts] = await Promise.all([
		getWorkItemById(context.db, workItemId, row.organizationId),
		listWorkItemAttempts(context.db, {
			orgId: row.organizationId,
			workItemId,
			limit: 1,
		}),
	]);
	if (!work) return row;
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
	) {
		const checks: KernelAcceptanceCheck[] = row.snapshot.checks.length
			? row.snapshot.checks.map((c) => KernelAcceptanceCheckSchema.parse(c))
			: [{ kind: "home_response" }];
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{
				kind: "brief",
				revision: Math.max(work.version, row.snapshot.briefRevision + 1),
				checks,
				workOrder: kernelWorkOrder(work, checks, {
					kind: "home",
					sourceId: row.sourceId,
				}),
			},
			policy,
			now(),
		);
	}
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
		// Execution settlement can precede the ordinary child reply.
		// Wait for that durable reply without spending the target-probe retry budget.
		try {
			await reader.readHomeResponse!();
		} catch {
			await project();
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
							latest?.outcome === "expired" || latest?.outcome === "rejected"
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
					// A reply-only check is acknowledged by the reply itself. A separate
					// report would post an internal receipt key into the chat.
					if (
						current.snapshot.checks.every((c) => c.kind === "home_response")
					) {
						const receipt = await reader.readHomeResponse!();
						if (receipt.attemptId !== current.snapshot.attemptId)
							throw new Error("Home attempt superseded");
						return { status: "acknowledged", receiptRef: receipt.receiptRef };
					}
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
							content: kernelRequestAcceptanceReport(
								current.snapshot,
								workItemId,
							),
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
	await project();
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

async function measureReconcileStage<T>(
	stage: "policy" | "capture" | "due" | KernelRequestRow["sourceKind"],
	run: () => Promise<T>,
): Promise<T> {
	const startedAt = Date.now();
	let status = "failure";
	try {
		const result = await withD1Ledger(
			`kernel-request-reconcile.${stage}`,
			run,
			{
				alwaysLog: true,
			},
		);
		status = "success";
		return result;
	} finally {
		console.log({
			event: "kernel.request_reconcile.stage",
			stage,
			status,
			durationMs: Date.now() - startedAt,
		});
	}
}

export async function reconcileDueHomeKernelRequests(
	context: BaseContext,
	organizationId: string,
) {
	const policy = await measureReconcileStage("policy", () =>
		readKernelRequestPolicy(context, organizationId),
	);
	if (policy?.workAttemptDelivery)
		await measureReconcileStage("capture", async () =>
			(
				await import("./request-work-attempt-source")
			).captureDispatcherWorkAttempts(context, organizationId, policy),
		);
	const sources = await measureReconcileStage("due", () =>
		listDueKernelRequestsWithHomeRuns(context.db, {
			organizationId,
			now: new Date().toISOString(),
			limit: 20,
		}),
	);
	const rows = sources.map(({ request }) => request);
	const homeRuns = new Map(
		sources.map(({ request, homeRun }) => [request.id, homeRun]),
	);
	if (!policy) {
		// Preserve the configured interval already recorded on each request.
		// Paused tenants must yield the bounded cross-tenant recovery scan.
		const transitions = rows.map((row) => {
			const retryMs = Math.max(
				1000,
				Date.parse(row.nextDueAt!) - Date.parse(row.updatedAt),
			);
			return {
				...row,
				expectedVersion: row.version,
				eventId: `${row.id}:${row.version + 1}`,
				nextAction: "restore_request_coordinator_configuration",
				nextDueAt: new Date(Date.now() + retryMs).toISOString(),
				now: new Date().toISOString(),
			};
		});
		await transitionKernelRequests(context.db, transitions);
		return rows.length;
	}
	const deadline = Date.now() + policy.runBudgetMs;
	let recovered = 0;
	const transitions: TransitionKernelRequestParams[] = [];
	const reconcile = async (row: KernelRequestRow) => {
		if (Date.now() >= deadline) return;
		try {
			const updated = await measureReconcileStage(row.sourceKind, async () =>
				row.sourceKind === "home"
					? await reconcileHomeKernelRequest(
							context,
							row,
							policy,
							homeRuns.get(row.id),
						)
					: row.sourceKind === "work_attempt"
						? await (
								await import("./request-work-attempt-source")
							).reconcileWorkAttemptKernelRequest(context, row, policy)
						: await (
								await import("./request-local-source")
							).reconcileLocalKernelRequest(context, row, policy),
			);
			if (updated.version !== row.version) recovered++;
			if (updated.nextDueAt && updated.nextDueAt <= new Date().toISOString())
				transitions.push({
					...updated,
					expectedVersion: updated.version,
					eventId: `${updated.id}:${updated.version + 1}`,
					nextDueAt: new Date(Date.now() + policy.retryMs).toISOString(),
					now: new Date().toISOString(),
				});
		} catch (error) {
			// A reader can fail after a durable transition. Fence the current row,
			// not the stale input, and never reopen a request closed meanwhile.
			const current = await getKernelRequest(context.db, row);
			if (current?.nextDueAt && current.nextDueAt <= new Date().toISOString())
				transitions.push({
					...current,
					expectedVersion: current.version,
					eventId: `${current.id}:${current.version + 1}`,
					nextAction: "restore_request_reader",
					nextDueAt: new Date(Date.now() + policy.retryMs).toISOString(),
					now: new Date().toISOString(),
				});
			console.warn("[kernel-request] recovery deferred", {
				requestId: row.id,
				errorType: error instanceof Error ? error.name : "unknown",
			});
		}
	};
	// Only database-backed Home checks overlap. Repository probes and other
	// source adapters retain serial admission within the existing run budget.
	const databaseOnly = (row: KernelRequestRow) =>
		row.sourceKind === "home" &&
		row.snapshot.checks.every(
			(check) =>
				check.kind === "home_response" || check.kind === "os_output_revision",
		);
	const results = await Promise.allSettled([
		...rows.filter(databaseOnly).map(reconcile),
		(async () => {
			for (const row of rows.filter((row) => !databaseOnly(row)))
				await reconcile(row);
		})(),
	]);
	await transitionKernelRequests(context.db, transitions);
	const failures = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length)
		throw new AggregateError(failures, "Kernel request recovery failed");
	return recovered;
}
