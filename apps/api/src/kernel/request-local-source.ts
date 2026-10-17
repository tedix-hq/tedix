import type {
	KernelAcceptanceCheck,
	KernelRequestPolicy,
} from "@tedix/api-contract/schemas/kernel-request";
import type { AgentSessionRequestRow } from "@tedix/db/schema/agent-session-requests";
import type { KernelRequestRow } from "@tedix/db/schema/kernel-requests";
import type { WorkAgentSessionHarness } from "@tedix/db/schema/work-agent-sessions";
import { getAgentSessionRequest } from "@tedix/db/queries/agent-session-requests";
import {
	getKernelRequest,
	receiveKernelRequest,
	listLocalRequestsForKernelCapture,
	publishLocalKernelRequestReport,
} from "@tedix/db/queries/kernel-requests";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import type { BaseContext } from "../rpc/orpc";
import { applyKernelRequestEvent, driveKernelRequest } from "./request-driver";
import { receivedKernelRequest } from "./request-coordinator";
import { readKernelRequestPolicy } from "./request-home-source";
import { kernelAcceptanceReader } from "./request-target-readers";

async function capture(
	context: BaseContext,
	source: AgentSessionRequestRow,
	policy: KernelRequestPolicy,
) {
	const now = new Date().toISOString();
	return receiveKernelRequest(context.db, {
		id: `agent:${source.id}`,
		organizationId: source.organizationId,
		ownerUserId: source.userId,
		sourceKind: "agent_session_request",
		sourceId: source.id,
		snapshot: receivedKernelRequest(),
		nextOwner: policy.nextOwner,
		nextAction: "file_request",
		nextDueAt: new Date(Date.now() + policy.retryMs).toISOString(),
		lastEventId: `agent:${source.id}:1`,
		createdAt: now,
		updatedAt: now,
	});
}

/** Source text remains in its private ledger; only identities enter the coordinator. */
export async function captureLocalKernelRequests(
	context: BaseContext,
	scope: {
		organizationId: string;
		userId: string;
		harness: WorkAgentSessionHarness;
		sessionKey: string;
		sourceAt: string;
	},
) {
	if ((context.user?.sub ?? context.descopeUserId) !== scope.userId)
		throw new Error("Private request owner mismatch");
	const policy = await readKernelRequestPolicy(context, scope.organizationId);
	if (!policy) return;
	if (
		policy.localSessionKeys &&
		!policy.localSessionKeys.includes(scope.sessionKey)
	)
		return;
	for (const source of await listLocalRequestsForKernelCapture(
		context.db,
		scope,
	)) {
		if (source.kind !== "ask") await capture(context, source, policy);
	}
}

export async function bindLocalKernelRequest(
	context: BaseContext,
	source: AgentSessionRequestRow,
	workItemId: string,
	checks: KernelAcceptanceCheck[],
) {
	if ((context.user?.sub ?? context.descopeUserId) !== source.userId)
		throw new Error("Private request owner mismatch");
	const policy = await readKernelRequestPolicy(context, source.organizationId);
	if (!policy) throw new Error("Kernel request acceptance is not configured");
	if (
		policy.localSessionKeys &&
		!policy.localSessionKeys.includes(source.sessionKey)
	)
		throw new Error("Session is outside the configured acceptance cohort");
	const work = await getWorkItemById(
		context.db,
		workItemId,
		source.organizationId,
	);
	if (!work || work.projectId !== source.projectId)
		throw new Error(
			"Request and Work must share the same organization and filed project",
		);
	let row = await capture(context, source, policy);
	if (!row) throw new Error("Private source ownership unavailable");
	if (row.snapshot.workItemId && row.snapshot.workItemId !== workItemId)
		throw new Error("Request already belongs to another canonical Work");
	const now = new Date().toISOString();
	if (row.snapshot.state === "received")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "file", workItemId },
			policy,
			now,
		);
	if (row.snapshot.state === "filed")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "brief", revision: work.version, checks },
			policy,
			now,
		);
	return row;
}

export async function reconcileLocalKernelRequest(
	context: BaseContext,
	initial: KernelRequestRow,
	policy: KernelRequestPolicy,
) {
	let row = initial;
	const source = await getAgentSessionRequest(context.db, {
		organizationId: row.organizationId,
		userId: row.ownerUserId,
		id: row.sourceId,
	});
	if (
		!source ||
		row.snapshot.state === "learned" ||
		row.snapshot.state === "cancelled"
	)
		return row;
	const now = () => new Date().toISOString();
	if (source.status === "cancelled")
		return applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "cancel", attemptId: row.snapshot.attemptId },
			policy,
			now(),
		);
	const workItemId = row.snapshot.workItemId;
	if (!workItemId) return row;
	const work = await getWorkItemById(
		context.db,
		workItemId,
		row.organizationId,
	);
	if (!work || work.projectId !== source.projectId) return row;
	const readExecution = async () => {
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
					? ("failed" as const)
					: (latest?.outcome ?? null),
		};
	};
	const latest = await readExecution();
	if (latest.attemptId === "unavailable") return row;
	if (row.snapshot.state === "briefed")
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{ kind: "start", attemptId: latest.attemptId },
			policy,
			now(),
		);
	if (row.snapshot.attemptId && row.snapshot.attemptId !== latest.attemptId)
		row = await applyKernelRequestEvent(
			context.db,
			row,
			{
				kind: "successor",
				previousAttemptId: row.snapshot.attemptId,
				attemptId: latest.attemptId,
			},
			policy,
			now(),
		);
	return (
		(await driveKernelRequest(
			context.db,
			row,
			policy,
			{
				readExecution,
				deliverReport: async (current, intentId) => {
					const fresh = await getKernelRequest(context.db, current);
					if (fresh?.snapshot.acceptanceKey !== current.snapshot.acceptanceKey)
						throw new Error("Request superseded");
					const saved = await publishLocalKernelRequestReport(context.db, {
						...current,
						expectedVersion: current.version,
						acceptanceKey: current.snapshot.acceptanceKey!,
						attemptId: current.snapshot.attemptId!,
						workItemId,
						intentId,
						evidence: `Kernel verified: ${current.snapshot.observations.flatMap((o) => o.evidenceRefs).join(", ")}. Originating chat delivery unavailable.`,
						now: now(),
					});
					if (!saved) throw new Error("Private source receipt unavailable");
					return {
						status: "unavailable",
						receiptRef: `private-request:${saved.id}; originating-chat-delivery-unavailable`,
					};
				},
			},
			kernelAcceptanceReader(context, row, policy),
			now,
		)) ?? row
	);
}
