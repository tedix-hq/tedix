import { CloudCheck, Lightning, PlugsConnected } from "@phosphor-icons/react";
import type {
	SkillRun,
	SkillWorkflowStep,
	SkillWorkflowToolCall,
} from "@tedix/api-contract/contracts/cognitive";
import { dynamicSkillDefinitionId } from "@tedix/api-contract/constants/workflow-definition-keys";
import type { WorkflowDefinitionHealth } from "@tedix/api-contract/contracts/workflows";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import {
	useOsFormattingPreferences,
	humanize,
	sentenceCase,
} from "@/lib/format";
import { absoluteTime, formatDurationMs, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The MCP call target as the receipt records it. Namespace + method is the
 * governed identity of a tool call; the step name is only the workflow step it
 * ran inside, so it is a fallback, never a substitute.
 */
export function toolCallTarget(call: SkillWorkflowToolCall): string {
	if (call.namespace && call.method) return `${call.namespace}.${call.method}`;
	return call.method ?? call.namespace ?? call.name;
}

/**
 * Every `waitForEvent` gate this run opened, newest evidence last, split by
 * whether the gate is still holding the run. `waiting` is the actionable set —
 * the governed approve/reject verbs only apply there — and `resolved` is the
 * durable record of event responses the run already received.
 */
export function partitionEventGates(steps: readonly SkillWorkflowStep[]): {
	waiting: SkillWorkflowStep[];
	resolved: SkillWorkflowStep[];
} {
	const waiting: SkillWorkflowStep[] = [];
	const resolved: SkillWorkflowStep[] = [];
	for (const step of steps) {
		if (step.kind !== "wait_for_event") continue;
		if (step.status === "waiting") waiting.push(step);
		else resolved.push(step);
	}
	return { waiting, resolved };
}

const EVENT_ENVELOPE_KEYS = new Set(["approvalId", "eventType", "type"]);

/**
 * One-line projection of the durable event evidence: the response payload the
 * gate resolved with, or the envelope fields when no payload was recorded.
 * Truncated hard — this renders inside a row, and evidence is not a viewer.
 */
export function summarizeEventEvidence(
	step: SkillWorkflowStep,
	maxLength = 160,
): string | null {
	const data = step.data;
	if (data == null) return null;
	if (typeof data === "string") return truncate(data, maxLength);
	if (typeof data !== "object") return truncate(String(data), maxLength);
	const record = data as Record<string, unknown>;
	const payload = record.payload ?? record.response ?? null;
	const subject =
		payload ??
		Object.fromEntries(
			Object.entries(record).filter(([key]) => !EVENT_ENVELOPE_KEYS.has(key)),
		);
	if (subject == null) return null;
	if (typeof subject === "object" && Object.keys(subject).length === 0) {
		return null;
	}
	try {
		return truncate(JSON.stringify(subject), maxLength);
	} catch {
		return null;
	}
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Definition health for the skill that owns a run. The join key comes from the
 * contract helper rather than a hand-built string, so this cannot silently stop
 * matching if the projection prefix changes. A run whose skill has no
 * definition row simply has no drift evidence to show.
 */
export function findSkillDefinitionHealth(
	health: readonly WorkflowDefinitionHealth[],
	skillId: string,
): WorkflowDefinitionHealth | undefined {
	const definitionId = dynamicSkillDefinitionId(skillId);
	return health.find((entry) => entry.definitionId === definitionId);
}

const DEFINITION_HEALTH_LABELS: Record<
	WorkflowDefinitionHealth["healthStatus"],
	string
> = {
	healthy: "Healthy",
	active: "Running now",
	attention: "Needs a look",
	unknown: "Not run yet",
	degraded: "Not working",
	dormant: "Not expected to run",
};

const DEFINITION_DRIFT_LABELS: Record<
	WorkflowDefinitionHealth["driftStatus"],
	string
> = {
	in_sync: "Latest run used the current version",
	unobserved: "No run yet",
	unexecuted_revision: "The current version has not run yet",
	unknown_revision: "Version not recorded for the latest run",
	revision_mismatch: "Latest run used a newer version than the saved one",
	missing_execution_surface: "The runner is unavailable",
	not_applicable: "Does not apply",
};

const DEFINITION_NOTE_LABELS: Record<string, string> = {
	lifecycle_not_expected_to_run:
		"This skill is paused or archived, so it is not expected to run.",
	execution_surface_unavailable: "The runner for this skill is unavailable.",
	lifecycle_requires_operator_review:
		"This skill is a draft or out of date and needs your review.",
	no_durable_run_evidence: "No finished run has been recorded yet.",
	observed_revision_ahead_of_definition:
		"The latest run used a newer version than the saved skill.",
	current_revision_not_yet_observed:
		"The current version of this skill has not run yet.",
	legacy_run_missing_revision_evidence:
		"An older run did not record which version it used.",
	run_snapshot_is_non_terminal: "A run is still in progress.",
	latest_current_evidence_completed:
		"The latest run of the current version finished successfully.",
	latest_terminal_outcome_needs_inspection:
		"The latest run did not finish successfully; check its steps.",
};

/** Plain-English label for a definition-health status. */
export function definitionHealthLabel(
	status: WorkflowDefinitionHealth["healthStatus"],
): string {
	return DEFINITION_HEALTH_LABELS[status] ?? humanize(status);
}

/** Plain-English label for a definition version check. */
export function definitionDriftLabel(
	status: WorkflowDefinitionHealth["driftStatus"],
): string {
	return DEFINITION_DRIFT_LABELS[status] ?? humanize(status);
}

/** Notes are server codes; unknown ones still read as words, not snake_case. */
export function definitionNoteLabel(note: string): string {
	return DEFINITION_NOTE_LABELS[note] ?? note.replaceAll("_", " ");
}

export type ReconciliationTone = "done" | "active" | "warn" | "blocked";

const RECONCILIATION_VARIANTS: Record<ReconciliationTone, BadgeVariant> = {
	done: "success",
	active: "info",
	warn: "warning",
	blocked: "destructive",
};

/**
 * How much the stored row can still be trusted against Cloudflare Workflows.
 * A retired instance is a permanent fence (never restartable), an unreconciled
 * terminal row is unverified, and a stale in-flight row is drifting.
 */
export function reconciliationTone(
	run: Pick<SkillRun, "status" | "workflowRetiredAt" | "lastReconciledAt">,
): ReconciliationTone {
	if (run.workflowRetiredAt) return "blocked";
	if (!run.lastReconciledAt) return "warn";
	return run.status === "queued" ||
		run.status === "running" ||
		run.status === "paused"
		? "active"
		: "done";
}

export function reconciliationLabel(
	run: Pick<SkillRun, "status" | "workflowRetiredAt" | "lastReconciledAt">,
): string {
	if (run.workflowRetiredAt) return "Instance retired";
	if (!run.lastReconciledAt) return "Never reconciled";
	return "Reconciled";
}

/**
 * The engine snapshot is an opaque Cloudflare Workflows lifecycle record whose
 * shape moves with the engine version. Only the lifecycle status is stable
 * enough to render; everything else stays in the step evidence.
 */
export function engineStatusLabel(
	engine: Record<string, unknown> | null | undefined,
): string | null {
	if (!engine) return null;
	const status = engine.status;
	return typeof status === "string" && status.length > 0
		? humanize(status)
		: null;
}

// ---------------------------------------------------------------------------
// Presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function RunToolCallRow({ call }: { call: SkillWorkflowToolCall }) {
	const detail: string[] = [`step ${call.name}`];
	if (call.attempt != null && call.attempt > 1) {
		detail.push(`attempt ${call.attempt}`);
	}
	if (call.phase) detail.push(call.phase);
	const duration = formatDurationMs(call.durationMs);
	if (duration) detail.push(duration);
	detail.push(call.status ?? call.outcome);

	const receipt: string[] = [];
	if (call.callId) receipt.push(`call ${call.callId}`);
	if (call.idempotencyKey) {
		receipt.push(`idempotency ${call.idempotencyKey}`);
	} else if (call.idempotencyRequested) {
		receipt.push("idempotency requested, no key returned");
	}
	if (call.providerConfirmation) {
		receipt.push(`provider ${call.providerConfirmation}`);
	}

	return (
		<li className="flex min-w-0 items-start gap-3 px-3 py-2">
			<IconFrame appearance="fill">
				<PlugsConnected size={18} />
			</IconFrame>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Text
					as="strong"
					data-outcome={call.outcome}
					role="body"
					weight="medium"
					tone={call.outcome === "failure" ? "error" : "strong"}
					className="truncate"
				>
					{toolCallTarget(call)}
				</Text>
				<Text as="span" role="label" tone="secondary" className="tabular-nums">
					{detail.join(" · ")}
				</Text>
				{receipt.length > 0 && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="truncate tabular-nums"
					>
						{receipt.join(" · ")}
					</Text>
				)}
			</span>
		</li>
	);
}

