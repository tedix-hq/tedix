/**
 * Promote-in-place region for the streamed answer.
 *
 * The old live line was clear-and-reprint: the whole answer-so-far lived in a
 * transient line that was erased on settle, after which the canonical message
 * printed on top of text the user had already read. This region instead
 * PROMOTES: as soon as a piece of the answer is stable it is committed into
 * real scrollback and never rewritten; only the unstable tail stays in the
 * live region.
 *
 * Invariants:
 *   - A committed line is IMMUTABLE. Nothing in this module rewrites, erases,
 *     or re-emits a line it already handed to `commit`.
 *   - Stability is per BLOCK, not per wrapped row. The answer is markdown and
 *     `renderMarkdown` is only correct on a complete block — committing a
 *     half-written `**bold` as a final row would either render wrongly or force
 *     a rewrite, and a rewrite is exactly what this region forbids. A block is
 *     terminated by a blank line outside a fenced code span, which is also the
 *     unit opencode's renderer calls a stable block.
 *   - The canonical `message.completed` answer remains the source of truth. The
 *     region only ever commits text that is a prefix of, or reconciled against,
 *     that canonical answer (see `settle`).
 *   - Resize does NOT replay committed scrollback (see `noteWidth`).
 */

export interface PromoteRegionOptions {
	/** Commit one immutable line into real scrollback. */
	commit: (line: string) => void;
	/** Render a complete block of answer markdown into final display lines. */
	render: (text: string, width: number) => string[];
	/** Width changes are adopted only after this much quiet. */
	resizeDebounceMs?: number;
}

const DEFAULT_RESIZE_DEBOUNCE_MS = 250;

/** Length of the longest common prefix of two strings, in UTF-16 units. */
function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i++;
	return i;
}

/**
 * Length of the prefix of `text` that is made only of COMPLETE blocks — every
 * character up to and including the last blank line that is not inside a fenced
 * code span. Everything after it may still grow, so it is not stable.
 */
export function stableBlockPrefixLength(text: string): number {
	const lines = text.split("\n");
	let offset = 0;
	let boundary = 0;
	let inFence = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const isLast = index === lines.length - 1;
		if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
		offset += line.length + (isLast ? 0 : 1);
		// The final line is never a boundary: the stream can still extend it.
		if (!inFence && !isLast && line.trim() === "") boundary = offset;
	}
	return boundary;
}

export class PromoteRegion {
	readonly #commit: (line: string) => void;
	readonly #render: (text: string, width: number) => string[];
	readonly #debounceMs: number;

	/** Source text already committed to scrollback; always a prefix of `#text`. */
	#committed = "";
	#text = "";
	#width = 80;
	#widthObserved = false;
	#pendingWidth: number | undefined;
	#pendingSince = 0;
	#started = false;
	#sawText = false;

	constructor(opts: PromoteRegionOptions) {
		this.#commit = opts.commit;
		this.#render = opts.render;
		this.#debounceMs = opts.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;
	}

	/** Source text already in scrollback. Empty until the first block commits. */
	committedText(): string {
		return this.#committed;
	}

	/** True once any answer text has been ingested at all. */
	get active(): boolean {
		return this.#sawText;
	}

	/** Width used for the next commit and for the live tail. */
	get width(): number {
		return this.#width;
	}

	/**
	 * Observe the terminal width.
	 *
	 * RESIZE DECISION: committed scrollback is left alone; only the live tail
	 * reflows. We write committed lines into the terminal's own scrollback with
	 * plain writes and cannot address them again — replaying the session the way
	 * opencode does needs ownership of the whole surface, which this CLI
	 * deliberately does not take. Re-emitting a replay into a stdout that also
	 * carries activity rows and the summary footer would duplicate text the user
	 * already read, which is the exact defect promotion exists to remove.
	 *
	 * The first observed width is adopted at once — there is no committed
	 * scrollback yet, so nothing can commit at the 80-column placeholder.
	 * Later CHANGES are debounced: a new width must hold for `resizeDebounceMs`
	 * before it decides a commit boundary, so a drag does not commit a block at
	 * a width that existed for one frame.
	 */
	noteWidth(width: number, now: number): void {
		const next = Math.max(20, Math.floor(width));
		if (!this.#widthObserved) {
			this.#widthObserved = true;
			this.#width = next;
			return;
		}
		if (next === this.#width) {
			this.#pendingWidth = undefined;
			return;
		}
		if (next !== this.#pendingWidth) {
			this.#pendingWidth = next;
			this.#pendingSince = now;
			return;
		}
		if (now - this.#pendingSince >= this.#debounceMs) {
			this.#width = next;
			this.#pendingWidth = undefined;
		}
	}

	/**
	 * Ingest the answer-so-far. Commits every newly complete block and returns
	 * the unstable tail for the live region.
	 */
	update(text: string, width: number, now: number): string {
		this.noteWidth(width, now);
		if (!text) return this.#text.slice(this.#committed.length);
		this.#sawText = true;
		if (!text.startsWith(this.#committed)) {
			// A durable re-drive replaced the answer generation. Committed lines are
			// immutable, so re-anchor on the longest common prefix and continue from
			// there; the divergent tail the user already saw stays in scrollback.
			this.#committed = this.#committed.slice(
				0,
				commonPrefixLength(text, this.#committed),
			);
		}
		this.#text = text;
		const stable = stableBlockPrefixLength(text);
		if (stable > this.#committed.length) {
			this.#emit(text.slice(this.#committed.length, stable));
			this.#committed = text.slice(0, stable);
		}
		return text.slice(this.#committed.length);
	}

	/** Unstable tail currently owned by the live region. */
	tail(): string {
		return this.#text.slice(this.#committed.length);
	}

	/**
	 * Settle against the canonical answer and commit whatever is left.
	 *
	 * Returns the source prefix that is now in scrollback, so the caller can tell
	 * the summary renderer not to print it again. Returns "" when nothing
	 * streamed (then the summary prints the whole answer as before) or when the
	 * canonical answer contradicts what was committed — a committed line cannot
	 * be taken back, so the canonical text reprints in full and wins.
	 */
	settle(canonical: string, width: number, now: number): string {
		this.noteWidth(width, now);
		if (!this.#sawText) return "";
		const text = canonical || this.#text;
		if (!text.startsWith(this.#committed)) return "";
		const rest = text.slice(this.#committed.length);
		if (rest.trim()) this.#emit(rest);
		this.#committed = text;
		this.#text = text;
		return this.#committed;
	}

	/** Render one or more complete blocks and commit them, immutably. */
	#emit(chunk: string): void {
		const body = chunk.replace(/\s+$/, "");
		if (!body) return;
		// One blank line before the first committed block, matching the blank line
		// the summary renderer puts in front of an answer.
		if (!this.#started) {
			this.#started = true;
			this.#commit("");
		}
		for (const line of this.#render(body, this.#width)) this.#commit(line);
		this.#commit("");
	}
}
