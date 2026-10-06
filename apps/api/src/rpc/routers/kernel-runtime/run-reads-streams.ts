import { type BaseContext, ErrorCodes, createError } from "../../orpc";
import type { HarnessSubjectVersion } from "@tedix/api-contract/schemas/harness-version";
import type {
	HomeConversation,
	HomePlan,
	HomeRun,
	HomeRunSet,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import {
	KERNEL_RUNTIME_BACKEND,
	normalizeHomeRunRecord,
	reconcileHomeRunRowsFromChildStatus,
} from "../kernel/run-store";
import {
	type KernelRuntimeEvent,
	type TediRuntimeEventRow,
	listKernelRuntimeEvents,
	listTediRuntimeEvents,
	updateKernelRuntimeEventMetadata,
} from "@tedix/db/queries/kernel-runtime-events";
import {
	type KernelRuntimeRun,
	getKernelRuntimeRun,
	listKernelRuntimeRuns,
	updateKernelRuntimeRun,
} from "@tedix/db/queries/kernel-runtime-runs";
import type { KernelTurnWorkResult } from "../kernel/turn-work";
import type { RuntimeStreamReadOutput } from "@tedix/api-contract/schemas/runtime-submissions";
import type { Tedi } from "@tedix/db/schema/tedis";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import { addWorkItemRelation } from "@tedix/db/queries/work-items/relations";
import {
	childRunStatusKey,
	errorMessage,
	isTerminalHomeRunStatus,
	nonNullRecord,
	nowIso,
	recordOrNull,
	shouldFailSoftHomeRunSetRead,
	stringFromPayload,
} from "../kernel/runtime-shared";
import {
	encodeKernelConversationCursor,
	isEphemeralHomeConversation,
	parseKernelConversationCursor,
	selectKernelConversationIndexPage,
} from "../kernel/conversation-index";
import { ensureActiveKernelHarnessVersion } from "../../../services/harness-persistence";
import { getOrganizationTedi } from "@tedix/db/queries/kernel-runtime-support";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { kernelConversationOriginOrHuman } from "@tedix/db/schema/cognitive-runtime";
import { delegationVerifyCommand } from "../kernel/delegated-stop";
import {
	readChildRunStatusesForRunRows,
	readOptionalHomePlanFromRun,
} from "../kernel/home-plan";
import { resolveRuntimeApprovalTimeout } from "@tedix/api-contract/utils/approval-policy";
import { summarizeChildRuntimeEvents } from "../kernel/child-run-reads";
import { toJsonRecord } from "@tedix/db/utils/json";

export /**
 * Materialize a Home plan's inferred cross-owner dependency edges into canonical
 * `work_item_relations` rows at approval time — the moment the plan's owners first
 * have Work Items. Each plan edge is BLOCKER → DEPENDENT (`fromOwnerTediId`
 * finishes before `toOwnerTediId` starts); we map it 1:1 (no flip) to a
 * `relationType:"blocks"` row with `fromWorkItemId` = the blocker's Work Item and
 * `toWorkItemId` = the dependent's — the EXACT direction the dispatch-time gate
 * (`queryWorkItemBlockers`) reads. `ownerToWorkItemId` is built by the approval
 * pre-pass (owner tedi id → just-created Work Item id); an edge whose endpoint was
 * not approved this turn (partial approval) or that is a self-edge is skipped.
 *
 * `addWorkItemRelation` is idempotent (onConflictDoUpdate on the unique
 * from/to/type index), so a re-approval never duplicates a relation. Fail-soft:
 * a per-edge or outer failure NEVER throws — it must not break the approval /
 * dispatch path (mirrors surfaceUnblockedDependents).
 */
async function createHomePlanDependencyRelations(
	context: BaseContext,
	input: {
		plan: HomePlan;
		ownerToWorkItemId: Map<string, string>;
		organizationId: string;
		homePlanId: string;
		createdAt: string;
	},
): Promise<void> {
	try {
		for (const edge of input.plan.dependencies) {
			const fromWorkItemId = input.ownerToWorkItemId.get(edge.fromOwnerTediId);
			const toWorkItemId = input.ownerToWorkItemId.get(edge.toOwnerTediId);
			// Partial approval: one (or both) owners has no Work Item this turn — skip.
			if (!fromWorkItemId || !toWorkItemId) continue;
			// Defensive: never write a self-blocking row (the planner already drops
			// self-edges, but two owners could in principle collapse to one item).
			if (fromWorkItemId === toWorkItemId) continue;
			try {
				await addWorkItemRelation(context.db, {
					id: crypto.randomUUID(),
					orgId: input.organizationId,
					fromWorkItemId,
					toWorkItemId,
					relationType: "blocks",
					metadata: {
						reason: edge.reason,
						source: "kernelRuntime.plan.inferredDependency",
						homePlanId: input.homePlanId,
					},
					createdAt: input.createdAt,
				});
			} catch (error) {
				console.warn(
					"[kernelRuntime] createHomePlanDependencyRelations edge insert failed (fail-soft)",
					{
						fromWorkItemId,
						toWorkItemId,
						error: errorMessage(error),
					},
				);
			}
		}
	} catch (error) {
		console.warn(
			"[kernelRuntime] createHomePlanDependencyRelations failed (fail-soft)",
			{
				homePlanId: input.homePlanId,
				error: errorMessage(error),
			},
		);
	}
}

/**
 * Live child-run summaries for the MESSAGE surface, keyed by
 * `childRunStatusKey(delegatedTediId, childRunId)`.
 *
 * `homeRunsById` (the already-classified run surface for the same conversation)
 * is what makes this read agree with `readChildRunStatusesForRunRows`: a
 * TERMINAL parent Home run is skipped, exactly as that function skips terminal
 * rows. A parent the operator canceled is a settled turn — re-reading the child
 * it dispatched can only produce a later, contradicting status (the child runs
 * on and finishes), and it costs one child-ledger query per delegated turn in
 * the history page. The persisted `metadata.childRunStatus` on the run record is
 * authoritative for those rows.
 */
export async function readChildRunStatuses(
	context: BaseContext,
	rows: KernelRuntimeEvent[],
	homeRunsById: Map<string, HomeRun>,
): Promise<Map<string, Record<string, unknown>>> {
	const refs = new Map<
		string,
		{
			runId: string;
			tediId: string;
			verifyCommand: string | null;
		}
	>();
	for (const row of rows) {
		if (!row.delegatedTediId || !row.childRunId) continue;
		const homeRun = row.runId ? homeRunsById.get(row.runId) : undefined;
		if (homeRun && isTerminalHomeRunStatus(homeRun.status)) continue;
		refs.set(childRunStatusKey(row.delegatedTediId, row.childRunId), {
			runId: row.childRunId,
			tediId: row.delegatedTediId,
			verifyCommand: delegationVerifyCommand(homeRun?.metadata),
		});
	}
	const statuses = new Map<string, Record<string, unknown>>();
	await Promise.all(
		[...refs.entries()].map(async ([key, ref]) => {
			try {
				const childRows = await listTediRuntimeEvents(context.db, {
					tediId: ref.tediId,
					runId: ref.runId,
					order: "desc",
					limit: 25,
				});
				const status = summarizeChildRuntimeEvents(childRows, {
					verifyCommand: ref.verifyCommand,
				});
				if (status) statuses.set(key, status);
			} catch (error) {
				console.warn("[kernelRuntime] child run status read failed", {
					error: error instanceof Error ? error.message : String(error),
					runId: ref.runId,
					tediId: ref.tediId,
				});
			}
		}),
	);
	return statuses;
}

/**
 * Reconcile a set of kernel home-run rows whose CHILD run IDs are known (the
 * IDs stored in `metadata.kernelInboxRunIds` on a wake turn, which are the
 * child-run IDs that woke the alarm). Finds the PARENT rows by `childRunId IN
 * (childRunIds)`, then runs the standard on-read reconciler against current
 * child-run event evidence so their status/progress/preview reflect the
 * completed delegations.
 *
 * Called by the inbox-wake turn body in `turn-work.ts` when
 * `runtimeMetadata.source === "kernel.inboxWakeAlarm"`. Fail-soft: errors are
 * logged and an empty array is returned so the wake turn still settles cleanly.
 */

/**
 * Reconcile a set of kernel home-run rows whose CHILD run IDs are known (the
 * IDs stored in `metadata.kernelInboxRunIds` on a wake turn, which are the
 * child-run IDs that woke the alarm). Finds the PARENT rows by `childRunId IN
 * (childRunIds)`, then runs the standard on-read reconciler against current
 * child-run event evidence so their status/progress/preview reflect the
 * completed delegations.
 *
 * Called by the inbox-wake turn body in `turn-work.ts` when
 * `runtimeMetadata.source === "kernel.inboxWakeAlarm"`. Fail-soft: errors are
 * logged and an empty array is returned so the wake turn still settles cleanly.
 */
export type InboxWakeReconcileResult = {
	runs: Array<HomeRun>;
	/**
	 * Direct child runs whose deterministic parent `message.completed` event owns
	 * delivery after reconciliation. That event is idempotently written/repaired;
	 * an inbox wake must not publish the same child result under its own run id.
	 */
	canonicalDirectCompletionChildRunIds: ReadonlySet<string>;
	freshlySettledBranches: Array<{
		childRunId: string;
		delegatedTediId: string;
		parentRunId: string;
		required: boolean;
		status: "completed" | "failed" | "canceled";
	}>;
	synthesisBranches: Array<{
		childRunId: string;
		delegatedTediId: string;
		parentRunId: string;
		required: boolean;
		status: "completed" | "failed" | "canceled";
	}>;
	/**
	 * The childRunId values for parent rows that were non-terminal BEFORE this
	 * reconcile call and became terminal (completed/failed/canceled) AFTER it.
	 * Rows that were already terminal before the call are excluded — those were
	 * delivered by the parent-waits on-read path and must NOT generate a second
	 * assistant message on the wake.
	 */
	freshlySettledChildRunIds: ReadonlySet<string>;
};

export async function reconcileInboxWakeRuns(
	context: BaseContext,
	input: {
		organizationId: string;
		childRunIds: string[];
	},
): Promise<InboxWakeReconcileResult> {
	const empty: InboxWakeReconcileResult = {
		runs: [],
		canonicalDirectCompletionChildRunIds: new Set(),
		freshlySettledBranches: [],
		synthesisBranches: [],
		freshlySettledChildRunIds: new Set(),
	};
	if (input.childRunIds.length === 0) return empty;
	try {
		// Direct delegations carry the child reference in a column. Multi-tedi plan
		// branches carry it in metadata.homePlan, so read a bounded set of live org
		// runs and match those references in memory as well. This is the wake-path
		// equivalent of the trace reader's reference convergence; no evidence is
		// copied into the queue row.
		const [directRows, recentPlanCandidates] = await Promise.all([
			listKernelRuntimeRuns(context.db, {
				organizationId: input.organizationId,
				childRunIds: input.childRunIds,
				orderBy: "none",
				limit: input.childRunIds.length,
			}),
			listKernelRuntimeRuns(context.db, {
				organizationId: input.organizationId,
				limit: 200,
			}),
		]);
		const wantedChildIds = new Set(input.childRunIds);
		const planRows = recentPlanCandidates.filter((row) =>
			readOptionalHomePlanFromRun(row)?.assignments.some(
				(assignment) =>
					assignment.childRunId && wantedChildIds.has(assignment.childRunId),
			),
		);
		const rows = [
			...new Map(
				[...directRows, ...planRows].map((row) => [row.id, row]),
			).values(),
		];
		if (rows.length === 0) return empty;
		const prePlanAssignments = new Map<
			string,
			{
				delegatedTediId: string;
				parentRunId: string;
				required: boolean;
				status: string;
			}
		>();
		const existingPlanSynthesisEventIds = new Set<string>();
		await Promise.all(
			planRows.map(async (row) => {
				const eventId = homeRuntimeEventId({
					organizationId: row.organizationId,
					kind: "message.completed",
					conversationId: row.conversationId,
					runId: row.id,
					suffix: "plan-convergence",
				});
				const [existing] = await listKernelRuntimeEvents(context.db, {
					id: eventId,
					limit: 1,
				});
				if (existing) existingPlanSynthesisEventIds.add(eventId);
			}),
		);
		for (const row of rows) {
			for (const assignment of readOptionalHomePlanFromRun(row)?.assignments ??
				[]) {
				if (
					!assignment.childRunId ||
					!wantedChildIds.has(assignment.childRunId)
				)
					continue;
				prePlanAssignments.set(assignment.childRunId, {
					delegatedTediId: assignment.ownerTediId,
					parentRunId: row.id,
					required: assignment.required,
					status: assignment.status,
				});
			}
		}

		// Record which parent rows were already terminal BEFORE reconcile so the
		// wake intercept can detect "already delivered by the parent-waits path".
		const preReconcileTerminalChildRunIds = new Set<string>(
			rows
				.filter(
					(r) =>
						r.childRunId !== null &&
						isTerminalHomeRunStatus(r.status as TediRunStatus),
				)
				.map((r) => r.childRunId as string),
		);
		const childRunStatuses = await readChildRunStatusesForRunRows(
			context,
			rows,
		);
		const reconciledRows = await reconcileHomeRunRowsFromChildStatus(context, {
			childRunStatuses,
			rows,
		});
		// Direct-delegation reconciliation owns the deterministic completion event
		// on the PARENT run (and repairs a missing event on later reads). Mark every
		// terminal direct child as canonically owned here, regardless of whether it
		// became terminal before or during this wake. The synthetic wake run must
		// never relay that same child result under a fresh run id; client-side
		// message/run-id dedup cannot recognize those as the same delivery.
		const canonicalDirectCompletionChildRunIds = new Set<string>(
			reconciledRows
				.filter(
					(row) =>
						row.childRunId &&
						row.delegatedTediId &&
						isTerminalHomeRunStatus(row.status as TediRunStatus),
				)
				.map((row) => row.childRunId as string),
		);
		const runs = reconciledRows.map((row) =>
			normalizeHomeRunRecord(row, childRunStatuses),
		);
		const freshlySettledBranches: InboxWakeReconcileResult["freshlySettledBranches"] =
			[];
		const synthesisBranches: InboxWakeReconcileResult["synthesisBranches"] = [];
		for (const row of reconciledRows) {
			const reconciledPlan = readOptionalHomePlanFromRun(row);
			for (const assignment of reconciledPlan?.assignments ?? []) {
				if (
					!assignment.childRunId ||
					!wantedChildIds.has(assignment.childRunId)
				)
					continue;
				const previous = prePlanAssignments.get(assignment.childRunId);
				if (
					previous &&
					!["completed", "failed", "canceled"].includes(previous.status) &&
					(assignment.status === "completed" ||
						assignment.status === "failed" ||
						assignment.status === "canceled")
				) {
					freshlySettledBranches.push({
						childRunId: assignment.childRunId,
						delegatedTediId: assignment.ownerTediId,
						parentRunId: row.id,
						required: assignment.required,
						status: assignment.status,
					});
				}
			}
			const synthesisEventId = homeRuntimeEventId({
				organizationId: row.organizationId,
				kind: "message.completed",
				conversationId: row.conversationId,
				runId: row.id,
				suffix: "plan-convergence",
			});
			if (
				reconciledPlan &&
				["completed", "failed", "canceled"].includes(reconciledPlan.status) &&
				!existingPlanSynthesisEventIds.has(synthesisEventId)
			) {
				for (const assignment of reconciledPlan.assignments) {
					if (
						assignment.childRunId &&
						(assignment.status === "completed" ||
							assignment.status === "failed" ||
							assignment.status === "canceled")
					) {
						synthesisBranches.push({
							childRunId: assignment.childRunId,
							delegatedTediId: assignment.ownerTediId,
							parentRunId: row.id,
							required: assignment.required,
							status: assignment.status,
						});
					}
				}
			}
		}

		// A childRunId is "freshly settled" when the parent row was non-terminal
		// before reconcile AND is now terminal.
		const freshlySettledChildRunIds = new Set<string>([
			...freshlySettledBranches.map((branch) => branch.childRunId),
			...runs
				.filter(
					(r) =>
						r.childRunId !== null &&
						isTerminalHomeRunStatus(r.status) &&
						!preReconcileTerminalChildRunIds.has(r.childRunId as string),
				)
				.map((r) => r.childRunId as string),
		]);
		return {
			runs,
			canonicalDirectCompletionChildRunIds,
			freshlySettledBranches,
			freshlySettledChildRunIds,
			synthesisBranches,
		};
	} catch (error) {
		console.warn("[inboxWake] reconcileInboxWakeRuns failed", {
			error: errorMessage(error),
			organizationId: input.organizationId,
			childRunIds: input.childRunIds,
		});
		return empty;
	}
}

export async function readKernelRunRecordsForConversation(
	context: BaseContext,
	input: {
		conversationId: string;
		organizationId: string;
		limit?: number;
	},
): Promise<Map<string, HomeRun>> {
	let rows: KernelRuntimeRun[];
	try {
		rows = await listKernelRuntimeRuns(context.db, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			limit: input.limit ?? 100,
		});
	} catch (error) {
		if (shouldFailSoftHomeRunSetRead(error)) {
			console.warn("[kernelRuntime] message run-set enrichment failed", {
				organizationId: input.organizationId,
				conversationId: input.conversationId,
				error: errorMessage(error),
			});
			return new Map();
		}
		throw error;
	}
	const childRunStatuses = await readChildRunStatusesForRunRows(context, rows);
	return new Map(
		rows.map((row) => [row.id, normalizeHomeRunRecord(row, childRunStatuses)]),
	);
}