export function RunEventGateRow({ step }: { step: SkillWorkflowStep }) {
	useOsFormattingPreferences();
	const waiting = step.status === "waiting";
	const eventType =
		step.data && typeof step.data === "object"
			? (((step.data as Record<string, unknown>).eventType as
					| string
					| undefined) ?? null)
			: null;
	const evidence = summarizeEventEvidence(step);
	const detail: string[] = [];
	const waited = formatDurationMs(step.durationMs);
	if (waited) detail.push(waiting ? `waiting ${waited}` : `waited ${waited}`);
	if (step.createdAt) detail.push(relativeTime(step.createdAt));
	detail.push(`epoch ${step.executionEpoch}`);

	return (
		<li className="flex min-w-0 items-start gap-3 px-3 py-2">
			<IconFrame appearance="fill">
				<Lightning size={18} />
			</IconFrame>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex flex-wrap items-center gap-1.5">
					<Badge
						variant={waiting ? "warning" : "success"}
						data-status={step.status ?? step.outcome}
					>
						{waiting ? "Waiting" : sentenceCase(step.status ?? step.outcome)}
					</Badge>
					<Text
						as="strong"
						role="body"
						tone="strong"
						weight="medium"
						className="truncate"
					>
						{eventType ?? step.name}
					</Text>
				</span>
				<Text as="span" role="label" tone="secondary" className="tabular-nums">
					{eventType ? `${step.name} · ` : ""}
					{detail.join(" · ")}
				</Text>
				{evidence && (
					<Text
						as="code"
						role="label"
						tone="mono-secondary"
						className="truncate"
					>
						{evidence}
					</Text>
				)}
			</span>
		</li>
	);
}

