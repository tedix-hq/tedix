import {
	cyan,
	dim,
	formatDuration,
	green,
	red,
	routeKind,
	statusColor,
	yellow,
} from "./format";
import type { HomeRunEvent, HomeRunSummary } from "./home-client";
import { stringValue } from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { PromoteRegion } from "./promote-stream";
import { type ColorMode, stripControlChars } from "./terminal";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\u001b[K";
/** Move the cursor up one row and clear it — erases a multi-line live region. */
const CLEAR_PREVIOUS_LINE = "\u001b[1A\r\u001b[K";
const ESCAPE = "\u001b";
const RESET = "\u001b[0m";
const SGR_DIGITS = "0123456789;";

export interface StatusSpinnerOptions {
	/** Animate a braille frame in place (interactive TTY). */
	animate: boolean;
	/** Suppress all output (e.g. --json machine mode). */
	quiet: boolean;
	stream?: NodeJS.WriteStream;
	/** Color mode for the dim elapsed-time suffix; defaults to animate state. */
	color?: ColorMode;
	/** Clock source (injectable for tests); defaults to Date.now. */
	now?: () => number;
	/** Observe activity rows even when stdout rendering is suppressed by Ink. */
	onLog?: (row: string) => void;
	/**
	 * Observe streamed answer text even when stdout rendering is suppressed by
	 * Ink. Called with the current answer-so-far tail, or "" when the canonical
	 * message settled and the live fragment must be dropped.
	 */
	onStream?: (tail: string) => void;
	/**
	 * Scrollback sink for PROMOTED answer lines. Supplying this together with
	 * `renderAnswer` turns the answer channel from clear-and-reprint into
	 * promote-in-place: a stable block is committed here, immutably, and only the
	 * unstable tail stays in the live region. Omit it (non-TTY stdout, --json,
	 * the Ink lane) and the spinner behaves exactly as it did before.
	 */
	commit?: (line: string) => void;
	/** Render a complete block of answer markdown into final display lines. */
	renderAnswer?: (text: string, width: number) => string[];
	/** Override the resize debounce window (tests). */
	resizeDebounceMs?: number;
}

/**
 * Identity and phase of a tool-activity row. A terminal cannot expand or
 * collapse a section, so the equivalent of a collapsed row is ONE line that is
 * replaced in place while the tool is in flight and committed when it ends.
 */
export interface ActivityRowPhase {
	key: string;
	phase: "start" | "end";
}

/**
 * Classify an event into the in-flight row it belongs to, or null when the row
 * is a one-shot that commits immediately.
 */
export function activityRowPhase(event: HomeRunEvent): ActivityRowPhase | null {
	const kind = event.kind ?? "";
	if (!/tool/i.test(kind)) return null;
	const payload = isRecord(event.payload) ? event.payload : {};
	const key =
		stringValue(payload.callId) ??
		stringValue(payload.toolCallId) ??
		stringValue(payload.id) ??
		stringValue(payload.name) ??
		stringValue(payload.toolName) ??
		kind;
	return { key, phase: /complet|fail|error/i.test(kind) ? "end" : "start" };
}

/** Measure a possibly-colored label in visible terminal columns. */
function visibleWidth(value: string): number {
	return [...stripControlChars(value)].length;
}

/**
 * Clip a possibly-colored string to `max` visible columns, keeping SGR escapes
 * intact so a truncated live row never leaks a half-written escape sequence.
 */
export function clipVisible(text: string, max: number): string {
	if (max <= 0) return "";
	let out = "";
	let visible = 0;
	let index = 0;
	let sawEscape = false;
	while (index < text.length) {
		// Pass SGR color sequences through without spending a visible column, so a
		// clipped row never ends mid-escape.
		if (text[index] === ESCAPE && text[index + 1] === "[") {
			let end = index + 2;
			while (end < text.length && SGR_DIGITS.includes(text[end] as string)) {
				end++;
			}
			if (text[end] === "m") {
				sawEscape = true;
				out += text.slice(index, end + 1);
				index = end + 1;
				continue;
			}
		}
		const point = text.codePointAt(index);
		if (point === undefined) break;
		const glyph = String.fromCodePoint(point);
		if (visible + 1 > max) return `${out}…${sawEscape ? RESET : ""}`;
		out += glyph;
		visible += 1;
		index += glyph.length;
	}
	return out;
}

/**
 * Swap the first activity bullet for the animated frame, so an in-flight row
 * reads as live work without inventing a second row vocabulary.
 */
export function withSpinnerFrame(row: string, frame: string): string {
	const index = row.indexOf("·");
	if (index === -1) return row;
	return `${row.slice(0, index)}${frame}${row.slice(index + 1)}`;
}

/**
 * Collapse a streamed answer fragment to a single dim line: control characters
 * and newlines removed, and only the LAST `max` codepoints kept (prefixed with
 * "…") so the live line advances with the generation instead of scrolling.
 */
export function streamTailText(text: string, max: number): string {
	const clean = stripControlChars(text).replace(/\s+/g, " ").trim();
	if (max <= 1) return "";
	const codepoints = [...clean];
	if (codepoints.length <= max) return clean;
	return `…${codepoints.slice(codepoints.length - (max - 1)).join("")}`;
}

/**
 * A status spinner that owns a small live region at the bottom of the terminal
 * and PROMOTES stable output out of it into real scrollback.
 *
 * The live region is at most: the unstable answer tail, one line per in-flight
 * tool, and the spinner head. Everything above it is already committed and is
 * never rewritten. On a non-TTY it degrades to printing the label only when it
 * changes; in quiet mode it is a no-op. Both of those lanes stay byte-identical
 * to the pre-promotion CLI.
 */
export class StatusSpinner {
	readonly #stream: NodeJS.WriteStream;
	readonly #animate: boolean;
	readonly #quiet: boolean;
	readonly #color: ColorMode;
	readonly #now: () => number;
	readonly #onLog: ((row: string) => void) | undefined;
	readonly #onStream: ((tail: string) => void) | undefined;
	readonly #commitSink: ((line: string) => void) | undefined;
	readonly #promote: PromoteRegion | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#frame = 0;
	#label = "";
	#lastPlainLabel: string | undefined;
	#active = false;
	#startedAt = 0;
	#streamTail = "";
	#promoteTail = "";
	#inflight = new Map<string, string>();
	#liveLines = 0;

	constructor(opts: StatusSpinnerOptions) {
		this.#stream = opts.stream ?? process.stderr;
		this.#animate = opts.animate && !opts.quiet;
		this.#quiet = opts.quiet;
		this.#color = opts.color ?? { enabled: this.#animate };
		this.#now = opts.now ?? (() => Date.now());
		this.#onLog = opts.onLog;
		this.#onStream = opts.onStream;
		this.#commitSink = opts.commit;
		const renderAnswer = opts.renderAnswer;
		this.#promote =
			this.#animate && opts.commit && renderAnswer
				? new PromoteRegion({
						commit: (line) => this.#commitLine(line),
						render: renderAnswer,
						...(opts.resizeDebounceMs !== undefined
							? { resizeDebounceMs: opts.resizeDebounceMs }
							: {}),
					})
				: undefined;
	}

	start(label: string): void {
		if (this.#quiet) return;
		this.#label = label;
		this.#active = true;
		if (this.#startedAt === 0) this.#startedAt = this.#now();
		if (this.#animate) {
			this.#render();
			this.#timer = setInterval(() => {
				this.#frame = (this.#frame + 1) % FRAMES.length;
				this.#render();
			}, 90);
			this.#timer.unref?.();
		} else {
			this.#emitPlainLabel();
		}
	}

	update(label: string): void {
		if (this.#quiet) return;
		this.#label = label;
		if (this.#animate) this.#render();
		else this.#emitPlainLabel();
	}

	/**
	 * Additive streamed-answer channel.
	 *
	 * With a promotion sink the answer-so-far is a PROJECTION of the canonical
	 * message: every complete block is committed to scrollback as it stabilizes
	 * and only the unstable tail is drawn live. Without one (Ink, --json, a
	 * non-TTY stdout) this stays the pre-promotion single transient line, and an
	 * empty text drops that fragment. No-op in quiet (`--json`) mode and on a
	 * non-animating stream, which keeps machine and non-interactive output
	 * byte-identical.
	 */
	stream(text: string): void {
		const tail = streamTailText(text, 160);
		if (this.#onStream) {
			try {
				this.#onStream(tail);
			} catch {
				// Presentation observers are decorative; never break settlement.
			}
		}
		if (this.#quiet || !this.#animate) return;
		if (this.#promote) {
			if (!text) {
				// The settled signal drops the live fragment. Committed lines stay:
				// they are scrollback the user already read.
				if (!this.#promoteTail) return;
				this.#promoteTail = "";
				if (this.#active) this.#render();
				return;
			}
			this.#promoteTail = this.#promote.update(
				text,
				this.#columns(),
				this.#now(),
			);
			if (this.#active) this.#render();
			return;
		}
		if (tail === this.#streamTail) return;
		this.#streamTail = tail;
		if (this.#active) this.#render();
	}

	/**
	 * Commit whatever the live region still holds, reconciled against the
	 * canonical answer, and report the source prefix now in scrollback so the
	 * summary renderer does not print it a second time. Returns "" when nothing
	 * was promoted, which leaves the canonical answer to print in full.
	 */
	settleStream(canonical: string): string {
		if (this.#onStream) {
			try {
				this.#onStream("");
			} catch {
				// Presentation observers are decorative; never break settlement.
			}
		}
		this.#streamTail = "";
		if (!this.#promote) {
			if (this.#animate && this.#active) this.#render();
			return "";
		}
		const committed = this.#promote.settle(
			canonical,
			this.#columns(),
			this.#now(),
		);
		this.#promoteTail = "";
		if (this.#active) this.#render();
		return committed;
	}

	/**
	 * Record an activity row. A row with a `start` phase becomes the single
	 * in-flight live line for its key and is replaced in place until the matching
	 * `end` phase commits it; every other row commits immediately.
	 */
	log(row: string, phase?: ActivityRowPhase): void {
		if (row && this.#onLog) {
			try {
				this.#onLog(row);
			} catch {
				// Presentation observers are decorative; never break settlement.
			}
		}
		if (this.#quiet || !row) return;
		if (this.#animate && this.#active) {
			if (phase?.phase === "start") {
				this.#inflight.set(phase.key, row);
				this.#render();
				return;
			}
			if (phase) this.#inflight.delete(phase.key);
			this.#clearLive();
			this.#stream.write(`${row}\n`);
			this.#render();
		} else {
			this.#stream.write(`${row}\n`);
		}
	}

	/**
	 * Drop an in-flight live line WITHOUT committing it. For provisional lines
	 * (the planner's thinking) that the settled answer supersedes — unlike
	 * `stop()`, which commits pending rows because they describe real work.
	 */
	dismiss(key: string): void {
		if (!this.#inflight.delete(key)) return;
		if (this.#animate && this.#active) this.#render();
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (this.#animate && this.#active) {
			// An in-flight row describes work that really happened; commit it rather
			// than letting the live region take it away on teardown.
			const pending = [...this.#inflight.values()];
			this.#inflight.clear();
			this.#clearLive();
			for (const row of pending) this.#stream.write(`${row}\n`);
		}
		this.#active = false;
	}

	#columns(): number {
		return this.#stream.columns ?? 80;
	}

	/** Commit one immutable line into real scrollback, below the live region. */
	#commitLine(line: string): void {
		this.#clearLive();
		this.#commitSink?.(line);
	}

	/** Erase the live region. Never touches a line that was already committed. */
	#clearLive(): void {
		if (!this.#animate) return;
		const count = this.#liveLines;
		if (count === 0) {
			if (this.#active) this.#stream.write(CLEAR_LINE);
			return;
		}
		let out = CLEAR_LINE;
		for (let index = 1; index < count; index++) out += CLEAR_PREVIOUS_LINE;
		this.#stream.write(out);
		this.#liveLines = 0;
	}

	#render(): void {
		const elapsed = this.#startedAt
			? ` (${formatDuration(this.#now() - this.#startedAt)})`
			: "";
		const head = `${FRAMES[this.#frame]} ${this.#label}${dim(elapsed, this.#color)}`;
		const columns = this.#columns();
		const lines: string[] = [];
		if (this.#promoteTail.trim()) {
			lines.push(
				dim(
					clipVisible(
						streamTailText(this.#promoteTail, columns - 1),
						columns - 1,
					),
					this.#color,
				),
			);
		}
		for (const row of this.#inflight.values()) {
			lines.push(
				clipVisible(
					withSpinnerFrame(row, FRAMES[this.#frame] ?? ""),
					columns - 1,
				),
			);
		}
		// Without promotion the streamed fragment shares the head line; give it
		// only the columns actually left over, so the line never wraps (a wrapped
		// line desyncs the erase and leaks half-frames into scrollback).
		const budget = columns - 1 - visibleWidth(head) - 3;
		const tail =
			!this.#promote && this.#streamTail && budget >= 12
				? `  ${dim(streamTailText(this.#streamTail, budget), this.#color)}`
				: "";
		lines.push(`${head}${tail}`);
		this.#clearLive();
		this.#stream.write(lines.join("\n"));
		this.#liveLines = lines.length;
	}

	#emitPlainLabel(): void {
		if (this.#label && this.#label !== this.#lastPlainLabel) {
			this.#lastPlainLabel = this.#label;
			this.#stream.write(`... ${this.#label}\n`);
		}
	}
}

/** Live spinner label derived from the latest run summary. */
export function spinnerLabel(
	summary: HomeRunSummary,
	color: ColorMode,
): string {
	const status = summary.status ?? "working";
	const route = routeKind(summary);
	const head = summary.progressLabel || statusColor(status, color);
	const parts = [head];
	if (route && !summary.progressLabel) parts.push(dim(route, color));
	if (summary.targetTediLabel) {
		parts.push(dim(`→ ${summary.targetTediLabel}`, color));
	}
	return parts.join(" · ");
}

/**
 * Product-language labels for the kernel's `message.phase` rows. Mirrors
 * `CHAT_PHASE_LABELS` in `apps/os/src/components/chat-streaming.tsx` so the
 * terminal and the OS describe the same moment with the same words. A phase
 * the CLI does not know is shown as its raw value with the separators
 * humanized — never as the bare event kind.
 */
export const PHASE_LABELS: Record<string, string> = {
	preparing_context: "Preparing context",
	planning: "Planning",
	generating: "Writing",
	using_tool: "Using a tool",
	delegating: "Delegating",
	finalizing: "Finalizing",
};

/** In-flight live-line key for the provisional rationale (`message.reasoning`). */
export const THINKING_ROW_KEY = "thinking";

/**
 * The route planner's PROVISIONAL rationale as one muted live line — the
 * decision forming, the same way the OS `StreamedRationaleRow` shows it. It is
 * never committed to scrollback: the settled answer supersedes it, so the
 * caller dismisses the line when the run settles. Returns null for blank text.
 */
export function formatThinkingRow(
	rationale: string,
	color: ColorMode,
): string | null {
	const text = stripControlChars(rationale).replace(/\s+/g, " ").trim();
	if (!text) return null;
	return `  ${dim("·", color)} ${dim("thinking", color)} ${dim(text, color)}`;
}

/**
 * Map a kernel event to a concise dim activity row, or null to skip it. The
 * user's own input and the terminal completion events are skipped — the final
 * answer is rendered by printSummary.
 */
export function formatActivityRow(
	event: HomeRunEvent,
	color: ColorMode,
	opts?: { tediLabel?: string },
): string | null {
	const kind = event.kind ?? "event";
	if (kind === "message.received") return null;
	// Streamed answer frames are rendered by the additive answer-stream channel
	// (answer-stream.ts → StatusSpinner.stream), not as contentless activity rows.
	if (kind === "message.delta") return null;
	// Provisional rationale chunks are accumulated by sequence and shown as one
	// muted live "thinking" line (formatThinkingRow via turn.ts), never as a row
	// per chunk — and never as a bare kind name.
	if (kind === "message.reasoning") return null;
	// Parent terminal events are rendered by printSummary, so skip them; for a
	// delegated child run the completion is meaningful inline, so keep it.
	if (
		!opts?.tediLabel &&
		(kind === "run.completed" || kind === "message.completed")
	) {
		return null;
	}

	const payload = isRecord(event.payload) ? event.payload : {};
	let label = kind.replace(/[._]/g, " ");
	let detail = "";

	if (
		/delegat/i.test(kind) ||
		stringValue(payload.status) === "needs_delegation"
	) {
		const target =
			stringValue(payload.targetTediLabel) ??
			stringValue(payload.delegatedTediId) ??
			stringValue(payload.target);
		// Suppress the "delegating" row unless an actual delegation target
		// materialized — the kernel emits a needs_delegation progress signal even
		// on turns it answers itself, which reads as if work was handed off.
		if (!target) return null;
		label = "delegating";
		detail = target;
	} else if (/tool/i.test(kind)) {
		// Verified payload shapes (packages/mcp-client-core/src/runtime.ts:666-701):
		//   tool.started   → { name, arguments: Record<string,unknown> }
		//   tool.completed → { name, result: <truncated>, latencyMs }
		//   tool.completed (tedi-runtime do.ts:4986-4989) → { toolName, data }
		//   tool.failed    → { name, error, latencyMs }
		const toolName =
			stringValue(payload.name) ?? stringValue(payload.toolName) ?? "";
		const isCompleted = /complet/i.test(kind);
		const isFailed = /fail|error/i.test(kind);
		const isStarted = !isCompleted && !isFailed;

		// Phase-colored label: cyan for running/started, green ✓ for completed,
		// red for failed/error (paint override applied below).
		label = isCompleted ? `✓ tool` : isFailed ? `tool` : `tool`;

		// Short excerpt from the most informative field for each phase.
		// All object fields are serialized defensively; missing → no excerpt.
		const excerpt = (() => {
			if (isStarted) {
				// `arguments` is a plain object — render it as compact JSON.
				const args = isRecord(payload.arguments) ? payload.arguments : null;
				if (args !== null) {
					const raw = JSON.stringify(args).replace(/\s+/g, " ");
					const codepoints = [...raw];
					return codepoints.length > 80
						? `${codepoints.slice(0, 77).join("")}…`
						: raw;
				}
				return null;
			}
			if (isCompleted) {
				// `error` field not expected here but guard defensively.
				const errStr = stringValue(payload.error);
				if (errStr) {
					const codepoints = [...stripControlChars(errStr)];
					return codepoints.length > 80
						? codepoints.slice(0, 80).join("")
						: stripControlChars(errStr);
				}
				// `result` is a truncated payload object from mcp-client-core.
				const result = payload.result;
				if (result !== undefined && result !== null) {
					const raw =
						typeof result === "string"
							? stripControlChars(result)
							: JSON.stringify(result).replace(/\s+/g, " ");
					const codepoints = [...raw];
					return codepoints.length > 80
						? `${codepoints.slice(0, 77).join("")}…`
						: raw;
				}
				// Fallback: `data` from tedi-runtime tool.completed events.
				const data = payload.data;
				if (data !== undefined && data !== null) {
					const raw =
						typeof data === "string"
							? stripControlChars(data)
							: JSON.stringify(data).replace(/\s+/g, " ");
					const codepoints = [...raw];
					return codepoints.length > 80
						? `${codepoints.slice(0, 77).join("")}…`
						: raw;
				}
				return null;
			}
			if (isFailed) {
				const errStr = stringValue(payload.error);
				if (!errStr) return null;
				const clean = stripControlChars(errStr);
				const codepoints = [...clean];
				return codepoints.length > 80
					? codepoints.slice(0, 80).join("")
					: clean;
			}
			return null;
		})();

		detail = [toolName, excerpt].filter(Boolean).join(" ");
	} else if (kind === "message.phase") {
		// Turn-progress transition: say what the kernel is doing in product
		// language ("Planning", "Preparing context", "Writing"), with the phase's
		// detail (a tool or tedi name) when it carries one.
		const phase = stringValue(payload.phase) ?? "";
		label = PHASE_LABELS[phase] ?? phase.replace(/[._]/g, " ");
		if (!label) return null;
		detail = stringValue(payload.detail) ?? "";
	} else if (kind.startsWith("submission.")) {
		label = `submission ${kind.slice("submission.".length)}`;
	} else if (kind.startsWith("run.")) {
		label = `run ${kind.slice("run.".length)}`;
	} else if (/child/i.test(kind)) {
		label = "child run";
		detail =
			stringValue(payload.childRunId) ?? stringValue(payload.status) ?? "";
	} else if (kind.startsWith("approval") || /approv/i.test(kind)) {
		label = "approval";
		detail = stringValue(payload.status) ?? "";
	}

	// Color the label by kind: tool phases get semantic color; errors red;
	// approvals yellow; routine events dim.
	const isToolKind = /tool/i.test(kind);
	const paint = isToolKind
		? /fail|error/i.test(kind)
			? red
			: /complet/i.test(kind)
				? green
				: cyan
		: /fail|error/i.test(kind)
			? red
			: /approv/i.test(kind)
				? yellow
				: dim;
	const body = paint(label, color);
	// A finished tool row carries how long it took — the same "✓ … · 4.9s" shape
	// the live in-flight line resolves into.
	const latencyMs = payload.latencyMs;
	const latency =
		typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs > 0
			? ` ${dim(`· ${formatDuration(latencyMs)}`, color)}`
			: "";
	const tail = (detail ? ` ${cyan(detail, color)}` : "") + latency;
	// Child-run rows are indented and prefixed with the delegated tedi label.
	if (opts?.tediLabel) {
		return `    ${dim(`↳ ${opts.tediLabel}`, color)} ${body}${tail}`;
	}
	return `  ${dim("·", color)} ${body}${tail}`;
}
