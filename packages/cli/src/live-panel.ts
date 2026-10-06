/**
 * LiveActivityPanel — in-flight run DATA SOURCE for the live panel.
 *
 * Polls the kernel run-set on a deliberately slow projection cadence for each
 * active conversation and tracks each run's RunState. The ink REPL reads
 * getStates() on controller publications (via the bridge) and
 * draws the panel rows (ink-live-panel.tsx + renderPanelRow); `/runs` uses
 * snapshot() for a one-shot static print. This class does NOT render — the ink
 * layer owns drawing.
 *
 * TTY-only polling; non-TTY callers get a no-op panel (all methods safe to call).
 */

import { TOOL_VERB_MAP, VERB_PREFIX_MAP } from "./operator/tool-humanize";
import { type ColorMode, stripControlChars } from "./terminal";
import { formatDuration } from "./format";
import { coerceHomeRunSet, type HomeRunSummary } from "./home-client";
import type { InFlightEntry } from "./inflight";
import { accent, faint } from "./theme";

export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LABEL_MAX = 24;

// Server progress phrases that carry no signal — suppressed so a freshly-started
// run reads as a clean spinner rather than "no runtime events". Shared with the
// transcript commit path (index.ts) so the same placeholders never land in the
// committed answer body either.
export const ACTIVITY_NOISE = new Set(["no runtime events", "no events"]);

/** True when a progress/answer line is a no-signal server placeholder. */
export function isActivityNoise(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return (
		ACTIVITY_NOISE.has(normalized) ||
		/^\d+\s+runtime events?\s+recorded$/.test(normalized)
	);
}
// The foreground settlement reader and durable event tail already watch every
// active run. This projection is intentionally slower: it enriches the calm
// panel with aggregate/child detail while leaving gateway budget for two
// simultaneous TUI sessions.
const POLL_INTERVAL_MS = 10_000;

/** Truncate a string to at most `max` codepoints, appending "…" if truncated. */
export function truncateCp(s: string, max: number): string {
	const cp = [...s];
	if (cp.length <= max) return s;
	return `${cp.slice(0, max - 1).join("")}…`;
}

/** Format token count as human-readable, e.g. 1200 → "1.2k". */
function fmtTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** Max codepoints for a humanized activity phrase. */
export const ACTIVITY_MAX = 24;

/**
 * Humanize a raw tool/activity string from progressDetail into a short,
 * operator-readable phrase. Strips provider/namespace prefixes and maps
 * known patterns to clean verbs.
 *
 * Examples:
 *   "calling tedix_mcp_code"                    → "running code"
 *   "calling google_gmail_tedix.search_threads" → "searching gmail"
 *   "calling firecrawl_tedix.scrape_url"        → "fetching page"
 *   "calling acme_tedix.list_invoices"  → "listing invoices"
 *   "streaming"                                 → "streaming"
 *   "searching gmail"                           → "searching gmail"   (already clean)
 *
 * The result is truncated to ACTIVITY_MAX codepoints.
 */