/**
 * Cloudflare reconciliation evidence for one run: which workflow binding
 * namespace it was dispatched into, when the reconciler last compared the
 * stored row against the engine, the operator-restart epoch state, and the
 * owning definition's drift/execution-surface health.
 */
export function RunReconciliationPanel({
	run,
	definitionHealth,
	definitionEvidenceTruncated = false,
}: {
	run: Pick<
		SkillRun,
		| "status"
		| "runtimeEnvironment"
		| "lastReconciledAt"
		| "executionEpoch"
		| "restartRequestedAt"
		| "workflowRetiredAt"
		| "workflowInstanceId"
		| "engine"
	>;
	definitionHealth?: WorkflowDefinitionHealth;
	/**
	 * The health page did not cover every definition, so a missing match means
	 * "not on this page", not "no drift evidence". Without this the tail of a
	 * large org silently loses reconciliation evidence.
	 */
	definitionEvidenceTruncated?: boolean;
}) {
	useOsFormattingPreferences();
	const tone = reconciliationTone(run);
	const engineStatus = engineStatusLabel(run.engine);
	const surface = definitionHealth?.executionSurface;
	return (
		<Surface className="grid gap-2 px-4 py-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="flex size-6 items-center justify-center text-kumo-subtle">
					<CloudCheck size={16} />
				</span>
				<Badge variant={RECONCILIATION_VARIANTS[tone]} data-tone={tone}>
					{reconciliationLabel(run)}
				</Badge>
				<Text as="span" role="label" tone="secondary" className="tabular-nums">
					{run.runtimeEnvironment
						? `${run.runtimeEnvironment} binding`
						: "binding namespace unrecorded (legacy row)"}
					{" · instance "}
					{run.workflowInstanceId}
				</Text>
			</div>
			{run.workflowRetiredAt && (
				<Text as="p" role="label" tone="error" className="m-0">
					This automation run was permanently retired{" "}
					<time dateTime={run.workflowRetiredAt}>
						{relativeTime(run.workflowRetiredAt)}
					</time>{" "}
					— it can never be re-entered or restarted. A retry starts a new
					instance in a new execution epoch.
				</Text>
			)}
			<ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-kumo-subtle text-xs tabular-nums [&_strong]:font-medium [&_strong]:text-kumo-default">
				<li>
					Execution epoch <strong>{run.executionEpoch}</strong>
				</li>
				<li>
					Last reconciled{" "}
					<strong>
						{run.lastReconciledAt ? (
							<time
								dateTime={run.lastReconciledAt}
								title={absoluteTime(run.lastReconciledAt)}
							>
								{relativeTime(run.lastReconciledAt)}
							</time>
						) : (
							"never"
						)}
					</strong>
				</li>
				{run.restartRequestedAt && (
					<li>
						Restart requested{" "}
						<strong>
							<time dateTime={run.restartRequestedAt}>
								{relativeTime(run.restartRequestedAt)}
							</time>
						</strong>
					</li>
				)}
				{engineStatus && (
					<li>
						Engine snapshot <strong>{engineStatus}</strong>
					</li>
				)}
			</ul>
			{!definitionHealth && definitionEvidenceTruncated && (
				<Text as="p" role="label" tone="secondary" className="m-0">
					The version check for this skill was not loaded: this workspace has
					more skills than one page shows. A missing check does not mean the
					skill is healthy.
				</Text>
			)}
			{definitionHealth && (
				<ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-kumo-subtle text-xs tabular-nums [&_strong]:font-medium [&_strong]:text-kumo-default">
					<li>
						Skill health{" "}
						<strong>
							{definitionHealthLabel(definitionHealth.healthStatus)}
						</strong>
					</li>
					<li>
						Version{" "}
						<strong>
							{definitionDriftLabel(definitionHealth.driftStatus)}
						</strong>
					</li>
					{surface && (
						<li>
							Runner{" "}
							<strong>
								{surface.binding}
								{surface.available ? "" : " · unavailable"}
							</strong>
						</li>
					)}
				</ul>
			)}
			{definitionHealth?.notes.length ? (
				<ul className="m-0 list-disc pl-4 text-kumo-subtle text-xs">
					{definitionHealth.notes.map((note) => (
						<li key={note}>{definitionNoteLabel(note)}</li>
					))}
				</ul>
			) : null}
		</Surface>
	);
}