export function emptyKernelRunSet(input: {
	conversationId: string;
	organizationId: string;
}): HomeRunSet {
	return {
		activeRunIds: [],
		approvalMirrors: {},
		conversationId: input.conversationId,
		organizationId: input.organizationId,
		runs: [],
		updatedAt: null,
		metadata: {
			source: "kernelRuntime.readRunSet",
		},
	};
}

export function kernelConversationMatchesInput(
	conversation: Pick<
		HomeConversation,
		"id" | "title" | "channel" | "workspaceId"
	>,
	input: {
		channel?: string;
		search?: string;
		workspaceId?: string;
	},
): boolean {
	if (input.workspaceId && conversation.workspaceId !== input.workspaceId)
		return false;
	if (input.channel && conversation.channel !== input.channel) return false;
	if (input.search) {
		const q = input.search.toLowerCase();
		const title = conversation.title ?? "";
		return (
			conversation.id.toLowerCase().includes(q) ||
			title.toLowerCase().includes(q) ||
			(conversation.channel?.toLowerCase().includes(q) ?? false)
		);
	}
	return true;
}

export function isHomeMessageEvent(row: KernelRuntimeEvent): boolean {
	if (row.kind !== "message.received" && row.kind !== "message.completed") {
		return false;
	}
	// Kernel-internal inbox-wake prompts ("[System: N delegated task(s)
	// completed — summarize…]") are machinery, not operator conversation: the
	// wake either delivers its update as a normal assistant message or completes
	// as a quiet no-op. Surfacing the synthetic prompt renders a user-role
	// message that may never receive a reply — indistinguishable from a hang.
	if (row.kind === "message.received") {
		const payload = nonNullRecord(row.payload);
		const metadata = nonNullRecord(payload?.metadata);
		if (metadata?.dispatchMode === "kernel-inbox-wake") return false;
	}
	if (row.kind === "message.completed") {
		const payload = nonNullRecord(row.payload);
		const metadata = nonNullRecord(payload?.metadata);
		// Per-assignment completions drive the live coordination panel and event
		// ledger. The settled plan publishes one parent synthesis; surfacing every
		// branch as a separate chat answer makes Home look fragmented and forces
		// the operator to ask for reconciliation manually.
		if (metadata?.source === "kernelRuntime.planAssignmentCompletion") {
			return false;
		}
	}
	return true;
}

