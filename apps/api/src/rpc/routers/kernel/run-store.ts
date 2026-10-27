/**
 * Kernel — durable run/event store. Insert and normalize helpers for the
 * `kernel_runtime_runs`/`kernel_runtime_events` D1 rows: home-run records,
 * plan/child-status reconciliation writes, dispatch-failure recording, and
 * conversation-access checks. This module must NOT import kernel-runtime.ts
 * (the router imports this module; a value import back would create a cycle).
 */

import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { KernelRuntimeEvent } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	buildKernelRuntimeEvent,
	homeRuntimeEventId,
} from "@tedix/api-contract/utils/runtime-events";
import {
	insertKernelRuntimeEventIfAbsent,
	KernelRuntimeEventConflictError,
	type KernelRuntimeEvent as KernelRuntimeEventRow,
	listKernelRuntimeEvents,
	type NewKernelRuntimeEvent,
} from "@tedix/db/queries/kernel-runtime-events";
import {
	findKernelRuntimeRunByChild,
	insertKernelRuntimeRunIfAbsent,
	type NewKernelRuntimeRun,
	openKernelRuntimeTurn,
	settleKernelRuntimeTurn,
	type TransitionKernelRuntimeRunStatusParams,
	updateKernelRuntimeRunForOrg,
} from "@tedix/db/queries/kernel-runtime-runs";
import type { RuntimeSubmission } from "@tedix/db/queries/runtime-submissions/read-models";
import { getKernelConversation } from "@tedix/db/queries/kernel-conversations";
import { requireWorkspaceCollaboratorAccess } from "../../../services/os-workspace-collaborators";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	type KernelConversationAccessLevel,
	resolveKernelConversationAccess,
} from "../../../kernel/conversation-access";
import {
	kernelFirstAttemptBatch,
	recordKernelSubmissionStarted,
} from "../../../kernel/runtime-submission-bridge";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import {
	applyKernelConversationEvent,
	kernelConversationMessageParams,
} from "./conversation-index";
import {
	KERNEL_CONVERSATION_ORIGIN_PAYLOAD_KEY,
	kernelConversationOriginFromPayload,
	resolveKernelConversationOrigin,
} from "./conversation-origin";
import { homeNarrationMetadata } from "./home-narration";
import {
	buildDelegationFailureEnvelope,
	errorMessage,
	homeRunProgress,
	nonNullRecord,
	nowIso,
	stringFromPayload,
} from "./runtime-shared";
import { homeDelegationCompletionContent } from "./run-store-content";

export const KERNEL_RUNTIME_BACKEND = "custom";

export function normalizeRuntime(row: KernelRuntimeEventRow) {
	return {
		backend: row.runtimeBackend,
		externalId: row.runtimeExternalId ?? undefined,
		externalUrl: row.runtimeExternalUrl ?? undefined,
		metadata: nonNullRecord(row.runtimeMetadata),
	};
}

function normalizeHomeEvent(row: KernelRuntimeEventRow): KernelRuntimeEvent {
	return {
		id: row.id,
		organizationId: row.organizationId,
		kind: row.kind,
		conversationId: row.conversationId,
		runId: row.runId ?? undefined,
		messageId: row.messageId ?? undefined,
		causeEventId: row.causeEventId ?? undefined,
		delegatedTediId: row.delegatedTediId ?? undefined,
		childRunId: row.childRunId ?? undefined,
		sequence: row.sequence ?? undefined,
		delta: row.delta ?? undefined,
		payload: nonNullRecord(row.payload),
		runtime: normalizeRuntime(row),
		createdAt: row.createdAt,
	};
}

