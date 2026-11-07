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
	/** What was done, as a short past-tense sentence ("Read a web page"). */
	label: string;
	/** The exact tool id, kept for a hover title. */
	detail: string | null;
	status: DelegationStepStatus;
	startedAt: string;
	durationMs: number | null;
	/** Consecutive calls of the same tool folded into this row. */
	attempts: number;
	/** How many of those attempts failed before the last one. */
	retries: number;
	/** Why the last attempt failed, in the runtime's words. */
	failureReason: string | null;
};

/** "last activity" is noise until the run has been quiet for this long. */
export const DELEGATION_IDLE_NOTICE_AFTER_MS = 30_000;

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

type ToolVerb = { past: string; now: string };

/** First word of a tool id → how to say it, done and in progress. */
const TOOL_VERBS: Record<string, ToolVerb> = {
	search: { past: "Searched", now: "Searching" },
	find: { past: "Searched", now: "Searching" },
	query: { past: "Searched", now: "Searching" },
	lookup: { past: "Looked up", now: "Looking up" },
	read: { past: "Read", now: "Reading" },
	get: { past: "Read", now: "Reading" },
	fetch: { past: "Read", now: "Reading" },
	scrape: { past: "Read", now: "Reading" },
	markdown: { past: "Read", now: "Reading" },
	view: { past: "Read", now: "Reading" },
	load: { past: "Loaded", now: "Loading" },
	list: { past: "Listed", now: "Listing" },
	open: { past: "Opened", now: "Opening" },
	create: { past: "Created", now: "Creating" },
	add: { past: "Added", now: "Adding" },
	update: { past: "Updated", now: "Updating" },
	edit: { past: "Edited", now: "Editing" },
	set: { past: "Updated", now: "Updating" },
	rename: { past: "Renamed", now: "Renaming" },
	move: { past: "Moved", now: "Moving" },
	delete: { past: "Deleted", now: "Deleting" },
	remove: { past: "Removed", now: "Removing" },
	archive: { past: "Archived", now: "Archiving" },
	send: { past: "Sent", now: "Sending" },
	reply: { past: "Replied to", now: "Replying to" },
	post: { past: "Posted", now: "Posting" },
	publish: { past: "Published", now: "Publishing" },
	comment: { past: "Commented on", now: "Commenting on" },
	write: { past: "Wrote", now: "Writing" },
	draft: { past: "Drafted", now: "Drafting" },
	save: { past: "Saved", now: "Saving" },
	run: { past: "Ran", now: "Running" },
	exec: { past: "Ran", now: "Running" },
	execute: { past: "Ran", now: "Running" },
	start: { past: "Started", now: "Starting" },
	launch: { past: "Started", now: "Starting" },
	stop: { past: "Stopped", now: "Stopping" },
	close: { past: "Closed", now: "Closing" },
	clone: { past: "Cloned", now: "Cloning" },
	checkout: { past: "Checked out", now: "Checking out" },
	upload: { past: "Uploaded", now: "Uploading" },
	download: { past: "Downloaded", now: "Downloading" },
	check: { past: "Checked", now: "Checking" },
	verify: { past: "Checked", now: "Checking" },
	test: { past: "Tested", now: "Testing" },
	validate: { past: "Checked", now: "Checking" },
	ask: { past: "Asked", now: "Asking" },
	call: { past: "Called", now: "Calling" },
	generate: { past: "Generated", now: "Generating" },
	summarize: { past: "Summarized", now: "Summarizing" },
	analyze: { past: "Analyzed", now: "Analyzing" },
	compare: { past: "Compared", now: "Comparing" },
};

const WEB_TOOLS =
	/\b(browser|firecrawl|web|http|crawl|scrape|markdown|url|page|site)\b/;
const COMPUTER_TOOLS =
	/\b(computer|workstation|sandbox|terminal|shell|bash|exec|command|container)\b/;

const toolWords = (value: string): string[] =>
	value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[._:/\s-]+/)
		.filter(Boolean);

/**
 * "reddit__search_posts" → "Searched Reddit posts" / "Searching Reddit posts";
 * tool families a person recognises (web, computer) get fixed wording. The
 * raw id stays a hover title.
 */