/**
 * Serve a listConversations page from the durable `kernel_conversations`
 * projection: ORDER BY last_message_at DESC with a stable
 * `(last_message_at, conversation_id)` keyset cursor — no event window, so
 * busy orgs can no longer age topical chats out of the list.
 */

export async function listKernelConversationsFromIndex(
	context: BaseContext,
	input: {
		organizationId: string;
		limit: number;
		list: {
			channel?: string;
			cursor?: string;
			search?: string;
			workspaceId?: string;
			includeArchived?: boolean;
		};
	},
): Promise<{
	conversations: HomeConversation[];
	nextCursor: string | null;
}> {
	// A filtered list consumes index rows without emitting them; over-fetch so a
	// search/channel page is not starved by non-matching rows.
	const fetchLimit =
		input.list.search || input.list.channel
			? Math.min(input.limit * 5, 500)
			: input.limit;
	const rows = await selectKernelConversationIndexPage(context.db, {
		organizationId: input.organizationId,
		cursor: parseKernelConversationCursor(input.list.cursor),
		limit: fetchLimit,
		workspaceId: input.list.workspaceId,
		includeArchived: input.list.includeArchived,
	});
	const conversations: HomeConversation[] = [];
	let lastConsumed: (typeof rows)[number] | null = null;
	let stoppedEarly = false;
	for (const row of rows) {
		lastConsumed = row;
		// Ephemeral CI-smoke conversations are operational noise — never surface
		// them in the operator sidebar / CLI list. They keep their event ledger.
		if (isEphemeralHomeConversation(row.conversationId)) continue;
		const conversation: HomeConversation = {
			id: row.conversationId,
			organizationId: input.organizationId,
			// The id-as-title fallback is the contract's "no title" signal — the
			// Tedix OS renders its own placeholder for a title equal to the id.
			title: row.title ?? row.conversationId,
			status: row.archivedAt ? "archived" : "active",
			channel: row.channel ?? "home",
			lastMessageAt: row.lastMessageAt,
			messageCount: row.messageCount,
			pinnedAt: row.pinnedAt ?? null,
			// Unstamped rows (everything written before the origin column, and
			// anything the projection could not classify) resolve to "human" —
			// the indexed read is the primary path, so it always emits a concrete
			// value rather than making each client re-derive the default.
			origin: kernelConversationOriginOrHuman(row.origin),
			workspaceId: row.workspaceId ?? null,
			workpiece:
				row.workpieceKind && row.workpieceId
					? { kind: row.workpieceKind, id: row.workpieceId }
					: null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			metadata: {
				source: "kernelRuntime.conversationIndex",
				...(row.titleSource
					? {
							titleSource: row.titleSource,
						}
					: {}),
			},
		};
		if (!kernelConversationMatchesInput(conversation, input.list)) continue;
		conversations.push(conversation);
		if (conversations.length >= input.limit) {
			stoppedEarly = true;
			break;
		}
	}
	const mayHaveMore = stoppedEarly || rows.length === fetchLimit;
	return {
		conversations,
		nextCursor:
			mayHaveMore && lastConsumed
				? encodeKernelConversationCursor(lastConsumed)
				: null,
	};
}