export async function ensureHomeConversationAccess(
	context: BaseContext,
	input: {
		conversationId: string;
		organizationId: string;
		required: KernelConversationAccessLevel;
	},
): Promise<void> {
	const decision = await resolveKernelConversationAccess(context.db, {
		conversationId: input.conversationId,
		descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
		organizationId: input.organizationId,
		required: input.required,
	});
	if (decision.allowed) {
		if (context.authType === "user") {
			const conversation = await getKernelConversation(context.db, input);
			if (conversation?.workspaceId) {
				await requireWorkspaceCollaboratorAccess(
					context,
					conversation.workspaceId,
					"app.chat",
				);
			}
		}
		return;
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		`Access denied to Home conversation ${input.conversationId}`,
	);
}

/**
 * Shared deterministic message-id for the async-completion assistant message
 * written by recordHomeDelegationCompletionMessage and pointed to by the
 * terminal reconcile outputMessageId. Single source of truth — do not inline.
 */
export function asyncCompletionAssistantMessageId(homeRunId: string): string {
	return `${homeRunId}:async-completion:assistant`;
}

/**
 * Stamp `payload.origin` on the turn-ingress event so the conversation index
 * can record who started the conversation.
 *
 * Done HERE, at the single event choke point, rather than in each emitter:
 * every `message.received` write in the kernel goes through
 * `insertKernelRuntimeEvent` under a real request context
 * (`kernelRuntime.enqueueMessage`, `startKernelTurn`, `retryRun`, `steerRun`),
 * so one stamp covers all four and any fifth that appears later.
 *
 * Two deliberate restrictions:
 * - Only `message.received` with `role: "user"` — the turn INGRESS, the one
 *   event whose request context is the originating caller. Assistant/tool
 *   events are written from settle paths and Durable Object contexts whose
 *   `authType` says nothing about who asked, and stamping them would let a
 *   completion overwrite the ingress classification.
 * - An origin already present on the payload wins, so a caller that knows
 *   better than the transport can say so.
 */
function stampConversationOrigin(
	context: BaseContext,
	kind: NewKernelRuntimeEvent["kind"],
	payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (kind !== "message.received") return payload;
	if (!payload || payload.role !== "user") return payload;
	if (kernelConversationOriginFromPayload(payload)) return payload;
	return {
		...payload,
		[KERNEL_CONVERSATION_ORIGIN_PAYLOAD_KEY]:
			resolveKernelConversationOrigin(context),
	};
}

export type KernelRuntimeEventInsertInput = {
	id?: string;
	organizationId: string;
	kind: NewKernelRuntimeEvent["kind"];
	conversationId: string;
	runId?: string;
	messageId?: string;
	causeEventId?: string | null;
	delegatedTediId?: string;
	childRunId?: string;
	sequence?: number;
	delta?: string;
	payload?: Record<string, unknown>;
	runtimeMetadata?: Record<string, unknown>;
	createdAt?: string;
};

export async function existingRunStartedCause(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
		runId: string;
		messageId: string;
	},
): Promise<string | null | undefined> {
	const id = homeRuntimeEventId({
		organizationId: input.organizationId,
		kind: "run.started",
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
	});
	const [row] = await listKernelRuntimeEvents(context.db, { id, limit: 1 });
	if (!row) return undefined;
	if (
		row.organizationId !== input.organizationId ||
		row.conversationId !== input.conversationId ||
		row.runId !== input.runId ||
		row.kind !== "run.started" ||
		row.messageId !== input.messageId
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Existing kernel run start identity conflicts with replay",
		);
	return row.causeEventId;
}

