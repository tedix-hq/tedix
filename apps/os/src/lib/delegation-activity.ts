import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import { sentenceCase } from "@/lib/format";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

/**
 * Live state of one delegated run, derived from the parent run row (status,
 * progress, timing) and, when loaded, the delegated tedi's own event stream.
 * Pure, so the card, the details drawer and tests read the same answer to
 * "is it still working, and what is it doing?".
 */

/** No recorded activity for this long reads as "may be stuck". */
export const DELEGATION_STALL_AFTER_MS = 3 * 60_000;

/** The minimal event shape both the stream and the evidence read carry. */
export type DelegationEvent = {
	id: string;
	kind: string;
	toolCallId?: string | null;
	payload?: Record<string, unknown> | null;
	createdAt: string;
};

export type DelegationStepStatus = "running" | "completed" | "failed";

export type DelegationStep = {
	id: string;
	label: string;
	/** The exact tool id, kept for a hover title. */
	detail: string | null;
	status: DelegationStepStatus;
	startedAt: string;
	durationMs: number | null;
};

export type DelegationPhase =
	| "queued"
	| "working"
	| "waiting"
	| "stalled"
	| "completed"
	| "failed"
	| "canceled";

export type DelegationLiveState = {
	phase: DelegationPhase;
	/** The current step in plain words, or null when nothing is known yet. */
	currentStep: string | null;
	/** Present only when the runtime reports a real total. */
	progress: { current: number; total: number; percent: number } | null;
	elapsedMs: number | null;
	lastActivityAt: string | null;
	idleMs: number | null;
	steps: DelegationStep[];
	costUsd: number | null;
};

function parse(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const at = Date.parse(iso);
	return Number.isNaN(at) ? null : at;
}

function text(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const clean = sanitizeUntrustedText(value).replace(/\s+/g, " ").trim();
	return clean || null;
}

/** "reddit__search_posts" → "Reddit: search posts"; the raw id stays a title. */
export function plainToolName(name: string): string {
	const safe = sanitizeUntrustedText(name).trim();
	if (!safe) return "Tool action";
	const [app, tool] = safe.includes("__") ? safe.split("__", 2) : [null, safe];
	const words = (value: string) =>
		sentenceCase(value.replace(/[._:/-]+/g, " ").replace(/\s+/g, " "));
	return app && tool
		? `${words(app)}: ${words(tool).toLowerCase()}`
		: words(safe);
}

const NOTABLE_EVENTS: Record<string, string> = {
	"run.started": "Started",
	"step.retry": "Retried a step",
	"subagent.started": "Started a helper",
	"subagent.completed": "Helper finished",
	"subagent.failed": "Helper failed",
	"approval.requested": "Asked for approval",
	"approval.resolved": "Approval answered",
	"context.compacted": "Compacted its notes",
	"skill.used": "Used a skill",
	"workstation.exec.completed": "Ran a command",
	"workstation.exec.failed": "A command failed",
};

const FAILED_KINDS = new Set([
	"subagent.failed",
	"workstation.exec.failed",
	"skill.failed",
]);

/**
 * Folds delegated events into ordered steps: one row per tool call (start and
 * end merged, duration when both are known), plus the few non-tool events a
 * person can act on. Out-of-order and re-delivered events are safe.
 */
