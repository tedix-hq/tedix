/**
 * Some routed models write their thinking into the content field instead of
 * `reasoning_content`: either `<think>…</think>` or, when the chat template
 * opens the tag for them, only a closing `</think>`. This splitter turns that
 * segment into reasoning parts so every consumer keeps only text parts as the
 * reply. Consumers never parse reply text; this is the provider adapter's job.
 */
const OPEN = "<think>";
const CLOSE = "</think>";

/** Routed models whose template opens the thinking tag before the reply. */
const IMPLICIT_THINKING_MODEL = /moonshotai\/kimi/i;

export function opensThinkingImplicitly(routedModel: string | null): boolean {
	return Boolean(routedModel && IMPLICIT_THINKING_MODEL.test(routedModel));
}

export interface ContentPiece {
	type: "text" | "reasoning";
	value: string;
}

/** Length of the longest suffix of `value` that is a proper prefix of `tag`. */
function partialTagLength(value: string, tag: string): number {
	for (
		let length = Math.min(tag.length - 1, value.length);
		length > 0;
		length--
	)
		if (tag.startsWith(value.slice(-length))) return length;
	return 0;
}

/**
 * Split one response's content deltas into text and reasoning.
 *
 * With `implicitOpen`, content is reasoning until `</think>`. It streams as
 * reasoning (hidden) while undecided; if the response ends without the tag,
 * the whole content is replayed once as text, so a reply without thinking is
 * kept, only delivered at the end.
 */
export class InlineThinkingSplitter {
	private mode: "start" | "reasoning" | "text";
	private provisional: boolean;
	private pending = "";
	private undecided = "";
	/** Whether the head of the content was checked for an opening tag. */
	private headChecked = false;
	/** Drop the whitespace that follows `</think>` before the reply starts. */
	private trimReplyStart = false;

	constructor(implicitOpen = false) {
		this.mode = implicitOpen ? "reasoning" : "start";
		this.provisional = implicitOpen;
	}

	push(content: string): ContentPiece[] {
		if (this.mode === "text") {
			if (!this.trimReplyStart) return [{ type: "text", value: content }];
			const text = content.trimStart();
			if (text) this.trimReplyStart = false;
			return text ? [{ type: "text", value: text }] : [];
		}
		this.pending += content;
		if (!this.headChecked) {
			const head = this.pending.trimStart();
			if (head.length < OPEN.length && OPEN.startsWith(head)) return [];
			this.headChecked = true;
			if (head.startsWith(OPEN)) {
				this.pending = head.slice(OPEN.length);
				this.mode = "reasoning";
				this.provisional = false;
				this.undecided = "";
			} else if (this.mode === "start") {
				this.mode = "text";
				const text = this.pending;
				this.pending = "";
				return [{ type: "text", value: text }];
			}
		}
		const close = this.pending.indexOf(CLOSE);
		if (close >= 0) {
			const reasoning = this.pending.slice(0, close);
			const text = this.pending.slice(close + CLOSE.length).trimStart();
			this.pending = "";
			this.undecided = "";
			this.mode = "text";
			this.provisional = false;
			this.trimReplyStart = !text;
			return [
				...(reasoning
					? [{ type: "reasoning" as const, value: reasoning }]
					: []),
				...(text ? [{ type: "text" as const, value: text }] : []),
			];
		}
		const held = partialTagLength(this.pending, CLOSE);
		const reasoning = this.pending.slice(0, this.pending.length - held);
		this.pending = this.pending.slice(reasoning.length);
		if (this.provisional) this.undecided += reasoning;
		return reasoning ? [{ type: "reasoning", value: reasoning }] : [];
	}

	/**
	 * The provider sent separate reasoning, so content is plain text: replay
	 * what was provisionally held as reasoning and stop splitting.
	 */
	providerReasoning(): ContentPiece[] {
		if (!this.provisional) return [];
		return this.release();
	}

	end(): ContentPiece[] {
		if (this.mode === "text") return [];
		if (this.mode === "start" || this.provisional) return this.release();
		// Explicit thinking cut off before `</think>`: still reasoning.
		const rest = this.pending;
		this.pending = "";
		return rest ? [{ type: "reasoning", value: rest }] : [];
	}

	private release(): ContentPiece[] {
		const text = this.undecided + this.pending;
		this.undecided = "";
		this.pending = "";
		this.mode = "text";
		this.provisional = false;
		return text ? [{ type: "text", value: text }] : [];
	}
}

/** Split a complete content string (non-streaming responses). */
export function splitInlineThinking(
	content: string,
	implicitOpen = false,
): { text: string; reasoning: string } {
	// Without a closing tag nothing was thinking; skip the provisional copy.
	const splitter = new InlineThinkingSplitter(
		implicitOpen && content.includes(CLOSE),
	);
	let text = "";
	let reasoning = "";
	for (const piece of [...splitter.push(content), ...splitter.end()]) {
		if (piece.type === "text") text += piece.value;
		else reasoning += piece.value;
	}
	return { text, reasoning };
}