export function describeTool(name: string): ToolVerb {
	const safe = sanitizeUntrustedText(name).trim();
	if (!safe) return { past: "Tool action", now: "Working" };
	const [app, tool] = safe.includes("__")
		? safe.split("__", 2)
		: [null, safe.replace(/^functions\./, "")];
	const words = toolWords(tool ?? "");
	const appName = app ? sentenceCase(toolWords(app).join(" ")) : null;
	const haystack = ` ${[...toolWords(app ?? ""), ...words].join(" ")} `;
	const verb = words.length ? TOOL_VERBS[words[0]!] : undefined;
	const rest = words.slice(verb ? 1 : 0).join(" ");
	if (WEB_TOOLS.test(haystack)) {
		return words.some((word) => TOOL_VERBS[word]?.past === "Searched")
			? { past: "Searched the web", now: "Searching the web" }
			: { past: "Read a web page", now: "Reading a web page" };
	}
	// Tedix code mode runs a short script over several Tedix tools; its raw id
	// ("tedix_mcp__code") reads as "Tedix mcp code".
	if (/ (tedix|mcp) /.test(haystack) && words[words.length - 1] === "code") {
		return { past: "Used Tedix tools", now: "Using Tedix tools" };
	}
	if (COMPUTER_TOOLS.test(haystack)) {
		if (verb && ["Ran", "Called"].includes(verb.past))
			return { past: "Ran a command", now: "Running a command" };
		if (verb && ["Started", "Opened", "Created"].includes(verb.past))
			return { past: "Started a computer", now: "Starting a computer" };
		if (verb?.past === "Stopped")
			return { past: "Stopped the computer", now: "Stopping the computer" };
		return { past: "Used the computer", now: "Using the computer" };
	}
	if (verb) {
		const object = [appName, rest].filter(Boolean).join(" ");
		return {
			past: object ? `${verb.past} ${object}` : verb.past,
			now: object ? `${verb.now} ${object}` : verb.now,
		};
	}
	const plain = appName
		? `${appName}: ${words.join(" ") || "action"}`
		: sentenceCase(words.join(" "));
	return { past: plain, now: plain };
}

/** The finished form of {@link describeTool}, for step rows and tests. */
export function plainToolName(name: string): string {
	return describeTool(name).past;
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
	const reason = (payload: Record<string, unknown>) =>
		text(payload.error) ?? text(payload.message) ?? text(payload.reason);
	const seen = new Set<string>();
	const started = new Set<string>();
	const latency = new Map<string, number>();
	for (const event of sorted) {
		if (seen.has(event.id)) continue;
		seen.add(event.id);
		const payload = event.payload ?? {};
		if (event.kind.startsWith("tool.")) {
			const callId =
				event.toolCallId ??
				text(payload.toolCallId) ??
				// Delegated tool events carry the call only in their id:
				// `<run>:<call>.started` / `.completed` / `.failed`.
				event.id.replace(/\.(started|completed|failed)$/, "");
			let step = tools.get(callId);
			if (!step) {
				step = {
					id: callId,
					label: "Tool action",
					detail: null,
					status: "running",
					startedAt: event.createdAt,
					durationMs: null,
					attempts: 1,
					retries: 0,
					failureReason: null,
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
				started.add(callId);
			} else if (
				event.kind === "tool.completed" ||
				event.kind === "tool.failed"
			) {
				step.status = event.kind === "tool.completed" ? "completed" : "failed";
				step.failureReason = step.status === "failed" ? reason(payload) : null;
				step.endedAt = event.createdAt;
				// The runtime's own measure beats our clock difference.
				if (typeof payload.latencyMs === "number" && payload.latencyMs >= 0)
					latency.set(callId, payload.latencyMs);
			}
			const start = started.has(callId) ? parse(step.startedAt) : null;
			const end = parse(step.endedAt);
			step.durationMs =
				latency.get(callId) ??
				(start != null && end != null && end >= start ? end - start : null);
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
				attempts: 1,
				retries: 0,
				failureReason: null,
			});
			continue;
		}
		const label = NOTABLE_EVENTS[event.kind];
		if (!label) continue;
		const failed = FAILED_KINDS.has(event.kind);
		steps.push({
			id: event.id,
			label,
			detail: null,
			status: failed ? "failed" : "completed",
			startedAt: event.createdAt,
			durationMs: null,
			attempts: 1,
			retries: 0,
			failureReason: failed ? reason(payload) : null,
		});
	}
	// Consecutive calls of one tool read as one row: a retry after a failure
	// says so, repeated successes just count.
	const folded: DelegationStep[] = [];
	for (const { endedAt: _endedAt, ...step } of steps) {
		// A step still running reads in the present ("Reading a web page").
		if (step.detail)
			step.label = describeTool(step.detail)[
				step.status === "running" ? "now" : "past"
			];
		const prev = folded[folded.length - 1];
		if (!prev || !prev.detail || prev.detail !== step.detail) {
			folded.push(step);
			continue;
		}
		prev.attempts += 1;
		if (prev.status === "failed") prev.retries += 1;
		prev.status = step.status;
		prev.label = step.label;
		prev.failureReason = step.failureReason;
		prev.durationMs =
			prev.durationMs == null && step.durationMs == null
				? null
				: (prev.durationMs ?? 0) + (step.durationMs ?? 0);
	}
	return folded;
}