export async function resolveKernelDelegateTarget(
	context: BaseContext,
	input: {
		delegateToTediId: string;
		organizationId: string;
	},
): Promise<Tedi | null> {
	const target = await getOrganizationTedi(context.db, {
		id: input.delegateToTediId,
		organizationId: input.organizationId,
	});
	if (!target) {
		throw createError(ErrorCodes.NOT_FOUND, "Delegated tedi not found");
	}
	return target;
}

export function delegationWorkOrderApprovalRequestId(runId: string): string {
	return runId;
}

export function assertKernelApprovalStillPending(input: {
	expiresAt: string;
	status: string;
}): void {
	const timeout = resolveRuntimeApprovalTimeout(input);
	if (!timeout.expired) return;
	throw createError(
		ErrorCodes.BAD_REQUEST,
		`This approval request has expired; timeout policy defaulted to deny (${timeout.reason})`,
	);
}

/**
 * Recover the verbatim operator request for a Home run from its persisted
 * `message.received` ledger event. Used by the human-approval workstation
 * dispatch trigger — the approval payload only carries a truncated
 * requestPreview, but the work order's source content should be the full ask.
 */

export /**
 * Recover the verbatim operator request for a Home run from its persisted
 * `message.received` ledger event. Used by the human-approval workstation
 * dispatch trigger — the approval payload only carries a truncated
 * requestPreview, but the work order's source content should be the full ask.
 */