export function humanizeActivity(raw: string): string {
	// Strip leading "calling " prefix (the most common progressDetail form).
	let s = raw.replace(/^calling\s+/i, "").trim();

	// Strip known namespace prefixes — order matters: longest first.
	// Pattern: "<word>_tedix.<rest>" or "tedix_mcp_<rest>"
	s = s
		// tedix_mcp_<tool>  →  <tool>
		.replace(/^tedix_mcp_/, "")
		// <provider>_tedix.<tool>  →  <tool>  (e.g. "google_gmail_tedix.search_threads" → "search_threads")
		.replace(/^\w+_tedix\.\w+\.?/, (m) => {
			// Extract just the tool part after the last dot
			const dot = m.lastIndexOf(".");
			return dot >= 0 ? m.slice(dot + 1) : m;
		})
		// <provider>_tedix  (no dot)  →  drop the suffix entirely, keep provider label
		.replace(/^(\w+)_tedix$/, "$1")
		// Bare namespace like "tedix_<tool>" not matching above
		.replace(/^tedix_/, "");

	// Map known raw tool names to clean human labels (shared TOOL_VERB_MAP from
	// ./operator/tool-humanize — the canonical lowercase phrases).
	const clean = TOOL_VERB_MAP[s];
	if (clean) return truncateCp(clean, ACTIVITY_MAX);

	// Heuristic: convert snake_case to "verb noun" (e.g. "list_skills" →
	// "listing skills") using the shared VERB_PREFIX_MAP.
	const parts = s.split("_").filter(Boolean);
	if (parts.length >= 2) {
		const verbFull = VERB_PREFIX_MAP[parts[0] ?? ""];
		if (verbFull) {
			const noun = parts.slice(1).join(" ");
			return truncateCp(`${verbFull} ${noun}`, ACTIVITY_MAX);
		}
	}

	// Fallback: just humanize underscores and return as-is.
	const humanized = s.replace(/_/g, " ").trim();
	return truncateCp(humanized || raw, ACTIVITY_MAX);
}

/** Per-run state held by the panel (summary + child-tree info). */
export interface RunState {
	entry: InFlightEntry;
	/** Partial summary from poll; only fields present in run-set shape. */
	summary?: Partial<HomeRunSummary>;
	childTotal?: number;
	childDone?: number;
	childFailed?: number;
	children?: ChildPanelRow[];
	/** Recent event-tail rows; dynamic only and never committed to scrollback. */
	activities?: string[];
	/**
	 * Answer-so-far tail from the additive `message.delta` channel. Dynamic only:
	 * the canonical `message.completed` answer is what the transcript commits, so
	 * this is cleared the moment the run settles.
	 */
	answerStream?: string;
	/** Usage tokens (input+output) when available. */
	tokens?: number;
}

export type ActivityDisplayMode = "compact" | "full" | "errors";

export interface ChildPanelRow {
	id: string;
	label: string;
	status: string;
	objective?: string;
}

export function renderChildPanelRow(
	child: ChildPanelRow,
	frameIndex: number,
): string {
	const marker =
		child.status === "completed"
			? "✓"
			: child.status === "failed"
				? "!"
				: child.status === "canceled"
					? "–"
					: child.status === "requires_approval"
						? "◇"
						: FRAMES[frameIndex % FRAMES.length];
	const objective = child.objective
		? `  ${truncateCp(child.objective, 42)}`
		: "";
	return `      ${marker} ${truncateCp(child.label, 18).padEnd(18, " ")}${objective}`;
}

/**
 * Render one panel row as a plain string (no ANSI) given a RunState and
 * the current time. Pure function — usable in tests.
 *
 * Layout (Claude-Code style):
 *   "  ⠋ <label padded 24>  <body>   <right: elapsed · ↓tok>"
 *
 * - Route-kind jargon is hidden; only the target ("→ CEO") is shown.
 * - Activity is humanized (strips namespace prefixes, maps to clean verbs).
 * - Elapsed + token cost are right-aligned within `columns` width.
 *
 * @param columns Terminal width for right-alignment (default 80).
 */
