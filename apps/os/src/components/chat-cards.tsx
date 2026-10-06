import {
	ArrowCounterClockwise,
	CaretRight,
	Check,
	ShieldWarning,
	StopCircle,
	TreeStructure,
	Wrench,
	X,
} from "@phosphor-icons/react";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type {
	HomeRun,
	HomeRunSet,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { OsRouterLink } from "@/components/kumo/link-provider";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import { sentenceCase } from "@/lib/format";
import { absoluteTime, formatDurationMs, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { cn } from "@/lib/utils";
import { asRecord } from "@tedix/api-contract/utils/is-record";

// UNTRUSTED TEXT. Every string these cards render that an MCP server or a tool
// authored — tool name, app slug, arg/result/error preview, approval summary,
// operator question, delegated-tedi label, activity label — goes through
// `sanitizeUntrustedText` AT THE RENDER SITE. Not at construction: these
// components are exported and a caller can hand them state built anywhere, so
// the render is the only point that cannot be bypassed. `ChatMarkdown` is the
// other half of the same chokepoint for the markdown path.

// ---------------------------------------------------------------------------
// Shared pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Compact previews (args/result/error) are clamped to this many characters. */
export const PREVIEW_MAX_LENGTH = 160;

/**
 * One-line preview of an arbitrary payload value. Strings render verbatim
 * (whitespace collapsed); everything else is JSON. Returns null for
 * empty/absent values so callers can skip the row entirely — the Home tool
 * event path persists NO args/result previews, so null is the common case.
 *
 * The value is tool-authored, so it goes through `sanitizeUntrustedText`
 * BEFORE the clamp: stripping afterwards would let an invisible control eat
 * budget the operator never sees, and a control cut in half by the clamp is
 * still a control.
 */
export function compactPreview(
	value: unknown,
	max: number = PREVIEW_MAX_LENGTH,
): string | null {
	if (value === null || value === undefined) return null;
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value) ?? String(value);
		} catch {
			text = String(value);
		}
	}
	text = sanitizeUntrustedText(text).replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

// Injectable-link seam shared by every run chip. Tests can pass a stub when
// rendering without a RouterProvider.
export type CardRunLinkProps = {
	to: "/work/runs/$runId" | "/work/executions/$runId";
	params: { runId: string };
	search?: { branch?: string };
	className?: string;
	title?: string;
	"aria-label"?: string;
	children?: ReactNode;
};
const DefaultCardRunLink: ComponentType<CardRunLinkProps> = OsRouterLink;

/** THE run linkage chip — used by chat bubbles and every live card. */
export function RunLinkChip({
	runId,
	label = "Run details",
	LinkComponent = DefaultCardRunLink,
}: {
	runId: string;
	label?: string;
	LinkComponent?: ComponentType<CardRunLinkProps>;
}) {
	return (
		<LinkComponent
			to="/work/runs/$runId"
			params={{ runId }}
			title={`Open run ${runId}`}
			aria-label={`Open ${label.toLowerCase()} for run ${runId}`}
			className="inline-flex items-center gap-0.5 rounded-full border border-kumo-hairline bg-kumo-fill px-2 py-0.5 text-kumo-subtle text-xs no-underline transition-colors hover:text-kumo-strong"
		>
			{label}
			<CaretRight size={11} aria-hidden />
		</LinkComponent>
	);
}

/** Home/kernel execution linkage; never feed these ids to the skill-run route. */
export function ExecutionLinkChip({
	runId,
	branch,
	label = "View execution",
	appearance = "chip",
	LinkComponent = DefaultCardRunLink,
}: {
	runId: string;
	branch?: string;
	label?: string;
	appearance?: "chip" | "inline";
	LinkComponent?: ComponentType<CardRunLinkProps>;
}) {
	return (
		<LinkComponent
			to="/work/executions/$runId"
			params={{ runId }}
			search={branch ? { branch } : undefined}
			title={`Open Home execution ${runId}`}
			aria-label={`Open ${label.toLowerCase()} for Home run ${runId}`}
			className={cn(
				"inline-flex items-center gap-0.5 text-kumo-subtle text-xs no-underline transition-colors hover:text-kumo-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus",
				appearance === "chip"
					? "rounded-full border border-kumo-hairline bg-kumo-fill px-2 py-0.5"
					: "min-h-8 rounded-md px-1 max-sm:min-h-11 coarse:min-h-11",
			)}
		>
			{label}
			<CaretRight size={11} aria-hidden />
		</LinkComponent>
	);
}