async function readKernelUserMessageContent(
	context: BaseContext,
	input: {
		conversationId: string;
		organizationId: string;
		runId: string;
	},
): Promise<string | null> {
	try {
		const rows = await listKernelRuntimeEvents(context.db, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			runId: input.runId,
			kind: "message.received",
			limit: 1,
		});
		return stringFromPayload(nonNullRecord(rows[0]?.payload)?.content) ?? null;
	} catch (error) {
		console.warn("[kernelRuntime] user message content read failed", {
			error: errorMessage(error),
			runId: input.runId,
		});
		return null;
	}
}

export function resolvedWorkstationAttachProgress(
	status: "approved" | "rejected",
): {
	current: number;
	detail: string;
	label: string;
	total: number;
} {
	return status === "approved"
		? {
				current: 76,
				detail: "Certified workstation adapter dispatch pending",
				label: "Approved",
				total: 100,
			}
		: {
				current: 100,
				detail: "Workstation attachment declined",
				label: "Rejected",
				total: 100,
			};
}

export function failedKernelRun(input: {
	organizationId: string;
	conversationId: string;
	idempotencyKey: string;
	error: string;
}): HomeRun {
	const createdAt = nowIso();
	return {
		id: input.idempotencyKey,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		status: "failed",
		inputMessageId: `${input.idempotencyKey}:input`,
		outputMessageId: null,
		delegatedTediId: null,
		childRunId: null,
		runtime: {
			backend: KERNEL_RUNTIME_BACKEND,
			externalId: input.idempotencyKey,
			metadata: {
				source: "kernelRuntime.enqueueMessage",
				subject: "home",
				unavailable: true,
				error: input.error,
			},
		},
		startedAt: createdAt,
		completedAt: createdAt,
		createdAt,
		updatedAt: createdAt,
		metadata: {
			source: "kernelRuntime.enqueueMessage",
			idempotencyKey: input.idempotencyKey,
			error: input.error,
		},
	};
}

export const RUN_EVENT_STREAM_PAGE = 200;

export const TERMINAL_RUN_EVENT_KINDS = [
	"run.completed",
	"run.failed",
	"run.canceled",
	"submission.settled",
] as const;

export const TERMINAL_RUN_EVENT_KIND_SET = new Set<string>(
	TERMINAL_RUN_EVENT_KINDS,
);