/** The persistable row for one kernel runtime event input. */
function buildKernelRuntimeEventRow(
	context: BaseContext,
	input: KernelRuntimeEventInsertInput,
): NewKernelRuntimeEvent {
	const createdAt = input.createdAt ?? nowIso();
	const payload = stampConversationOrigin(context, input.kind, input.payload);
	const event = buildKernelRuntimeEvent({
		id: input.id,
		organizationId: input.organizationId,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
		causeEventId: input.causeEventId,
		delegatedTediId: input.delegatedTediId,
		childRunId: input.childRunId,
		sequence: input.sequence,
		delta: input.delta,
		payload,
		runtimeBackend: KERNEL_RUNTIME_BACKEND,
		runtimeExternalId: input.runId,
		runtimeMetadata: input.runtimeMetadata,
		createdAt,
	});
	return {
		id: event.id,
		organizationId: event.organizationId,
		kind: event.kind,
		conversationId: event.conversationId,
		runId: event.runId,
		messageId: event.messageId,
		causeEventId: event.causeEventId,
		delegatedTediId: event.delegatedTediId,
		childRunId: event.childRunId,
		sequence: event.sequence,
		delta: event.delta,
		payload:
			event.payload === undefined ? undefined : toJsonRecord(event.payload),
		runtimeBackend: event.runtime?.backend ?? KERNEL_RUNTIME_BACKEND,
		runtimeExternalId: event.runtime?.externalId,
		runtimeMetadata:
			event.runtime?.metadata === undefined
				? undefined
				: toJsonRecord(event.runtime.metadata),
		createdAt: event.createdAt,
	};
}

async function notifyPersistedPush(
	context: BaseContext,
	row: KernelRuntimeEventRow,
) {
	if (row.kind !== "approval.requested" && row.kind !== "run.completed") return;
	if (
		!context.env?.VAPID_PUBLIC_KEY ||
		!context.env.VAPID_PRIVATE_KEY ||
		!context.env.VAPID_SUBJECT
	)
		return;
	const work = import("../../../services/web-push")
		.then(({ deliverWebPush }) => deliverWebPush(context, row))
		.catch(() => {
			console.warn("web_push_unavailable");
		});
	if (context.waitUntil) context.waitUntil(work);
	else await work;
}

/**
 * Finish a persisted event: write-through to the durable Home conversation
 * index only on a REAL insert (an idempotent replay returns the existing row
 * and must not double-count). Fail-soft inside; no-op for kinds the projection
 * does not track.
 */
async function finishPersistedKernelRuntimeEvent(
	context: BaseContext,
	persisted: { row: KernelRuntimeEventRow; inserted: boolean },
): Promise<{ event: KernelRuntimeEvent; inserted: boolean }> {
	if (persisted.inserted) {
		await applyKernelConversationEvent(context.db, persisted.row);
		await notifyPersistedPush(context, persisted.row);
	}
	return {
		event: normalizeHomeEvent(persisted.row),
		inserted: persisted.inserted,
	};
}

export async function insertKernelRuntimeEventWithStatus(
	context: BaseContext,
	input: KernelRuntimeEventInsertInput,
): Promise<{ event: KernelRuntimeEvent; inserted: boolean }> {
	let inserted;
	try {
		inserted = await insertKernelRuntimeEventIfAbsent(
			context.db,
			buildKernelRuntimeEventRow(context, input),
		);
	} catch (error) {
		if (error instanceof KernelRuntimeEventConflictError)
			throw createError(
				ErrorCodes.CONFLICT,
				"Kernel runtime event conflicts with immutable causal identity",
			);
		throw error;
	}
	if (inserted.row)
		return finishPersistedKernelRuntimeEvent(context, {
			row: inserted.row,
			inserted: inserted.inserted,
		});
	throw createError(
		ErrorCodes.INTERNAL_SERVER_ERROR,
		"kernel runtime event insert was ignored and no existing event was found",
	);
}

/** Input of {@link persistKernelTurnSettlement}. */
export interface KernelTurnSettlementInput {
	/** Hold the derived index after settlement; await it when no holder exists. */
	holdAfterSettle?: (work: Promise<void>) => void;
	approvalReceipt?: import("@tedix/db/queries/approval-simulations").RecordApprovalExecutionReceiptParams;
	run: TransitionKernelRuntimeRunStatusParams;
	/** `message.completed` first, the terminal receipt second. */
	events: readonly [
		assistant: KernelRuntimeEventInsertInput,
		terminal: KernelRuntimeEventInsertInput,
	];
}