/** Human label for a protocol tool id; the exact id remains available as title text. */
export function toolCallLabel(name: string): string {
	const safe = sanitizeUntrustedText(name).trim();
	if (!safe) return "Tool action";
	return sentenceCase(safe.replace(/[._:/-]+/g, " ").replace(/\s+/g, " "));
}

// ---------------------------------------------------------------------------
// Tool-call state reducer
// ---------------------------------------------------------------------------

export type ToolCallStatus = "running" | "completed" | "failed";

export type ToolCallState = {
	toolCallId: string;
	/** Tool name from the event payload; "tool" until a frame carries one. */
	name: string;
	appSlug: string | null;
	status: ToolCallStatus;
	runId: string | null;
	/** The Home path persists no previews — these stay null there. */
	argsPreview: string | null;
	resultPreview: string | null;
	errorPreview: string | null;
	startedAt: string | null;
	endedAt: string | null;
	/** Derivable only when both started and terminal frames were seen. */
	durationMs: number | null;
};

export const TOOL_EVENT_KINDS: ReadonlySet<string> = new Set([
	"tool.started",
	"tool.completed",
	"tool.failed",
]);

function deriveDurationMs(
	startedAt: string | null,
	endedAt: string | null,
): number | null {
	if (!startedAt || !endedAt) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
	return end - start;
}

/**
 * Folds an event feed into per-tool-call state keyed by `toolCallId`
 * (insertion-ordered by first appearance). Idempotent under re-delivery —
 * event ids are deterministic per (kind, toolCallId), so replaying a frame is
 * a plain overwrite. Out-of-order safe: a terminal frame arriving before its
 * `tool.started` wins on status; the late `tool.started` only backfills
 * startedAt/name/args. `toolCallId` is read from the top-level column when the
 * feed came from `readRunEvents`, falling back to `payload.toolCallId` — the
 * the stream row only carries it inside the payload.
 */
export function mergeToolEvents(
	frames: readonly RuntimeStreamEvent[],
): Map<string, ToolCallState> {
	const byCall = new Map<string, ToolCallState>();
	for (const frame of frames) {
		if (!TOOL_EVENT_KINDS.has(frame.kind)) continue;
		const payload: Record<string, unknown> = frame.payload ?? {};
		const toolCallId = frame.toolCallId ?? asString(payload.toolCallId);
		if (!toolCallId) continue;
		let state = byCall.get(toolCallId);
		if (!state) {
			state = {
				toolCallId,
				name: "tool",
				appSlug: null,
				status: "running",
				runId: null,
				argsPreview: null,
				resultPreview: null,
				errorPreview: null,
				startedAt: null,
				endedAt: null,
				durationMs: null,
			};
			byCall.set(toolCallId, state);
		}
		const name = asString(payload.name);
		if (name) state.name = name;
		const appSlug = asString(payload.appSlug);
		if (appSlug) state.appSlug = appSlug;
		if (frame.runId) state.runId = frame.runId;
		if (frame.kind === "tool.started") {
			// Never downgrade a terminal status on out-of-order arrival.
			state.startedAt = frame.createdAt;
			if ("args" in payload) {
				state.argsPreview = compactPreview(payload.args);
			}
		} else {
			state.status = frame.kind === "tool.completed" ? "completed" : "failed";
			state.endedAt = frame.createdAt;
			if (frame.kind === "tool.completed" && "result" in payload) {
				state.resultPreview = compactPreview(payload.result);
			}
			if (frame.kind === "tool.failed") {
				state.errorPreview =
					compactPreview(payload.error) ?? compactPreview(payload.result);
			}
		}
		state.durationMs = deriveDurationMs(state.startedAt, state.endedAt);
	}
	return byCall;
}

/**
 * Chronological order for the live tool-card block: earliest activity first
 * (startedAt, else endedAt for calls whose start frame never arrived),
 * insertion order preserved on ties.
 */