export const RUN_EVENT_RECEIPT_KINDS = [
	...TERMINAL_RUN_EVENT_KINDS,
	"submission.admitted",
] as const;

export const RUN_EVENT_RECEIPT_ROWS = 32;

export type RunEventStreamRow = {
	id: string;
	kind: string;
	conversationId: string | null;
	runId: string | null;
	messageId: string | null;
	causeEventId?: string | null;
	toolCallId: string | null;
	approvalRequestId: string | null;
	artifactId: string | null;
	sequence: number | null;
	delta: string | null;
	payload: Record<string, unknown> | null;
	createdAt: string;
};

export function parseRunEventPayload(
	value: unknown,
): Record<string, JsonValue> | undefined {
	const parsed = JsonValueSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data === null ||
		typeof parsed.data !== "object" ||
		Array.isArray(parsed.data)
	) {
		return undefined;
	}
	return parsed.data;
}

/**
 * Terminal values of `kernelRuntimeRuns.status` (`TEDI_RUN_STATUS_VALUES` in
 * `packages/db/src/schema/cognitive-runtime.ts`) — the row's own authoritative
 * lifecycle state, independent of any event written into its stream.
 */

export /**
 * Terminal values of `kernelRuntimeRuns.status` (`TEDI_RUN_STATUS_VALUES` in
 * `packages/db/src/schema/cognitive-runtime.ts`) — the row's own authoritative
 * lifecycle state, independent of any event written into its stream.
 */
const TERMINAL_KERNEL_RUN_ROW_STATUSES = new Set([
	"completed",
	"failed",
	"canceled",
]);

/**
 * Pure pagination + terminal-detection for a run's durable event stream.
 * `offset` is a run-local ordinal over the (createdAt, id)-ordered events;
 * callers resume by passing the previous `nextOffset`. `tail=N` returns the
 * latest N events. `closed`/`terminalEventId` are set once a terminal run or
 * submission event is present, and `submissionId` is lifted from a submission.*
 * event payload. Exported for unit tests.
 *
 * `rowStatus` (the parent Home run's OWN `kernelRuntimeRuns.status`, passed by
 * the caller only when reading that run's own stream — never a child's) is a
 * second, independent terminal signal that a `run.completed`/`failed`/`canceled`-
 * KIND event alone is NOT trustworthy without: delegation dispatch writes that
 * event kind at ACCEPT time (the child was successfully queued, not that it
 * finished — see the delegate-dispatch call sites in this file) while the row
 * itself stays `queued`/`running`, so a stream reader that only look at event
 * KIND sees `closed: true` for a run that is nowhere near done. When `rowStatus`
 * is supplied and disagrees with a run-kind terminal event, the run-kind signal
 * is ignored (event-KIND writes can be stale; the row is authoritative).
 * For a parent stream with a `submission.admitted` receipt, closure is deferred
 * until `submission.settled`: the run row can become terminal before delegation
 * outcome/audit finalization appends its final events. Child streams are never
 * gated by the parent's submission lifecycle.
 * Omitting `rowStatus` (existing callers, or the childRunId case where this
 * run's OWN row status says nothing about a DIFFERENT child run's completion)
 * preserves the original kind-only behavior exactly.
 */

/**
 * Pure pagination + terminal-detection for a run's durable event stream.
 * `offset` is a run-local ordinal over the (createdAt, id)-ordered events;
 * callers resume by passing the previous `nextOffset`. `tail=N` returns the
 * latest N events. `closed`/`terminalEventId` are set once a terminal run or
 * submission event is present, and `submissionId` is lifted from a submission.*
 * event payload. Exported for unit tests.
 *
 * `rowStatus` (the parent Home run's OWN `kernelRuntimeRuns.status`, passed by
 * the caller only when reading that run's own stream — never a child's) is a
 * second, independent terminal signal that a `run.completed`/`failed`/`canceled`-
 * KIND event alone is NOT trustworthy without: delegation dispatch writes that
 * event kind at ACCEPT time (the child was successfully queued, not that it
 * finished — see the delegate-dispatch call sites in this file) while the row
 * itself stays `queued`/`running`, so a stream reader that only look at event
 * KIND sees `closed: true` for a run that is nowhere near done. When `rowStatus`
 * is supplied and disagrees with a run-kind terminal event, the run-kind signal
 * is ignored (event-KIND writes can be stale; the row is authoritative).
 * For a parent stream with a `submission.admitted` receipt, closure is deferred
 * until `submission.settled`: the run row can become terminal before delegation
 * outcome/audit finalization appends its final events. Child streams are never
 * gated by the parent's submission lifecycle.
 * Omitting `rowStatus` (existing callers, or the childRunId case where this
 * run's OWN row status says nothing about a DIFFERENT child run's completion)
 * preserves the original kind-only behavior exactly.
 */