/** Older runtime rows carry these lowercase labels; newer ones say it plainly. */
const RUNTIME_LABELS: Record<string, string> = {
	thinking: "Getting ready",
	"loading context": "Getting ready",
	"reading the task": "Reading the request",
	synthesizing: "Writing the answer",
	responding: "Writing the answer",
	"wrapping up": "Wrapping up",
	delegating: "Asking a helper",
	"writing artifact": "Saving a file",
};

/**
 * The runtime's progress label as a sentence: "calling <tool_id>" names the
 * tool in plain words, legacy lowercase labels are mapped, anything else is
 * sentence-cased without its trailing ellipsis.
 */
export function plainRuntimeLabel(
	label: string | null | undefined,
): string | null {
	const clean = text(label)
		?.replace(/(?:…|\.{3})+$/, "")
		.trim();
	if (!clean) return null;
	const call = clean.match(/^calling ([\w.:/-]+)$/i);
	if (call) return describeTool(call[1]!).now;
	return (
		RUNTIME_LABELS[clean.toLowerCase()] ??
		clean[0]!.toUpperCase() + clean.slice(1)
	);
}

const TECHNICAL_TEXT =
	/[{}[\]<>]|https?:\/\/|\b[A-Z][A-Za-z]+(Error|Exception)\b|\b(status|code)\b[^.]*\b\d{3}\b|\bat [\w$.]+ \(|\bE[A-Z]{4,}\b|\bundefined\b|\b[a-z]+_[a-z_]+\b/;

/**
 * A failed run's reason in plain words. Known reason codes get a sentence;
 * a readable runtime message is kept, a technical one is replaced. The raw
 * text stays available for a hover title.
 */
export function plainFailure(input: {
	reason?: string | null;
	error?: string | null;
	/** The tedi's display name, when the caller knows it. */
	who?: string | null;
}): string {
	const who = text(input.who) ?? "That assistant";
	if (input.reason === "runtime_unavailable")
		return `${who} isn't available right now.`;
	if (input.reason === "dispatch_failed")
		return `The task couldn't be handed to ${who}.`;
	const error = text(input.error);
	if (!error || TECHNICAL_TEXT.test(error))
		return "Something went wrong before it finished.";
	const sentence =
		error.length > 160 ? `${error.slice(0, 159).trimEnd()}…` : error;
	return /[.!?…]$/.test(sentence)
		? sentence[0]!.toUpperCase() + sentence.slice(1)
		: `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
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
	const runningTool = [...steps]
		.reverse()
		.find((step) => step.status === "running");
	const currentStep = terminal
		? null
		: (plainRuntimeLabel(progress?.detail) ??
			(runningTool?.detail ? describeTool(runningTool.detail).now : null) ??
			(runningTool ? runningTool.label : null) ??
			plainRuntimeLabel(progress?.label) ??
			(steps.length ? `Last step: ${steps[steps.length - 1]!.label}` : null));

	return {
		phase,
		currentStep,
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