export function sortToolStates(
	states: Iterable<ToolCallState>,
): ToolCallState[] {
	return [...states].sort((a, b) => {
		const at = Date.parse(a.startedAt ?? a.endedAt ?? "") || 0;
		const bt = Date.parse(b.startedAt ?? b.endedAt ?? "") || 0;
		return at - bt;
	});
}

/**
 * Prunes tool frames of runs that have LEFT the active set — a completed
 * run's durable evidence lives in the transcript and run detail, so its live
 * cards must not accumulate below fresh messages in a long-lived tab.
 * `seenActive` (mutated) tracks which runs were ever observed active so a
 * not-yet-listed streaming run is never pruned prematurely. Returns whether
 * any frame was dropped.
 */
export function pruneDepartedRunFrames(
	frames: Map<string, RuntimeStreamEvent>,
	seenActive: Set<string>,
	activeRunIds: readonly string[],
): boolean {
	const active = new Set(activeRunIds);
	for (const runId of activeRunIds) seenActive.add(runId);
	let changed = false;
	// Deleting the current entry mid-iteration is safe for Set iterators.
	for (const runId of seenActive) {
		if (active.has(runId)) continue;
		seenActive.delete(runId);
		for (const [id, frame] of frames) {
			if (frame.runId === runId) {
				frames.delete(id);
				changed = true;
			}
		}
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Status chips
// ---------------------------------------------------------------------------

const TOOL_STATUS_VARIANTS: Record<ToolCallStatus, BadgeVariant> = {
	running: "info",
	completed: "success",
	failed: "error",
};

const RUN_STATUS_VARIANTS: Record<TediRunStatus, BadgeVariant> = {
	queued: "info",
	running: "info",
	completed: "success",
	failed: "error",
	canceled: "secondary",
	requires_approval: "warning",
};

export function RunStatusChip({ status }: { status: TediRunStatus }) {
	return (
		<Badge
			variant={RUN_STATUS_VARIANTS[status] ?? "secondary"}
			data-status={status}
		>
			{sentenceCase(status)}
		</Badge>
	);
}

// ---------------------------------------------------------------------------
// <ToolCallCard/>
// ---------------------------------------------------------------------------

/**
 * Live card for one tool call. Pure: takes the merged state from
 * `mergeToolEvents` and re-renders in place as the entry's status flips —
 * identity is `toolCallId`, so key the list on it.
 */
export function ToolCallCard({ tool }: { tool: ToolCallState }) {
	const running = tool.status === "running";
	return (
		<li
			data-slot="tool-call-card"
			data-tool-status={tool.status}
			className="flex w-full justify-start"
		>
			<div className="flex min-w-0 max-w-full flex-1 flex-col gap-1 rounded-xl px-1.5 py-1 text-kumo-subtle">
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					{/*
					 * Decorative: the adjacent status Badge already names the state,
					 * and Kumo's `Loader` carries its own `role="status"` — hiding the
					 * wrapper keeps the transcript from announcing it twice.
					 */}
					<span
						aria-hidden="true"
						className="flex size-5 shrink-0 items-center justify-center"
					>
						{running ? (
							<Loader aria-label="Tool call running" size={15} />
						) : (
							<Wrench size={15} />
						)}
					</span>
					<Text
						as="span"
						truncate
						className="flex-1"
						title={sanitizeUntrustedText(tool.name)}
					>
						{toolCallLabel(tool.name)}
					</Text>
					{tool.appSlug ? (
						<Badge variant="outline">
							{sanitizeUntrustedText(tool.appSlug)}
						</Badge>
					) : null}
					<Badge variant={TOOL_STATUS_VARIANTS[tool.status]}>
						{sentenceCase(tool.status)}
					</Badge>
					{tool.durationMs !== null ? (
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="tabular-nums"
						>
							{formatDurationMs(tool.durationMs)}
						</Text>
					) : null}
				</span>
				{tool.argsPreview ? (
					<Text
						as="span"
						role="label"
						tone="mono-secondary"
						className="break-all pl-7"
					>
						{sanitizeUntrustedText(tool.argsPreview)}
					</Text>
				) : null}
				{tool.status === "completed" && tool.resultPreview ? (
					<Text
						as="span"
						role="label"
						tone="mono-secondary"
						className="break-all pl-7"
					>
						{sanitizeUntrustedText(tool.resultPreview)}
					</Text>
				) : null}
				{tool.status === "failed" ? (
					<Text as="span" role="label" tone="error" className="break-all pl-7">
						{tool.errorPreview
							? sanitizeUntrustedText(tool.errorPreview)
							: "The tool call failed."}
					</Text>
				) : null}
			</div>
		</li>
	);
}

/** Compact trace summary; detailed tool evidence is disclosed on demand. */
export function WorkTraceCard({ tools }: { tools: readonly ToolCallState[] }) {
	const [open, setOpen] = useState(false);
	const running = tools.filter((tool) => tool.status === "running").length;
	const failed = tools.filter((tool) => tool.status === "failed").length;
	const label = running
		? `Working — ${running} action${running === 1 ? "" : "s"} in progress`
		: failed
			? `${failed} action${failed === 1 ? "" : "s"} need attention`
			: `${tools.length} action${tools.length === 1 ? "" : "s"} completed`;
	return (
		<li data-slot="work-trace-card" className="flex w-full justify-start">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
					<Wrench size={15} aria-hidden />
					<Text as="span" truncate className="flex-1">
						{label}
					</Text>
					<Badge variant={failed ? "error" : running ? "info" : "success"}>
						{tools.length}
					</Badge>
					<CaretRight
						size={14}
						className={cn("transition-transform", open && "rotate-90")}
						aria-hidden
					/>
				</CollapsibleTrigger>
				<CollapsibleContent className="mt-1 grid gap-1 rounded-xl border border-kumo-hairline bg-kumo-tint p-2">
					{tools.map((tool) => (
						<ToolCallCard key={tool.toolCallId} tool={tool} />
					))}
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

// ---------------------------------------------------------------------------
// <DelegationWorkCard/>
// ---------------------------------------------------------------------------

export type DelegationWork = {
	/** Parent Home run id — the cancel/steer/retry target. */
	runId: string;
	childRunId: string | null;
	delegatedTediId: string | null;
	status: TediRunStatus;
	/** Child-run activity label (from readRunEvents/child evidence), if any. */
	activityLabel?: string | null;
	/**
	 * `metadata.delegationProof` on the parent run: the kernel's verdict on the
	 * delegated result's evidence. Rendered as a chip, never as prose — the
	 * assistant body no longer carries proof notes.
	 */
	proof?: DelegationProof | null;
};

export type DelegationProof = { verdict: string; note: string | null };

/** Reads `metadata.delegationProof = { verdict, note }` off a run. */
export function delegationProofFromRun(run: HomeRun): DelegationProof | null {
	const proof = asRecord(asRecord(run.metadata)?.delegationProof);
	if (!proof || typeof proof.verdict !== "string" || !proof.verdict.trim()) {
		return null;
	}
	return {
		verdict: proof.verdict.trim(),
		note:
			typeof proof.note === "string" && proof.note.trim()
				? proof.note.trim()
				: null,
	};
}

const PROOF_VERDICT_VARIANTS: Record<string, BadgeVariant> = {
	verified: "success",
	proven: "success",
	passed: "success",
	unverified: "warning",
	partial: "warning",
	inconclusive: "warning",
	failed: "error",
	refuted: "error",
	rejected: "error",
};

export function DelegationProofChip({ proof }: { proof: DelegationProof }) {
	const verdict = sanitizeUntrustedText(proof.verdict);
	const note = proof.note ? sanitizeUntrustedText(proof.note) : null;
	return (
		<Badge
			data-slot="delegation-proof"
			data-verdict={verdict.toLowerCase()}
			title={note ?? undefined}
			variant={PROOF_VERDICT_VARIANTS[verdict.toLowerCase()] ?? "secondary"}
		>
			Proof: {sentenceCase(verdict)}
		</Badge>
	);
}

/**
 * Projects a run-set row into delegation-card state; null when the run
 * delegated nothing. `delegatedTediId`/`childRunId` also arrive on the
 * parent-stream `message.completed`/terminal payloads — the run set is the
 * durable join.
 */
export function delegationFromRun(run: HomeRun): DelegationWork | null {
	const childRunId = run.childRunId ?? null;
	const delegatedTediId = run.delegatedTediId ?? null;
	if (!childRunId && !delegatedTediId) return null;
	return {
		runId: run.id,
		childRunId,
		delegatedTediId,
		status: run.status,
		activityLabel: run.progress?.label ?? run.progress?.detail ?? null,
		proof: delegationProofFromRun(run),
	};
}

const TERMINAL_RUN_STATUSES: ReadonlySet<TediRunStatus> =
	new Set<TediRunStatus>(["completed", "failed", "canceled"]);

/**
 * Deduplicates delegation cards by delegated work identity
 * (`childRunId ?? runId`): N run-set rows carrying the same child run must
 * render ONE card. A terminal row beats an active one; among equals the
 * newest `createdAt` wins, so the card always shows the latest status.
 */
export function dedupeDelegations(runs: readonly HomeRun[]): DelegationWork[] {
	const byKey = new Map<
		string,
		{ work: DelegationWork; createdAt: number; terminal: boolean }
	>();
	for (const run of runs) {
		const work = delegationFromRun(run);
		if (!work) continue;
		const key = work.childRunId ?? work.runId;
		const terminal = TERMINAL_RUN_STATUSES.has(work.status);
		const createdAt = Date.parse(run.createdAt) || 0;
		const existing = byKey.get(key);
		const wins =
			!existing ||
			(terminal && !existing.terminal) ||
			(terminal === existing.terminal && createdAt >= existing.createdAt);
		if (wins) byKey.set(key, { work, createdAt, terminal });
	}
	return [...byKey.values()].map((entry) => entry.work);
}

export function DelegationWorkCard({
	work,
	tediName,
	LinkComponent,
}: {
	work: DelegationWork;
	/** Display name for the delegated tedi; never present an opaque id as a name. */
	tediName?: string | null;
	LinkComponent?: ComponentType<CardRunLinkProps>;
}) {
	const active = work.status === "queued" || work.status === "running";
	const who =
		sanitizeUntrustedText(tediName ?? "").trim() || "a digital worker";
	return (
		<li
			data-slot="delegation-work-card"
			data-run-status={work.status}
			className="flex w-full justify-start"
		>
			<div className="flex min-w-0 max-w-full flex-1 flex-col gap-1 rounded-xl px-1.5 py-1 text-kumo-subtle">
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					{/* Decorative — see the note in `ToolCallCard`. */}
					<span
						aria-hidden="true"
						className="flex size-5 shrink-0 items-center justify-center"
					>
						{active ? (
							<Loader aria-label="Delegated work running" size={15} />
						) : (
							<TreeStructure size={15} />
						)}
					</span>
					<Text as="span" truncate className="flex-1">
						Delegated to{" "}
						<Text as="strong" weight="medium">
							{who}
						</Text>
					</Text>
					<RunStatusChip status={work.status} />
					{work.proof ? <DelegationProofChip proof={work.proof} /> : null}
					<ExecutionLinkChip
						runId={work.runId}
						branch={work.childRunId ?? undefined}
						label="View delegation"
						LinkComponent={LinkComponent}
					/>
				</span>
				{work.activityLabel ? (
					<Text
						as="span"
						role="label"
						tone="secondary"
						truncate
						className="pl-7"
					>
						{sanitizeUntrustedText(work.activityLabel)}
					</Text>
				) : null}
			</div>
		</li>
	);
}

// ---------------------------------------------------------------------------
// <ApprovalCard/>
// ---------------------------------------------------------------------------

export type ApprovalCardData = {
	/** approvalRequestId — the identity handed back to onResolve. */
	approvalId: string;
	/** The PARENT Home run to respond on (`kernelRuntime.respondApproval`). */
	runId: string;
	summary: string;
	/** operatorQuestion / args preview — the secondary explanatory line. */
	detail?: string | null;
	tediName?: string | null;
	status: "pending" | "escalated";
	/** Defaults to "approve_or_reject"; "no_action" renders without buttons. */
	decisionMode?: "approve_or_reject" | "no_action";
	/** Replaces the generic "no_action" explanation when a card knows why. */
	noActionNote?: string;
	/** Expired approvals are denied by default and render without buttons. */
	expired?: boolean;
	requestedAt?: string | null;
	/** In-memory-only CLI-compatible scope for "always allow this session". */
	sessionScopeKey?: string;
};

/** Payload shape of `metadata.kernelWriteProposal` on `message.completed`. */

/**
 * Pending delegation approvals for a conversation, joined from
 * `runSet.approvalMirrors` (absent under `summary: true` — fetch the full run
 * set when rendering approvals). The respond target is the parent
 * `requires_approval` run matched by `childRunId`.
 */
export function approvalsFromRunSet(
	runSet: Pick<HomeRunSet, "runs" | "approvalMirrors">,
	tediNames: Record<string, string> = {},
	nowMs: number = Date.now(),
): ApprovalCardData[] {
	const mirrored = Object.values(runSet.approvalMirrors ?? {}).map((mirror) => {
		const parentRun = runSet.runs.find(
			(run) => run.childRunId === mirror.childRunId,
		);
		const tediName = mirror.delegatedTediId
			? (tediNames[mirror.delegatedTediId] ?? null)
			: null;
		return {
			approvalId: mirror.approvalRequestId,
			runId: parentRun?.id ?? mirror.childRunId,
			summary: "Delegated work is blocked on your approval",
			tediName,
			status: mirror.status,
			requestedAt: mirror.blockedAt,
		};
	});
	const recommendations = runSet.runs.flatMap((run): ApprovalCardData[] => {
		const metadata = asRecord(run.metadata);
		const delegation = asRecord(metadata?.homeDelegation);
		const decision = asRecord(delegation?.decision);
		if (!delegation || !decision) return [];
		if (decision.mode !== "needs_approval") return [];
		// A child or resolved proposal is no longer a recommendation. Terminal
		// drafts remain visible as history, without reopening their approval gate.
		if (run.childRunId) return [];
		const workOrder = asRecord(delegation.workOrder);
		const delegationStatus = (
			asString(delegation.resolutionStatus) ?? asString(workOrder?.status)
		)?.toLowerCase();
		if (
			delegationStatus &&
			delegationStatus !== "draft" &&
			delegationStatus !== "pending"
		) {
			return [];
		}
		const targetTediId = asString(workOrder?.targetTediId);
		const targetLabel = asString(workOrder?.targetTediLabel);
		const tediName =
			targetLabel ?? (targetTediId ? (tediNames[targetTediId] ?? null) : null);
		const holdReason = asString(decision.reason);
		if (TERMINAL_RUN_STATUSES.has(run.status)) {
			return [
				{
					approvalId: `home-delegation:${run.id}`,
					runId: run.id,
					summary: `Delegation proposal from ${run.status} run`,
					detail: holdReason,
					tediName,
					status: "pending",
					decisionMode: "no_action",
					noActionNote:
						"This run has ended. The proposal is retained as history and cannot be approved or rejected.",
					requestedAt: run.updatedAt ?? run.createdAt,
				},
			];
		}
		const review = delegationAgentReviewState(
			asRecord(delegation.agentReview),
			tediNames,
			nowMs,
		);
		if (review?.state === "approved") return [];
		if (review?.state === "pending") {
			// The org's approval tedi is deciding: no operator buttons (and no
			// session auto-approval) until it declines or the review expires.
			return [
				{
					approvalId: `home-delegation:${run.id}`,
					runId: run.id,
					summary: `Awaiting ${review.approverName} decision`,
					detail: holdReason,
					tediName,
					status: "pending" as const,
					decisionMode: "no_action" as const,
					noActionNote: `${review.approverName} decides through the Work approval plane; you'll be asked only if it declines or the review expires.`,
					requestedAt: run.updatedAt ?? run.createdAt,
				},
			];
		}
		return [
			{
				approvalId: `home-delegation:${run.id}`,
				runId: run.id,
				summary: tediName
					? `Approve delegation to ${tediName}`
					: "Approve delegation",
				detail: review
					? [review.outcome, holdReason].filter(Boolean).join(" · ")
					: holdReason,
				tediName,
				status: "pending" as const,
				requestedAt: run.updatedAt ?? run.createdAt,
				sessionScopeKey: `delegate:${targetTediId ?? targetLabel ?? "?"}`,
			},
		];
	});
	return [...mirrored, ...recommendations];
}

/**
 * Project `homeDelegation.agentReview` (the org's approval tedi deciding a
 * held delegation) into card state. Expiry is derived here, never stored.
 */
function delegationAgentReviewState(
	review: Record<string, unknown> | null,
	tediNames: Record<string, string>,
	nowMs: number,
):
	| { state: "pending"; approverName: string }
	| { state: "approved"; approverName: string }
	| { state: "declined"; approverName: string; outcome: string }
	| null {
	if (!review) return null;
	const approverTediId = asString(review.approverTediId);
	const approverName =
		asString(review.approverTediLabel) ??
		(approverTediId ? tediNames[approverTediId] : undefined) ??
		"The approval tedi";
	const status = asString(review.status);
	if (status === "approved") return { state: "approved", approverName };
	if (status === "pending") {
		const expiresAtMs = Date.parse(asString(review.expiresAt) ?? "");
		if (Number.isFinite(expiresAtMs) && expiresAtMs > nowMs)
			return { state: "pending", approverName };
		return {
			state: "declined",
			approverName,
			outcome: `${approverName} did not decide before the review expired`,
		};
	}
	if (status === "rejected") {
		const rationale = asString(review.rationale) ?? asString(review.reason);
		return {
			state: "declined",
			approverName,
			outcome: rationale
				? `${approverName} declined: ${rationale}`
				: `${approverName} declined`,
		};
	}
	if (status === "unavailable") {
		const reason = asString(review.reason);
		return {
			state: "declined",
			approverName,
			outcome: reason
				? `${approverName} could not review: ${reason}`
				: `${approverName} could not review`,
		};
	}
	return null;
}

/**
 * Pending-approval card. Approve/Reject only dispatch the callback — the card
 * never flips its own state; the integrator resolves the outcome from
 * `approval.resolved` / run-set refresh and unmounts or re-renders the card.
 * `decision` maps 1:1 onto `kernelRuntime.respondApproval`'s `decision` enum.
 *
 * AUTHORITATIVE-ONLY, and never optimistic. Resolving an approval releases a
 * parked write proposal: the downstream tool call then actually runs. A card
 * that flipped to "approved" locally would claim an authorization the kernel
 * has not granted, and `tediApprovals.resolve` refuses a second attempt, so a
 * rollback could not undo it either. While the decision is in flight the card
 * stays exactly as it is, marked busy, and says what it is waiting for.
 */
export function ApprovalCard({
	approval,
	resolving = false,
	onResolve,
	onAlwaysApprove,
}: {
	approval: ApprovalCardData;
	resolving?: boolean;
	onResolve?: (approvalId: string, decision: "approve" | "reject") => void;
	onAlwaysApprove?: (approvalId: string, scopeKey: string) => void;
}) {
	const expired = approval.expired === true;
	const decisionMode = approval.decisionMode ?? "approve_or_reject";
	const actionable = !expired && decisionMode === "approve_or_reject";
	return (
		<li
			data-slot="approval-card"
			data-approval-status={expired ? "expired" : approval.status}
			data-pending={resolving || undefined}
			aria-busy={resolving || undefined}
			className="flex w-full justify-start"
		>
			<div
				className={cn(
					"grid w-full min-w-0 max-w-[860px] grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 rounded-xl border px-3.5 py-2.5",
					expired
						? "border-kumo-hairline bg-kumo-base"
						: "border-kumo-warning bg-kumo-warning-tint",
				)}
			>
				<span className="mt-0.5 shrink-0 text-kumo-warning">
					<ShieldWarning size={18} aria-hidden />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<Text
						as="strong"
						tone="strong"
						weight="medium"
						className="tracking-[-0.2px]"
					>
						{sanitizeUntrustedText(approval.summary)}
					</Text>
					<Text as="span" role="label" tone="secondary">
						{approval.tediName
							? sanitizeUntrustedText(approval.tediName)
							: "Tedix"}
						{approval.status === "escalated" ? " · escalated" : ""}
						{approval.requestedAt ? (
							<>
								{" · asked "}
								<time
									dateTime={approval.requestedAt}
									title={absoluteTime(approval.requestedAt)}
								>
									{relativeTime(approval.requestedAt)}
								</time>
							</>
						) : null}
					</Text>
					{approval.detail ? (
						<Text
							as="span"
							role="label"
							className="break-words [overflow-wrap:anywhere]"
						>
							{sanitizeUntrustedText(approval.detail)}
						</Text>
					) : null}
					{expired ? (
						<Text as="span" role="label" tone="error">
							Expired — denied by default per safety policy.
						</Text>
					) : null}
					{!expired && decisionMode === "no_action" ? (
						<Text as="span" role="label" tone="secondary">
							{approval.noActionNote
								? sanitizeUntrustedText(approval.noActionNote)
								: "This request resolves through its own surface; no approve/deny decision applies here."}
						</Text>
					) : null}
					{resolving ? (
						<span
							className="text-kumo-subtle text-xs"
							role="status"
							data-slot="approval-pending"
						>
							Waiting for the kernel to confirm the decision…
						</span>
					) : null}
				</span>
				{actionable ? (
					<span className="col-span-2 flex min-w-0 flex-wrap items-center justify-start gap-2 pl-[30px]">
						<Button
							size="sm"
							icon={<Check size={14} />}
							loading={resolving}
							disabled={resolving}
							onClick={() => onResolve?.(approval.approvalId, "approve")}
						>
							Approve
						</Button>
						<Button
							size="sm"
							variant="destructive"
							icon={<X size={14} />}
							loading={resolving}
							disabled={resolving}
							onClick={() => onResolve?.(approval.approvalId, "reject")}
						>
							Reject
						</Button>
						{approval.sessionScopeKey ? (
							<Button
								size="sm"
								variant="outline"
								disabled={resolving}
								onClick={() =>
									onAlwaysApprove?.(
										approval.approvalId,
										approval.sessionScopeKey as string,
									)
								}
							>
								Always allow this session
							</Button>
						) : null}
					</span>
				) : null}
			</div>
		</li>
	);
}

// ---------------------------------------------------------------------------
// <RunControls/>
// ---------------------------------------------------------------------------

/** Statuses `cancelRun` can interrupt — the run set's active set. */
export const STOPPABLE_RUN_STATUSES: ReadonlySet<TediRunStatus> =
	new Set<TediRunStatus>(["queued", "running", "requires_approval"]);

/**
 * Interruption controls for one run. Pure and NEVER optimistic: Stop/Retry
 * only dispatch callbacks; the integrator keeps `status` sourced from the run
 * set / stream terminals (`run.canceled`, `run.failed`, `run.started` of the
 * retry) and passes `pending` from the mutation. Retry renders only for
 * `failed` + `delegated` — `kernelRuntime.retryRun` rejects anything else.
 * Renders null when no control applies.
 */
export function RunControls({
	status,
	delegated = false,
	pending = false,
	onStop,
	onRetry,
}: {
	status: TediRunStatus;
	/** True when the run has a `delegatedTediId` (retry eligibility). */
	delegated?: boolean;
	/** True while a cancel/retry mutation is in flight — disables both. */
	pending?: boolean;
	onStop?: () => void;
	onRetry?: () => void;
}) {
	const showStop = STOPPABLE_RUN_STATUSES.has(status);
	const showRetry = status === "failed" && delegated;
	if (!showStop && !showRetry) return null;
	return (
		<div
			data-slot="run-controls"
			data-run-status={status}
			data-pending={pending || undefined}
			// Stop and Retry both DISPATCH: cancel is terminal, retry opens a new
			// execution epoch and spends. Neither may render its effect before the
			// server confirms, so the only in-flight signal is a busy control.
			aria-busy={pending || undefined}
			className="flex items-center gap-2"
		>
			{showStop ? (
				<Button
					size="sm"
					variant="destructive"
					icon={<StopCircle size={14} />}
					disabled={pending}
					onClick={() => onStop?.()}
				>
					Stop
				</Button>
			) : null}
			{showRetry ? (
				<Button
					size="sm"
					variant="outline"
					icon={<ArrowCounterClockwise size={14} />}
					disabled={pending}
					onClick={() => onRetry?.()}
				>
					Retry
				</Button>
			) : null}
		</div>
	);
}