export function buildSelectedRunEventStreamPage(
	rows: RunEventStreamRow[],
	receiptRows: RunEventStreamRow[],
	opts: {
		runId: string;
		start: number;
		childRunId?: string;
		rowStatus?: string;
	},
): RuntimeStreamReadOutput {
	let runTerminalEventId: string | undefined;
	let submissionTerminalEventId: string | undefined;
	let latestTerminalEventId: string | undefined;
	let submissionId: string | undefined;
	// The bounded receipt query is DESC; restore chronological order so the
	// latest (createdAt,id) terminal wins exactly as it did in the full scan.
	const orderedReceiptRows = [...receiptRows].sort(
		(a, b) =>
			a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
	for (const row of orderedReceiptRows) {
		if (TERMINAL_RUN_EVENT_KIND_SET.has(row.kind)) {
			latestTerminalEventId = row.id;
			if (row.kind === "submission.settled") {
				submissionTerminalEventId = row.id;
			} else {
				runTerminalEventId = row.id;
			}
		}
		if (
			row.kind === "submission.admitted" ||
			row.kind === "submission.settled"
		) {
			const sid = row.payload?.submissionId;
			if (typeof sid === "string") submissionId = sid;
		}
	}
	const rowConfirmsRunTerminal =
		opts.childRunId !== undefined ||
		opts.rowStatus === undefined ||
		TERMINAL_KERNEL_RUN_ROW_STATUSES.has(opts.rowStatus);
	// A Home turn with a durable submission is not fully settled when its run row
	// first becomes terminal. Delegation outcome/audit events are written during
	// finalization and `submission.settled` is the exactly-once fence that says
	// that phase committed. Closing on the earlier run.completed/run.failed receipt
	// made concurrent SSE consumers retire at different offsets (one live tab saw
	// 7 rows while another saw the later submission.settled row at offset 8).
	//
	// Once the settlement fence exists, report the latest terminal receipt already
	// visible in this bounded snapshot. Runs without a submission preserve the
	// row-gated run-terminal contract, and child streams remain kind-gated because
	// the parent submission does not own the child's event ledger.
	const submissionControlsClosure =
		opts.childRunId === undefined && submissionId !== undefined;
	const terminalEventId = submissionControlsClosure
		? submissionTerminalEventId
			? latestTerminalEventId
			: undefined
		: rowConfirmsRunTerminal
			? runTerminalEventId
			: undefined;
	return {
		events: rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			conversationId: row.conversationId ?? undefined,
			runId: row.runId ?? undefined,
			messageId: row.messageId ?? undefined,
			causeEventId: row.causeEventId ?? undefined,
			toolCallId: row.toolCallId ?? undefined,
			approvalRequestId: row.approvalRequestId ?? undefined,
			artifactId: row.artifactId ?? undefined,
			sequence: row.sequence ?? undefined,
			delta: row.delta ?? undefined,
			payload: parseRunEventPayload(row.payload),
			createdAt: row.createdAt,
		})),
		stream: {
			streamId: opts.childRunId
				? `home:${opts.runId}:child:${opts.childRunId}`
				: `home:${opts.runId}`,
			offset: opts.start,
			nextOffset: opts.start + rows.length,
			closed: terminalEventId !== undefined,
			terminalEventId,
			submissionId,
		},
	};
}

export type DelegatedChildRunRef = {
	childRunId: string;
	delegatedTediId: string;
};

/**
 * Resolve a child selector from the already-authorized parent Home run. A raw
 * childRunId is never sufficient authorization: it must be one of the direct
 * delegation or Home-plan assignment references persisted on that parent.
 */

/**
 * Resolve a child selector from the already-authorized parent Home run. A raw
 * childRunId is never sufficient authorization: it must be one of the direct
 * delegation or Home-plan assignment references persisted on that parent.
 */
export function resolveDelegatedChildRunRef(
	runRow: KernelRuntimeRun,
	input: {
		childRunId: string;
		delegatedTediId?: string;
	},
): DelegatedChildRunRef | null {
	const direct =
		runRow.childRunId === input.childRunId && runRow.delegatedTediId
			? {
					childRunId: runRow.childRunId,
					delegatedTediId: runRow.delegatedTediId,
				}
			: null;
	const assignment = readOptionalHomePlanFromRun(runRow)?.assignments.find(
		(candidate) => candidate.childRunId === input.childRunId,
	);
	const resolved =
		direct ??
		(assignment?.childRunId
			? {
					childRunId: assignment.childRunId,
					delegatedTediId: assignment.ownerTediId,
				}
			: null);
	if (!resolved) return null;
	if (
		input.delegatedTediId &&
		input.delegatedTediId !== resolved.delegatedTediId
	) {
		return null;
	}
	return resolved;
}

export function kernelStreamRow(row: KernelRuntimeEvent): RunEventStreamRow {
	return {
		id: row.id,
		kind: row.kind,
		conversationId: row.conversationId,
		runId: row.runId,
		messageId: row.messageId,
		causeEventId: row.causeEventId,
		toolCallId: null,
		approvalRequestId: null,
		artifactId: null,
		sequence: row.sequence,
		delta: row.delta,
		payload: row.payload,
		createdAt: row.createdAt,
	};
}

export function childStreamRow(row: TediRuntimeEventRow): RunEventStreamRow {
	return {
		id: row.id,
		kind: row.kind,
		conversationId: row.conversationId,
		runId: row.runId,
		messageId: row.messageId,
		causeEventId: null,
		toolCallId: row.toolCallId,
		approvalRequestId: row.approvalRequestId,
		artifactId: row.artifactId,
		sequence: row.sequence,
		delta: row.delta,
		payload: row.payload,
		createdAt: row.createdAt,
	};
}