/**
 * Land a turn's terminal run patch, its `message.completed` row and its
 * terminal receipt in one D1 batch (`settleKernelRuntimeTurn`), then run the
 * conversation-index write-through for each freshly inserted row, held after
 * settlement when the caller supplies a holder. Same durability and
 * idempotency as three sequential
 * {@link insertKernelRuntimeEvent} / `transitionKernelRuntimeRunStatus`
 * calls, with one primary round trip instead of three.
 */
export async function persistKernelTurnSettlement(
	context: BaseContext,
	input: KernelTurnSettlementInput,
): Promise<{
	runTransitioned: boolean;
	assistantEvent: KernelRuntimeEvent;
	terminalEvent: KernelRuntimeEvent;
}> {
	const settled = await settleKernelRuntimeTurn(context.db, {
		approvalReceipt: input.approvalReceipt,
		run: input.run,
		events: input.events.map((event) =>
			buildKernelRuntimeEventRow(context, event),
		),
	});
	const [assistant, terminal] = settled.events;
	if (!assistant || !terminal)
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"kernel turn settlement batch returned fewer events than it wrote",
		);
	// The canonical transcript and receipt are durable. Keep the rebuildable
	// conversation index alive without making the final answer wait for it.
	const projection = Promise.all(
		[assistant, terminal]
			.filter((event) => event.inserted)
			.map(async (event) => {
				await applyKernelConversationEvent(context.db, event.row);
				await notifyPersistedPush(context, event.row);
			}),
	).then(() => undefined);
	if (input.holdAfterSettle) input.holdAfterSettle(projection);
	else await projection;
	return {
		runTransitioned: settled.runTransitioned,
		assistantEvent: normalizeHomeEvent(assistant.row),
		terminalEvent: normalizeHomeEvent(terminal.row),
	};
}

export async function insertKernelRuntimeEvent(
	context: BaseContext,
	input: KernelRuntimeEventInsertInput,
): Promise<KernelRuntimeEvent> {
	return (await insertKernelRuntimeEventWithStatus(context, input)).event;
}

export interface KernelRuntimeRunInsertInput {
	id: string;
	organizationId: string;
	conversationId: string;
	status: TediRunStatus;
	inputMessageId?: string;
	outputMessageId?: string;
	delegatedTediId?: string;
	childRunId?: string;
	childConversationId?: string | null;
	progress?: ReturnType<typeof homeRunProgress>;
	metadata?: Record<string, unknown>;
	runtimeMetadata?: Record<string, unknown>;
	startedAt?: string;
	completedAt?: string | null;
	createdAt?: string;
	updatedAt?: string;
}

/** The persistable row for one kernel runtime run input. */
function buildKernelRuntimeRunRow(
	input: KernelRuntimeRunInsertInput,
): NewKernelRuntimeRun {
	const createdAt = input.createdAt ?? nowIso();
	const progress =
		input.progress ??
		homeRunProgress({
			eventCount: 0,
			status: input.status,
		});
	return {
		id: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		status: input.status,
		inputMessageId: input.inputMessageId,
		outputMessageId: input.outputMessageId,
		delegatedTediId: input.delegatedTediId,
		childRunId: input.childRunId,
		childConversationId: input.childConversationId ?? undefined,
		progressValue: progress.current,
		progressLabel: progress.label,
		progressDetail: progress.detail,
		runtimeBackend: KERNEL_RUNTIME_BACKEND,
		runtimeExternalId: input.id,
		runtimeMetadata:
			input.runtimeMetadata === undefined
				? undefined
				: toJsonRecord(input.runtimeMetadata),
		metadata:
			input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
		startedAt: input.startedAt ?? createdAt,
		completedAt: input.completedAt ?? undefined,
		createdAt,
		updatedAt: input.updatedAt ?? input.completedAt ?? createdAt,
	};
}

/**
 * Durable submission ledger: admit + open the first attempt for this kernel
 * run. Idempotent (deterministic submission id), additive, never throws.
 * Awaited, never offloaded: this row is what the crash sweep reconciles
 * from, so admitting it on a background task made the recovery plane
 * conditional on the same isolate that the failure kills: an eviction would
 * take the dispatch and its admission together, leaving the sweep nothing
 * to recover. The cost is one D1 write on the run-insert receipt; `.catch`
 * keeps a ledger fault from failing the run.
 */