export function renderPanelRow(
	state: RunState,
	frameIndex: number,
	now: number,
	columns = 80,
	/**
	 * Optional theme. When enabled, the spinner frame is sage-accented and the
	 * cost is faint. Layout widths are computed from the UNCOLORED segments
	 * (ANSI is zero-width), so the plain-string output is byte-identical to the
	 * uncolored path that tests assert.
	 */
	color?: ColorMode,
): string {
	const frame = FRAMES[frameIndex % FRAMES.length];
	const label = truncateCp(state.entry.label, LABEL_MAX);
	const elapsedMs = now - state.entry.startedAt;
	const elapsed = formatDuration(elapsedMs);

	// ── Left body: target + activity + children ──────────────────────────────
	const bodyParts: string[] = [];
	const summary = state.summary;

	// Show target tedi when present ("→ CEO"), but NOT the internal routeKind.
	const target = summary?.targetTediLabel;
	if (target) bodyParts.push(`→ ${target}`);

	// Humanized activity (strips provider prefixes, maps to clean verbs).
	const rawActivity =
		summary?.progressDetail ?? summary?.progressLabel ?? summary?.status ?? "";
	const activity = rawActivity ? humanizeActivity(rawActivity) : "";
	if (activity && !isActivityNoise(activity)) {
		bodyParts.push(activity);
	}

	// Child progress: named plan assignments use "2/3 done"; internal branches
	// use "fan-out 2/3" so a completed branch count does not imply that the
	// parent tedi has already finished synthesizing its answer.
	if (
		state.childTotal !== undefined &&
		state.childTotal > 0 &&
		state.childDone !== undefined
	) {
		const failed = state.childFailed ?? 0;
		const isInternalFanout =
			state.children?.some((child) => /^Fan-out\b/i.test(child.label)) ?? false;
		const progress = isInternalFanout
			? `fan-out ${state.childDone}/${state.childTotal}`
			: `${state.childDone}/${state.childTotal} done`;
		const fanout = failed > 0 ? `${progress} · ${failed} failed` : progress;
		bodyParts.push(fanout);
	}

	const body = bodyParts.join(" · ");

	// ── Right cost: elapsed [· ↓tok] ─────────────────────────────────────────
	const costParts: string[] = [elapsed];
	if (state.tokens !== undefined && state.tokens > 0) {
		costParts.push(`↓${fmtTokens(state.tokens)}`);
	}
	const cost = costParts.join(" · ");

	// ── Compose with right-alignment ─────────────────────────────────────────
	// prefix = "  ⠋ " (2 spaces + frame + space = 4 chars), label padded to LABEL_MAX.
	const prefix = `  ${frame} ${label.padEnd(LABEL_MAX, " ")}  `;
	// Minimum one space between body and cost.
	const minRow = `${prefix}${body} ${cost}`;
	const rowLen = [...minRow].length;

	if (rowLen >= columns) {
		// Terminal too narrow: fall back to no padding.
		return color?.enabled
			? `  ${accent(frame ?? "", color)} ${label.padEnd(LABEL_MAX, " ")}  ${body} ${faint(cost, color)}`
			: minRow;
	}

	// Pad the body so cost lands at the right edge.
	const prefixLen = [...prefix].length;
	const costLen = [...cost].length;
	const bodyLen = [...body].length;
	// Total chars available for body + gap = columns - prefixLen - costLen.
	// We want: prefixLen + bodyLen + gapLen + costLen === columns
	//   → gapLen = columns - prefixLen - bodyLen - costLen
	const gapLen = Math.max(1, columns - prefixLen - bodyLen - costLen);
	const padded = body + " ".repeat(gapLen);
	if (color?.enabled) {
		const coloredPrefix = `  ${accent(frame ?? "", color)} ${label.padEnd(LABEL_MAX, " ")}  `;
		return `${coloredPrefix}${padded}${faint(cost, color)}`;
	}
	return `${prefix}${padded}${cost}`;
}

/**
 * Render the full multi-line panel header + rows as an array of lines.
 * Pure function.
 */
export function renderPanel(
	states: RunState[],
	frameIndex: number,
	now: number,
): string[] {
	if (states.length === 0) return [];
	const lines: string[] = [`tedix [${states.length} running]`];
	for (const state of states) {
		lines.push(renderPanelRow(state, frameIndex, now));
	}
	return lines;
}

/**
 * Fetch and parse a child-tree payload to extract done/failed/total counts
 * for a given homeRunId's children. Returns undefined fields when no children.
 */