export function delegationSteps(
	events: readonly DelegationEvent[],
): DelegationStep[] {
	const sorted = [...events].sort(
		(a, b) => (parse(a.createdAt) ?? 0) - (parse(b.createdAt) ?? 0),
	);
	const tools = new Map<string, DelegationStep & { endedAt: string | null }>();
	const steps: (DelegationStep & { endedAt?: string | null })[] = [];
	const seen = new Set<string>();
	for (const event of sorted) {
		if (seen.has(event.id)) continue;
		seen.add(event.id);
		const payload = event.payload ?? {};
		if (event.kind.startsWith("tool.")) {
			const callId =
				event.toolCallId ?? text(payload.toolCallId) ?? `event:${event.id}`;
			let step = tools.get(callId);
			if (!step) {
				step = {
					id: callId,
					label: "Tool action",
					detail: null,
					status: "running",
					startedAt: event.createdAt,
					durationMs: null,
					endedAt: null,
				};
				tools.set(callId, step);
				steps.push(step);
			}
			const name = text(payload.name) ?? text(payload.toolName);
			if (name) {
				step.label = plainToolName(name);
				step.detail = name;
			}
			if (event.kind === "tool.started") {
				step.startedAt = event.createdAt;
			} else if (
				event.kind === "tool.completed" ||
				event.kind === "tool.failed"
			) {
				step.status = event.kind === "tool.completed" ? "completed" : "failed";
				step.endedAt = event.createdAt;
			}
			const start = parse(step.startedAt);
			const end = parse(step.endedAt);
			step.durationMs =
				start != null && end != null && end >= start ? end - start : null;
			continue;
		}
		if (event.kind === "artifact.created") {
			const name = text(payload.name) ?? text(payload.title);
			steps.push({
				id: event.id,
				label: name ? `Saved ${name}` : "Saved a file",
				detail: null,
				status: "completed",
				startedAt: event.createdAt,
				durationMs: null,
			});
			continue;
		}
		const label = NOTABLE_EVENTS[event.kind];
		if (!label) continue;
		steps.push({
			id: event.id,
			label,
			detail: null,
			status: FAILED_KINDS.has(event.kind) ? "failed" : "completed",
			startedAt: event.createdAt,
			durationMs: null,
		});
	}
	return steps.map(({ endedAt: _endedAt, ...step }) => step);
}

function latest(...values: (string | null | undefined)[]): string | null {
	let best: string | null = null;
	let bestAt = -Infinity;
	for (const value of values) {
		const at = parse(value);
		if (at != null && at > bestAt) {
			best = value!;
			bestAt = at;
		}
	}
	return best;
}

export function delegationLiveState(input: {
	run: Pick<
		HomeRun,
		| "status"
		| "progress"
		| "createdAt"
		| "startedAt"
		| "completedAt"
		| "updatedAt"
		| "usage"
	>;
	events?: readonly DelegationEvent[];
	/** Latest child event time the server summarised, if known. */
	latestEventAt?: string | null;
	now: number;
	stallAfterMs?: number;
}): DelegationLiveState {
	const { run, now } = input;
	const steps = delegationSteps(input.events ?? []);
	const startedAt = run.startedAt ?? run.createdAt;
	const lastActivityAt = latest(
		startedAt,
		run.updatedAt,
		input.latestEventAt,
		...(input.events ?? []).map((event) => event.createdAt),
	);
	const terminal =
		run.status === "completed" ||
		run.status === "failed" ||
		run.status === "canceled";
	const start = parse(startedAt);
	const end = terminal ? parse(run.completedAt ?? run.updatedAt) : now;
	const elapsedMs =
		start != null && end != null && end >= start ? end - start : null;
	const last = parse(lastActivityAt);
	const idleMs = !terminal && last != null ? Math.max(0, now - last) : null;
	const stalled =
		(run.status === "running" || run.status === "queued") &&
		idleMs != null &&
		idleMs >= (input.stallAfterMs ?? DELEGATION_STALL_AFTER_MS);
	const phase: DelegationPhase = terminal
		? (run.status as "completed" | "failed" | "canceled")
		: run.status === "requires_approval"
			? "waiting"
			: stalled
				? "stalled"
				: run.status === "queued"
					? "queued"
					: "working";

	const progress = run.progress;
	const reportedTotal =
		progress && progress.total > 0 && progress.current > 0
			? {
					current: Math.min(progress.current, progress.total),
					total: progress.total,
					percent: Math.round(
						(Math.min(progress.current, progress.total) / progress.total) * 100,
					),
				}
			: null;
	const runningTool = [...steps]
		.reverse()
		.find((step) => step.status === "running");
	const currentStep = terminal
		? null
		: (text(progress?.detail) ??
			(runningTool ? `Using ${runningTool.label}` : null) ??
			text(progress?.label) ??
			(steps.length ? steps[steps.length - 1]!.label : null));

	return {
		phase,
		currentStep,
		progress: terminal ? null : reportedTotal,
		elapsedMs,
		lastActivityAt,
		idleMs,
		steps,
		costUsd: run.usage?.costUsd ?? null,
	};
}

/** "12s", "4 min", "2 h" — compact age for "last activity" copy. */
export function shortAge(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
	return `${Math.floor(ms / 3_600_000)} h`;
}