async function admitKernelRunSubmission(
	context: BaseContext,
	input: KernelRuntimeRunInsertInput,
	admitted?: RuntimeSubmission,
): Promise<void> {
	await recordKernelSubmissionStarted(context.db, {
		runId: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		idempotencyKey:
			typeof input.metadata?.idempotencyKey === "string"
				? input.metadata.idempotencyKey
				: input.id,
		delegatedTediId: input.delegatedTediId ?? null,
		createdAt: input.createdAt ?? nowIso(),
		admitted,
	}).catch(() => {});
}

export async function insertKernelRuntimeRun(
	context: BaseContext,
	input: KernelRuntimeRunInsertInput,
): Promise<void> {
	await insertKernelRuntimeRunIfAbsent(
		context.db,
		buildKernelRuntimeRunRow(input),
	);
	await admitKernelRunSubmission(context, input);
}

/** Input of {@link persistKernelTurnStart}. */
export interface KernelTurnStartInput {
	run: KernelRuntimeRunInsertInput;
	/**
	 * `message.received` first, `run.started` second. The second's
	 * `causeEventId` is the first's id on a first delivery.
	 */
	events: readonly [
		received: KernelRuntimeEventInsertInput,
		started: Omit<KernelRuntimeEventInsertInput, "causeEventId">,
	];
	/**
	 * The `run.started` cause of a previously persisted delivery of this turn
	 * (`existingRunStartedCause`): `undefined` for a first delivery, otherwise
	 * the stored cause. A replay skips the conversation-index bump so it is
	 * never double-counted.
	 */
	priorCause: string | null | undefined;
	/** The submission `claimKernelExecutionPolicy` already admitted for this run. */
	submission?: RuntimeSubmission;
}

/**
 * Land a turn's ingress — the `message.received` row, its cause-bound
 * `run.started`, the run row and the conversation-index bump — in one D1
 * batch (`openKernelRuntimeTurn`), then admit the submission ledger. Same
 * durability, ordering and idempotency as the former sequential
 * {@link insertKernelRuntimeEvent} ×2 + {@link insertKernelRuntimeRun} calls,
 * with one primary round trip instead of four.
 */