export function parseChildCounts(
	treePayload: unknown,
	homeRunId: string,
): { total: number; done: number; failed: number } | undefined {
	if (
		typeof treePayload !== "object" ||
		treePayload === null ||
		!("tree" in treePayload)
	)
		return undefined;
	const tree = (treePayload as Record<string, unknown>).tree;
	if (typeof tree !== "object" || tree === null || !("nodes" in tree))
		return undefined;
	const nodes = (tree as Record<string, unknown>).nodes;
	if (!Array.isArray(nodes)) return undefined;

	// Find nodes that belong to this homeRunId.
	const relevant = nodes.filter(
		(n): n is Record<string, unknown> =>
			typeof n === "object" &&
			n !== null &&
			typeof (n as Record<string, unknown>).homeRunId === "string" &&
			(n as Record<string, unknown>).homeRunId === homeRunId,
	);
	if (relevant.length === 0) return undefined;

	// Each matching node has children; count those.
	let total = 0;
	let done = 0;
	let failed = 0;
	for (const node of relevant) {
		const children = Array.isArray(node.children) ? node.children : [];
		for (const child of children) {
			if (typeof child !== "object" || child === null) continue;
			const c = child as Record<string, unknown>;
			total++;
			const status = typeof c.status === "string" ? c.status : "";
			if (
				status === "completed" ||
				status === "failed" ||
				status === "canceled"
			) {
				done++;
			}
			if (status === "failed") failed++;
		}
	}
	return total > 0 ? { total, done, failed } : undefined;
}

/** Compact child rows for the live coordinated-work panel. */
export function parseChildPanelRows(
	treePayload: unknown,
	homeRunId: string,
): ChildPanelRow[] {
	if (
		typeof treePayload !== "object" ||
		treePayload === null ||
		!("tree" in treePayload)
	)
		return [];
	const tree = (treePayload as Record<string, unknown>).tree;
	if (typeof tree !== "object" || tree === null) return [];
	const nodes = (tree as Record<string, unknown>).nodes;
	if (!Array.isArray(nodes)) return [];
	const rows: ChildPanelRow[] = [];
	for (const value of nodes) {
		if (typeof value !== "object" || value === null) continue;
		const node = value as Record<string, unknown>;
		if (node.homeRunId !== homeRunId) continue;
		const children = Array.isArray(node.children) ? node.children : [];
		for (const childValue of children) {
			if (typeof childValue !== "object" || childValue === null) continue;
			const child = childValue as Record<string, unknown>;
			const metadata =
				typeof child.metadata === "object" && child.metadata !== null
					? (child.metadata as Record<string, unknown>)
					: {};
			rows.push({
				id:
					typeof child.id === "string"
						? child.id
						: `${homeRunId}:${rows.length}`,
				label: typeof child.label === "string" ? child.label : "Tedi",
				status: typeof child.status === "string" ? child.status : "queued",
				...(typeof metadata.objective === "string"
					? { objective: metadata.objective }
					: {}),
			});
		}
	}
	return rows;
}

/**
 * Interface for the home client operations the panel needs.
 * Narrowed so tests can inject fakes without the full TedixHomeClient.
 */
export interface PanelHomeOps {
	readHomeRunSet(input: { conversationId: string }): Promise<unknown>;
	readChildRunTree(input: { conversationId: string }): Promise<unknown>;
}

/**
 * Poll loop + state for the in-flight run panel (data source; see file header).
 *
 *   const panel = new LiveActivityPanel({ isTty: true, ops });
 *   panel.add(entry);              // on new run
 *   panel.settle(homeRunId);       // on run settle (drops from the panel)
 *   panel.stop();                  // on exit / /wait
 */
export class LiveActivityPanel {
	readonly #isTty: boolean;
	readonly #ops: PanelHomeOps | undefined;

	#states = new Map<string, RunState>();
	#pollTimer: ReturnType<typeof setInterval> | undefined;
	#polling = false;
	#stopped = false;