export function buildRunEventStreamPage(
	rows: RunEventStreamRow[],
	opts: {
		runId: string;
		offset?: number;
		tail?: number;
		childRunId?: string;
		rowStatus?: string;
	},
): RuntimeStreamReadOutput {
	const total = rows.length;
	const start =
		opts.tail && opts.tail > 0
			? Math.max(0, total - opts.tail)
			: Math.min(Math.max(0, opts.offset ?? 0), total);
	return buildSelectedRunEventStreamPage(
		rows.slice(start, start + RUN_EVENT_STREAM_PAGE),
		rows,
		{
			runId: opts.runId,
			start,
			childRunId: opts.childRunId,
			rowStatus: opts.rowStatus,
		},
	);
}

export function routerVersionFromKernelRunMetadata(
	metadata: Record<string, unknown> | null,
): string | null {
	const topLevel = metadata?.routerVersion;
	if (typeof topLevel === "string" && topLevel) return topLevel;
	const route = recordOrNull(metadata?.kernelRoute);
	const nested = route?.routerVersion;
	return typeof nested === "string" && nested ? nested : null;
}

export function stampKernelHarnessMetadata(
	metadata: Record<string, unknown> | null,
	version: HarnessSubjectVersion,
): Record<string, unknown> {
	const bodyExecutionResult = recordOrNull(metadata?.bodyExecutionResult);
	const structuredResult = recordOrNull(bodyExecutionResult?.structuredResult);
	const harnessStamp = {
		harnessVersionId: version.id,
		harnessSubjectKind: version.subjectKind,
		harnessSubjectId: version.subjectId,
	};
	return {
		...metadata,
		...harnessStamp,
		...(bodyExecutionResult
			? {
					bodyExecutionResult: {
						...bodyExecutionResult,
						harnessVersionId: version.id,
						...(structuredResult
							? {
									structuredResult: {
										...structuredResult,
										harnessSubjectKind: version.subjectKind,
										harnessSubjectId: version.subjectId,
									},
								}
							: {}),
					},
				}
			: {}),
	};
}

export async function ensureKernelHarnessStampOnResult(
	context: BaseContext,
	result: KernelTurnWorkResult,
): Promise<KernelTurnWorkResult> {
	const resultMetadata = recordOrNull(result.run.metadata);
	if (typeof resultMetadata?.harnessVersionId === "string") return result;
	const routerVersion = routerVersionFromKernelRunMetadata(resultMetadata);
	if (!routerVersion) return result;
	try {
		const { version } = await ensureActiveKernelHarnessVersion(context.db, {
			orgId: result.run.organizationId,
			components: {
				attention_router: routerVersion,
			},
			reason: "kernel router version observed",
			metadata: {
				routerVersion,
				surface: "home.kernel",
				stampedFrom: "kernelRuntime.enqueueMessage",
			},
			createdAt: result.run.createdAt,
		});
		const currentRun = await getKernelRuntimeRun(context.db, {
			id: result.run.id,
		});
		const currentRunMetadata = recordOrNull(currentRun?.metadata);
		const stampedRunMetadata = stampKernelHarnessMetadata(
			currentRunMetadata
				? {
						...currentRunMetadata,
						...resultMetadata,
					}
				: resultMetadata,
			version,
		);
		await updateKernelRuntimeRun(context.db, result.run.id, {
			metadata: toJsonRecord(stampedRunMetadata),
		});
		const events = await listKernelRuntimeEvents(context.db, {
			organizationId: result.run.organizationId,
			runId: result.run.id,
			kinds: ["message.completed", "run.completed", "approval.requested"],
		});
		for (const event of events) {
			await updateKernelRuntimeEventMetadata(context.db, event.id, {
				...recordOrNull(event.runtimeMetadata),
				harnessVersionId: version.id,
				harnessSubjectKind: version.subjectKind,
				harnessSubjectId: version.subjectId,
			});
		}
		const runRuntime = result.run.runtime ?? {
			backend: KERNEL_RUNTIME_BACKEND,
			externalId: result.run.id,
		};
		const assistantRuntime = result.assistantMessage?.runtime ?? {
			backend: KERNEL_RUNTIME_BACKEND,
			externalId: result.run.id,
		};
		const stampedRuntimeMetadata = {
			...recordOrNull(runRuntime.metadata),
			harnessVersionId: version.id,
			harnessSubjectKind: version.subjectKind,
			harnessSubjectId: version.subjectId,
		};
		const assistantRuntimeMetadata = {
			...recordOrNull(assistantRuntime.metadata),
			harnessVersionId: version.id,
			harnessSubjectKind: version.subjectKind,
			harnessSubjectId: version.subjectId,
		};
		return {
			...result,
			run: {
				...result.run,
				metadata: stampedRunMetadata,
				runtime: {
					...runRuntime,
					metadata: stampedRuntimeMetadata,
				},
			},
			assistantMessage: result.assistantMessage
				? {
						...result.assistantMessage,
						runtime: {
							...assistantRuntime,
							metadata: assistantRuntimeMetadata,
						},
					}
				: result.assistantMessage,
		};
	} catch (error) {
		console.warn(
			"[kernelRuntime] kernel harness version reconciliation failed",
			errorMessage(error),
		);
		return result;
	}
}

/**
 * Wire {@link runKernelTurnWork}'s injected dependencies from a context. Used by
 * BOTH execution contexts: inline in `enqueueMessage` (request context) and
 * inside `KernelDO` (synthetic context built via `createContext`).
 *
 * `kernel` / `writeProposalPlanner` read the module-level test seams
 * (`activeKernel` / `activeKernelWriteProposalPlanner`) at CALL time — not at
 * deps-build time — so `kernelRuntimeTestHooks` stubbing keeps working wherever
 * the turn body runs.
 */