export async function persistKernelTurnStart(
	context: BaseContext,
	input: KernelTurnStartInput,
): Promise<{
	receivedEvent: KernelRuntimeEvent;
	startedEvent: KernelRuntimeEvent;
	inserted: boolean;
}> {
	const received = buildKernelRuntimeEventRow(context, input.events[0]);
	const started = buildKernelRuntimeEventRow(context, {
		...input.events[1],
		causeEventId:
			input.priorCause === undefined ? received.id : input.priorCause,
	});
	const personStarted =
		context.authType === "user" &&
		!!context.userId &&
		resolveKernelConversationOrigin(context) === "human";
	const run = buildKernelRuntimeRunRow({
		...input.run,
		metadata: {
			...input.run.metadata,
			...(context.ownerHostSessionId
				? { ownerHostSessionId: context.ownerHostSessionId }
				: {}),
			pushRecipient: personStarted
				? {
						descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
						personStarted: true,
					}
				: null,
		},
	});
	// The projection reads only the fields the insert value shares with the
	// stored row.
	const conversation =
		input.priorCause === undefined
			? kernelConversationMessageParams(received as KernelRuntimeEventRow)
			: null;
	// A freshly admitted submission opens its first attempt inside the batch,
	// so nothing but the index write-through stands between the run row landing
	// and the KernelDO call; a re-sent run takes the separate admit below.
	const submission = input.submission
		? kernelFirstAttemptBatch({
				runId: input.run.id,
				organizationId: input.run.organizationId,
				conversationId: input.run.conversationId,
				createdAt: input.run.createdAt,
				admitted: input.submission,
			})
		: null;
	let opened: Awaited<ReturnType<typeof openKernelRuntimeTurn>>;
	let indexBumped = conversation !== null;
	try {
		try {
			opened = await openKernelRuntimeTurn(context.db, {
				run,
				events: [received, started],
				conversation,
				submission,
			});
		} catch (error) {
			// The index is a rebuildable read model and its write-through has
			// always been fail-soft; a batch is atomic, so a failed one wrote
			// nothing and the ingress rows land again without the bump, which then
			// takes the write-through below (fail-soft there too).
			if (!conversation || error instanceof KernelRuntimeEventConflictError)
				throw error;
			console.warn(
				"[kernelRuntime] turn-start batch failed with the conversation-index bump; retrying without it",
				errorMessage(error),
			);
			indexBumped = false;
			opened = await openKernelRuntimeTurn(context.db, {
				run,
				events: [received, started],
				conversation: null,
				submission,
			});
		}
	} catch (error) {
		if (error instanceof KernelRuntimeEventConflictError)
			throw createError(
				ErrorCodes.CONFLICT,
				"Kernel runtime event conflicts with immutable causal identity",
			);
		throw error;
	}
	const [receivedPersisted, startedPersisted] = opened.events;
	if (!receivedPersisted || !startedPersisted)
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"kernel turn start batch returned fewer events than it wrote",
		);
	// A first delivery bumped the index inside the batch. A replay that still
	// inserted (a legacy partial write) takes the write-through instead.
	// The index write-through(s) and a separate submission admit touch
	// different rows, so they go out together.
	const [receivedEvent, startedEvent] = await Promise.all([
		indexBumped
			? Promise.resolve({
					event: normalizeHomeEvent(receivedPersisted.row),
					inserted: receivedPersisted.inserted,
				})
			: finishPersistedKernelRuntimeEvent(context, receivedPersisted),
		finishPersistedKernelRuntimeEvent(context, startedPersisted),
		submission
			? undefined
			: admitKernelRunSubmission(context, input.run, input.submission),
	]);
	return {
		receivedEvent: receivedEvent.event,
		startedEvent: startedEvent.event,
		inserted: receivedPersisted.inserted,
	};
}

/**
 * Orphan-sweep propagation: when `sweepOrphanRuns` seals a delegated CHILD run
 * as `run.failed` (runtime dropped, no terminal event), the parent Home run
 * and its delegation receipt otherwise keep saying "Running" forever — the
 * read-path reconcile only re-derives from child status when the row is read,
 * and a sealed child with no operator reading the thread never gets there.
 *
 * Resolves the Home run row by (org, delegated tedi, child run id) and, when
 * it is still non-terminal, drives it through the EXISTING failure path
 * ({@link recordHomeDelegationDispatchFailure}: run row → failed, `run.failed`
 * + `message.completed` events, delegation failure envelope). A row already
 * terminal, or no linked Home run, is a no-op. Fail-soft: returns whether a
 * propagation happened; never throws (the sweep records its own errors).
 */
export async function propagateSweptChildFailureToHomeRun(
	context: BaseContext,
	input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
		/** Why the sweep sealed the child — surfaces in the failure envelope. */
		message: string;
		failedAt?: string;
	},
): Promise<boolean> {
	try {
		const row = await findKernelRuntimeRunByChild(context.db, {
			organizationId: input.organizationId,
			delegatedTediId: input.delegatedTediId,
			childRunId: input.childRunId,
		});
		if (!row) return false;
		if (
			row.status === "completed" ||
			row.status === "failed" ||
			row.status === "canceled"
		) {
			return false;
		}
		await recordHomeDelegationDispatchFailure(context, {
			childConversationId: stringFromPayload(
				nonNullRecord(row.metadata)?.childConversationId,
			),
			childRunId: input.childRunId,
			conversationId: row.conversationId,
			delegatedTediId: input.delegatedTediId,
			error: input.message,
			existingMetadata: nonNullRecord(row.metadata),
			failedAt: input.failedAt,
			organizationId: input.organizationId,
			reason: "runtime_unavailable",
			runId: row.id,
		});
		return true;
	} catch (error) {
		console.warn("[kernelRuntime] swept-child failure propagation failed", {
			childRunId: input.childRunId,
			error: errorMessage(error),
		});
		return false;
	}
}

