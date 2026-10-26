/** Durable approval mirrors and blocked-descendant escalation alarms. */
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/context";
import type { KernelState } from "./kernel-state";

interface BlockedDescendantsHost {
	storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
	readonly state: KernelState;
	idName: string | undefined;
	env: CloudflareEnv;
	setState(state: KernelState): void;
	turnContext(): Promise<BaseContext>;
	ensureStorageAlarm(targetMs: number): Promise<void>;
}

const BLOCKED_DESCENDANT_GRACE_MS = 90_000;
const BLOCKED_DESCENDANT_KEY = "blockedDescendantApprovals";

interface BlockedDescendantApproval {
	id: string;
	parentConversationId: string;
	childRunId: string;
	approvalRequestId: string;
	delegatedTediId: string | null;
	status: "pending" | "escalated";
	blockedAt: string;
	escalateAt: number;
	escalatedAt: string | null;
	clearedAt: string | null;
}

async function readBlockedDescendants(
	host: BlockedDescendantsHost,
): Promise<BlockedDescendantApproval[]> {
	return (
		(await host.storage.get<BlockedDescendantApproval[]>(
			BLOCKED_DESCENDANT_KEY,
		)) ?? []
	).filter((row) => !row.clearedAt);
}

async function writeBlockedDescendants(
	host: BlockedDescendantsHost,
	rows: BlockedDescendantApproval[],
): Promise<void> {
	if (rows.length === 0) {
		await host.storage.delete(BLOCKED_DESCENDANT_KEY);
	} else {
		await host.storage.put(BLOCKED_DESCENDANT_KEY, rows);
		const pendingEscalations = rows
			.filter((row) => row.status === "pending")
			.map((row) => row.escalateAt);
		if (pendingEscalations.length > 0) {
			await host.ensureStorageAlarm(Math.min(...pendingEscalations));
		}
	}
	host.setState({
		...host.state,
		approvalMirrors: Object.fromEntries(rows.map((row) => [row.id, row])),
	});
}

export async function processBlockedDescendantAlarm(
	host: BlockedDescendantsHost,
): Promise<void> {
	const rows = await readBlockedDescendants(host);
	const now = Date.now();
	let changed = false;
	const escalatedIds: string[] = [];
	for (const row of rows) {
		if (row.status !== "pending" || row.escalateAt > now) continue;
		row.status = "escalated";
		row.escalatedAt = new Date(now).toISOString();
		escalatedIds.push(row.id);
		changed = true;
	}
	if (changed || rows.some((row) => row.status === "pending")) {
		await writeBlockedDescendants(host, rows);
	}
	if (escalatedIds.length > 0) {
		const escalatedAt = new Date(now).toISOString();
		try {
			const db = (await host.turnContext()).db;
			// CAS + `returning()` — only rows this call moved come back, so a
			// re-armed alarm or a second DO activation cannot page twice.
			const escalated = await (
				await import("@tedix/db/queries/kernel-approval-mirrors")
			).escalateKernelApprovalMirrors(db, {
				ids: escalatedIds,
				escalatedAt,
			});
			const organizationId = host.state.organizationId ?? host.idName ?? null;
			if (escalated.length > 0 && organizationId) {
				// The escalation's only human-facing exit. Fail-soft inside, so the
				// inbox-wake work after this alarm step is unaffected.
				await (
					await import("../lib/approval-escalation-notify")
				).notifyApprovalEscalation(host.env, db, {
					organizationId,
					escalated,
					escalatedAt,
				});
			} else if (escalated.length > 0) {
				console.warn(
					JSON.stringify({
						signal: "approval.escalation.undelivered",
						approvalRequestIds: escalated.map((r) => r.approvalRequestId),
						reason: "no_organization_id",
					}),
				);
			}
		} catch (error) {
			console.error("[KernelDO] approval mirror escalation projection failed", {
				exception: safeExceptionTopology(error),
				escalatedIds,
			});
		}
	}
}

export async function mirrorChildApprovalBlocked(
	host: BlockedDescendantsHost,
	input: {
		parentConversationId: string;
		childRunId: string;
		approvalRequestId: string;
		delegatedTediId?: string | null;
	},
): Promise<void> {
	const organizationId = host.idName ?? host.state.organizationId;
	if (!organizationId) return;
	const id = [
		input.parentConversationId,
		input.childRunId,
		input.approvalRequestId,
	].join(":");
	const rows = await readBlockedDescendants(host);
	const now = Date.now();
	try {
		await (
			await import("@tedix/db/queries/kernel-approval-mirrors")
		).createKernelApprovalMirror((await host.turnContext()).db, {
			id,
			organizationId,
			parentConversationId: input.parentConversationId,
			childRunId: input.childRunId,
			approvalRequestId: input.approvalRequestId,
			delegatedTediId: input.delegatedTediId ?? null,
			blockedAt: new Date(now).toISOString(),
			escalateAt: now + BLOCKED_DESCENDANT_GRACE_MS,
		});
	} catch (error) {
		console.error("[KernelDO] approval mirror insert projection failed", {
			exception: safeExceptionTopology(error),
			id,
		});
	}
	if (rows.some((row) => row.id === id)) return;
	rows.push({
		id,
		parentConversationId: input.parentConversationId,
		childRunId: input.childRunId,
		approvalRequestId: input.approvalRequestId,
		delegatedTediId: input.delegatedTediId ?? null,
		status: "pending",
		blockedAt: new Date(now).toISOString(),
		escalateAt: now + BLOCKED_DESCENDANT_GRACE_MS,
		escalatedAt: null,
		clearedAt: null,
	});
	await writeBlockedDescendants(host, rows);
}

export async function clearChildApprovalBlocked(
	host: BlockedDescendantsHost,
	input: {
		parentConversationId: string;
		childRunId: string;
		approvalRequestId?: string | null;
	},
): Promise<void> {
	const organizationId = host.idName ?? host.state.organizationId;
	if (organizationId) {
		try {
			await (
				await import("@tedix/db/queries/kernel-approval-mirrors")
			).clearKernelApprovalMirrors((await host.turnContext()).db, {
				organizationId,
				parentConversationId: input.parentConversationId,
				childRunId: input.childRunId,
				approvalRequestId: input.approvalRequestId,
				clearedAt: new Date().toISOString(),
			});
		} catch (error) {
			console.error("[KernelDO] approval mirror clear projection failed", {
				exception: safeExceptionTopology(error),
				parentConversationId: input.parentConversationId,
				childRunId: input.childRunId,
			});
		}
	}
	const rows = await readBlockedDescendants(host);
	const next = rows.filter(
		(row) =>
			row.parentConversationId !== input.parentConversationId ||
			row.childRunId !== input.childRunId ||
			(input.approvalRequestId
				? row.approvalRequestId !== input.approvalRequestId
				: false),
	);
	if (next.length === rows.length) return;
	await writeBlockedDescendants(host, next);
}