	constructor(opts: {
		isTty: boolean;
		ops?: PanelHomeOps;
		/** Override the calm projection cadence for tests. */
		pollIntervalMs?: number;
		/** Override for tests. */
		now?: () => number;
	}) {
		this.#isTty = opts.isTty;
		this.#ops = opts.ops;
		if (opts.now) this.#now = opts.now;

		// TTY-only: poll the run-set on a slow interval; the ink layer renders.
		if (this.#isTty) {
			this.#pollTimer = setInterval(() => {
				void this.#poll();
			}, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
			this.#pollTimer.unref?.();
		}
	}

	#now: () => number = () => Date.now();

	/** Add a newly dispatched run to the panel. */
	add(entry: InFlightEntry): void {
		if (!this.#isTty) return;
		this.#states.set(entry.homeRunId, { entry });
	}

	/** Remove a settled run from the panel. */
	settle(homeRunId: string): void {
		if (!this.#isTty) return;
		this.#states.delete(homeRunId);
	}

	/** Record a concise event-tail row without making Ink and stdout co-own it. */
	recordActivity(homeRunId: string, row: string): void {
		if (!this.#isTty || !row) return;
		const state = this.#states.get(homeRunId);
		if (!state) return;
		// Strip ANSI before Ink renders the row.
		const clean = stripControlChars(row).trim();
		if (!clean) return;
		const previous = state.activities ?? [];
		if (previous[previous.length - 1] === clean) return;
		const next = [...previous, clean];
		while (next.length > 8) {
			const removable = next.findIndex(
				(item) => !/(failed|error|approval|unauthorized)/i.test(item),
			);
			next.splice(removable >= 0 ? removable : 0, 1);
		}
		state.activities = next;
	}

	/**
	 * Replace the run's streamed answer-so-far tail. Additive preview only — an
	 * empty tail (the settled signal) clears it so the canonical answer committed
	 * to the transcript is never shadowed by a stale partial.
	 */
	recordAnswerStream(homeRunId: string, tail: string): void {
		if (!this.#isTty) return;
		const state = this.#states.get(homeRunId);
		if (!state) return;
		const clean = stripControlChars(tail).trim();
		state.answerStream = clean || undefined;
	}

	/** Stop the poll loop (call on exit or /wait). */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = undefined;
		}
	}

	/**
	 * Return a static snapshot of current panel lines (for /runs static print).
	 * Does not repaint — caller handles output.
	 */
	snapshot(now?: number): string[] {
		const states = [...this.#states.values()];
		if (states.length === 0) return [];
		// Fixed spinner frame — this is a one-shot static print, not animated.
		return renderPanel(states, 0, now ?? this.#now());
	}

	/** Return the raw RunState array (for ink rendering). */
	getStates(): RunState[] {
		return [...this.#states.values()];
	}

	/** Return current states for /runs <prefix> lookup. */
	findByPrefix(prefix: string): RunState | undefined {
		for (const state of this.#states.values()) {
			if (state.entry.homeRunId.startsWith(prefix)) return state;
		}
		return undefined;
	}

	async #poll(): Promise<void> {
		if (this.#stopped || this.#states.size === 0 || this.#polling) return;
		this.#polling = true;
		try {
			// Group by conversationId so we make one projection pair per conversation.
			const byConversation = new Map<string, string[]>();
			for (const [runId, state] of this.#states) {
				const convId = state.entry.conversationId;
				const list = byConversation.get(convId) ?? [];
				list.push(runId);
				byConversation.set(convId, list);
			}

			for (const [conversationId, runIds] of byConversation) {
				try {
					const [runSetPayload, childTreePayload] = await Promise.all([
						this.#ops?.readHomeRunSet({ conversationId }),
						this.#ops?.readChildRunTree({ conversationId }),
					]);

					if (this.#stopped) return;

					// Extract summaries from runSet payload.
					const summaryMap = parseRunSetSummaries(runSetPayload);

					for (const runId of runIds) {
						const state = this.#states.get(runId);
						if (!state) continue;

						const summary = summaryMap.get(runId);
						if (summary) {
							state.summary = summary;
							// Extract tokens defensively.
							const usage = (summary as unknown as Record<string, unknown>)
								.usage;
							if (
								typeof usage === "object" &&
								usage !== null &&
								"totalTokens" in usage
							) {
								const total = (usage as Record<string, unknown>).totalTokens;
								if (typeof total === "number") state.tokens = total;
							} else if (
								typeof usage === "object" &&
								usage !== null &&
								"inputTokens" in usage
							) {
								const inp = (usage as Record<string, unknown>).inputTokens;
								const out = (usage as Record<string, unknown>).outputTokens;
								const t =
									(typeof inp === "number" ? inp : 0) +
									(typeof out === "number" ? out : 0);
								if (t > 0) state.tokens = t;
							}
						}

						// Extract child counts from tree.
						if (childTreePayload) {
							applyChildTreeProjection(state, childTreePayload, runId);
						}
					}
				} catch {
					// Fail-soft: leave last-known state, never crash the REPL.
				}
			}
		} finally {
			this.#polling = false;
		}
	}
}

/** Replace the child-tree projection, clearing counts when fan-out disappears. */
export function applyChildTreeProjection(
	state: RunState,
	payload: unknown,
	runId: string,
): void {
	const counts = parseChildCounts(payload, runId);
	if (counts) {
		state.childTotal = counts.total;
		state.childDone = counts.done;
		state.childFailed = counts.failed;
	} else {
		delete state.childTotal;
		delete state.childDone;
		delete state.childFailed;
	}
	state.children = parseChildPanelRows(payload, runId);
}

/**
 * Parse a read_home_run_set payload and extract per-runId HomeRunSummary
 * objects. Returns a map from homeRunId to partial summary.
 */
export function parseRunSetSummaries(
	payload: unknown,
): Map<string, Partial<HomeRunSummary>> {
	const map = new Map<string, Partial<HomeRunSummary>>();
	if (typeof payload !== "object" || payload === null) return map;

	// Prefer the contract-validated run array (HomeRunSetSchema); fall back to the
	// tolerant { runSet?: { runs } } extraction so an unexpected shape still works.
	const root = payload as Record<string, unknown>;
	const runSet =
		typeof root.runSet === "object" && root.runSet !== null
			? (root.runSet as Record<string, unknown>)
			: root;
	const runs: ReadonlyArray<unknown> =
		coerceHomeRunSet(payload)?.runs ??
		(Array.isArray(runSet.runs) ? runSet.runs : []);

	for (const run of runs) {
		if (typeof run !== "object" || run === null) continue;
		const r = run as Record<string, unknown>;
		const id =
			typeof r.id === "string"
				? r.id
				: typeof r.homeRunId === "string"
					? r.homeRunId
					: undefined;
		if (!id) continue;

		const progress =
			typeof r.progress === "object" && r.progress !== null
				? (r.progress as Record<string, unknown>)
				: {};
		const metadata =
			typeof r.metadata === "object" && r.metadata !== null
				? (r.metadata as Record<string, unknown>)
				: {};
		const route =
			typeof metadata.kernelRoute === "object" && metadata.kernelRoute !== null
				? (metadata.kernelRoute as Record<string, unknown>)
				: {};

		const summary: Partial<HomeRunSummary> = {
			homeRunId: id,
			status: typeof r.status === "string" ? r.status : undefined,
			progressLabel:
				typeof progress.label === "string" ? progress.label : undefined,
			progressDetail:
				typeof progress.detail === "string" ? progress.detail : undefined,
			targetTediLabel:
				typeof route.targetTediLabel === "string"
					? route.targetTediLabel
					: undefined,
			targetTediId:
				typeof route.targetTediId === "string" ? route.targetTediId : undefined,
			kernelRoute: Object.keys(route).length > 0 ? route : undefined,
			delegatedTediId:
				typeof r.delegatedTediId === "string" ? r.delegatedTediId : undefined,
			childRunId: typeof r.childRunId === "string" ? r.childRunId : undefined,
			// Thread per-run token usage so the panel's ↓N count lights up (#poll
			// reads totalTokens, then input+output, defensively).
			usage:
				typeof r.usage === "object" && r.usage !== null
					? (r.usage as HomeRunSummary["usage"])
					: undefined,
		};
		map.set(id, summary);
	}
	return map;
}