export async function recordHomeDelegationDispatchFailure(
	context: BaseContext,
	input: {
		childConversationId?: string | null;
		childRunId: string;
		conversationId: string;
		delegatedTediId: string;
		error: string;
		existingMetadata?: Record<string, unknown> | null;
		failedAt?: string;
		organizationId: string;
		/**
		 * Terminal reason for the child run failure. Use `runtime_unavailable` when
		 * the runtime preflight determined the target is unreachable/stopped and
		 * dispatch was never attempted. Defaults to `dispatch_failed`.
		 */
		reason?: "dispatch_failed" | "runtime_unavailable";
		runId: string;
	},
): Promise<void> {
	const failedAt = input.failedAt ?? nowIso();
	const reason = input.reason ?? "dispatch_failed";
	const progress = homeRunProgress({
		eventCount: 0,
		status: "failed",
	});
	const preview = `Delegated child dispatch failed: ${input.error}`;
	const nextMetadata = {
		...input.existingMetadata,
		childConversationId: input.childConversationId ?? null,
		childRunId: input.childRunId,
		childRunLatestEventAt: failedAt,
		childRunLatestEventKind: "run.failed",
		childRunPreview: preview,
		childRunStatus: "failed",
		delegatedTediId: input.delegatedTediId,
		delegationFailure: buildDelegationFailureEnvelope({
			reason,
			error: input.error,
		}),
		idempotencyKey: input.runId,
		progress,
		source: "kernelRuntime.delegateDispatch",
	};
	try {
		await updateKernelRuntimeRunForOrg(context.db, {
			id: input.runId,
			organizationId: input.organizationId,
			patch: {
				status: "failed",
				progressValue: progress.current,
				progressLabel: progress.label,
				progressDetail: progress.detail,
				latestEventKind: "run.failed",
				latestEventAt: failedAt,
				preview,
				completedAt: failedAt,
				updatedAt: failedAt,
				metadata: toJsonRecord(nextMetadata),
			},
		});
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: "run.failed",
				conversationId: input.conversationId,
				runId: input.runId,
				suffix: "delegation-dispatch",
			}),
			organizationId: input.organizationId,
			kind: "run.failed",
			conversationId: input.conversationId,
			runId: input.runId,
			delegatedTediId: input.delegatedTediId,
			childRunId: input.childRunId,
			payload: {
				status: "failed",
				error: input.error,
				reason,
				progress,
			},
			runtimeMetadata: nextMetadata,
			createdAt: failedAt,
		});
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: "message.completed",
				conversationId: input.conversationId,
				runId: input.runId,
				suffix: "delegation-dispatch-failed",
			}),
			organizationId: input.organizationId,
			kind: "message.completed",
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: asyncCompletionAssistantMessageId(input.runId),
			delegatedTediId: input.delegatedTediId,
			childRunId: input.childRunId,
			payload: {
				role: "assistant",
				content: homeDelegationCompletionContent({
					preview,
					status: "failed",
				}),
				channel: "home",
				metadata: {
					asyncCompletion: true,
					homeSubject: true,
					...nextMetadata,
					// Always status-only: this recorder has no child transcript to
					// relay, so the body is the (status, preview) template and the
					// receipt on this same row renders "Delegated to {tedi} · Failed"
					// plus the exact delegation failure envelope error.
					...homeNarrationMetadata("delegation_status_only"),
				},
			},
			runtimeMetadata: {
				asyncCompletion: true,
				...nextMetadata,
			},
			createdAt: failedAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] delegated dispatch failure write failed", {
			childRunId: input.childRunId,
			error: errorMessage(error),
			runId: input.runId,
		});
	}
}
