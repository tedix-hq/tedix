/**
 * Pure parsing for structured payloads that arrive inside chat text: the Home
 * write-approval request, an approved write's failure, MCP content arrays,
 * and JSON objects or arrays embedded in an assistant reply.
 *
 * The server writes these as prose (see `kernelWriteCardContent` and the
 * settlement failure in `apps/api/src/rpc/routers/kernel/
 * write-approval-settlement.ts`). Rendering them verbatim puts a wall of
 * escaped JSON in the transcript, so the renderer asks these helpers for a
 * structured reading first and falls back to the original text when none
 * applies. Every helper here is conservative: it returns `null` (or a single
 * text segment) unless the input matches exactly what it knows how to read.
 */

/** JSON shorter than this stays inline; it reads fine as text. */
export const INLINE_JSON_MIN_LENGTH = 80;

/** String values longer than this are folded in the default JSON view. */
export const FOLDED_STRING_LENGTH = 120;

export type ChatTextSegment =
	| { kind: "text"; text: string }
	| { kind: "json"; raw: string; value: unknown }
	| { kind: "mcp_text"; raw: string; text: string };

/**
 * Index just past the bracket that closes the one at `start`, or -1 when the
 * text ends first. String-aware, so a brace inside a JSON string does not
 * count.
 */
function matchingBracketEnd(text: string, start: number): number {
	const stack: string[] = [];
	let inString = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index]!;
		if (inString) {
			if (char === "\\") index += 1;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") stack.push("}");
		else if (char === "[") stack.push("]");
		else if (char === "}" || char === "]") {
			if (stack.pop() !== char) return -1;
			if (stack.length === 0) return index + 1;
		}
	}
	return -1;
}

/** Ranges of fenced (```) and inline (`) code, which stay markdown. */
function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const pattern = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
	for (const match of text.matchAll(pattern)) {
		ranges.push([match.index, match.index + match[0].length]);
	}
	return ranges;
}

/**
 * The text of an MCP content array (`[{"type":"text","text":"…"}]`), or null
 * when `value` is not one. Non-text items are not rendered here, so an array
 * holding anything but text items is left alone.
 */
export function unwrapMcpContent(value: unknown): string | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const texts: string[] = [];
	for (const item of value) {
		if (
			!item ||
			typeof item !== "object" ||
			(item as { type?: unknown }).type !== "text" ||
			typeof (item as { text?: unknown }).text !== "string"
		) {
			return null;
		}
		texts.push((item as { text: string }).text);
	}
	const text = texts.join("\n\n").trim();
	return text || null;
}

/**
 * Parse `raw` as JSON, also accepting one level of string escaping
 * (`[{\"type\":\"text\"}]`), which is how a payload looks once it has been
 * embedded in another JSON string.
 */
export function parseJsonLoose(raw: string): { value: unknown } | null {
	const trimmed = raw.trim();
	if (!/^[[{]/.test(trimmed)) return null;
	try {
		return { value: JSON.parse(trimmed) };
	} catch {
		// Fall through to the escaped reading.
	}
	if (!trimmed.includes('\\"')) return null;
	try {
		const unescaped: unknown = JSON.parse(`"${trimmed}"`);
		if (typeof unescaped !== "string") return null;
		return { value: JSON.parse(unescaped) };
	} catch {
		return null;
	}
}

/**
 * Split assistant text into prose and embedded JSON. Only a balanced, valid
 * JSON object or array of at least `minLength` characters, outside code
 * spans, becomes its own segment; everything else stays text. Text with no
 * such payload comes back as one segment equal to the input.
 */
export function splitJsonSegments(
	text: string,
	minLength: number = INLINE_JSON_MIN_LENGTH,
): ChatTextSegment[] {
	const segments: ChatTextSegment[] = [];
	const code = codeRanges(text);
	let cursor = 0;
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char !== "{" && char !== "[") {
			index += 1;
			continue;
		}
		const fence = code.find(([from, to]) => index >= from && index < to);
		if (fence) {
			index = fence[1];
			continue;
		}
		const end = matchingBracketEnd(text, index);
		if (end === -1 || end - index < minLength) {
			index += 1;
			continue;
		}
		const raw = text.slice(index, end);
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			index += 1;
			continue;
		}
		if (index > cursor) {
			segments.push({ kind: "text", text: text.slice(cursor, index) });
		}
		const mcpText = unwrapMcpContent(value);
		segments.push(
			mcpText === null
				? { kind: "json", raw, value }
				: { kind: "mcp_text", raw, text: mcpText },
		);
		cursor = end;
		index = end;
	}
	if (cursor < text.length) {
		segments.push({ kind: "text", text: text.slice(cursor) });
	}
	return segments.length ? segments : [{ kind: "text", text }];
}

const ACTION_VERBS = new Set([
	"add",
	"archive",
	"cancel",
	"create",
	"delete",
	"move",
	"post",
	"publish",
	"remove",
	"rename",
	"send",
	"set",
	"update",
]);

function plainTitle(value: string, max = 80): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The tool's own name without its namespace: `os.create_os_output` → `create_os_output`. */
function bareToolName(toolName: string): string {
	return toolName.split(/\.|__/).at(-1) ?? toolName;
}

/**
 * The words of a tool name, without the `os` namespace token:
 * `os.create_os_output` → ["create", "output"].
 */
function toolWords(toolName: string): string[] {
	const words = bareToolName(toolName)
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
	const meaningful = words.filter((word) => word !== "os");
	return meaningful.length ? meaningful : words;
}

/**
 * A tool call in plain words: `os.create_os_output` with
 * `{kind:"sheet", title:"Plan"}` → `Create sheet “Plan”`. A `kind` argument
 * replaces the generic noun; a `title` or `name` argument is quoted after it.
 */
export function describeToolCall(
	toolName: string,
	args?: Record<string, unknown> | null,
): string {
	const words = toolWords(toolName);
	const kind = typeof args?.kind === "string" ? plainTitle(args.kind, 40) : "";
	if (kind && words.length >= 2 && ACTION_VERBS.has(words[0]!)) {
		words.splice(1, words.length - 1, kind.toLowerCase());
	}
	const label = words.join(" ");
	const named = [args?.title, args?.name].find(
		(value): value is string =>
			typeof value === "string" && value.trim() !== "",
	);
	const sentence = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
	return named ? `${sentence} “${plainTitle(named)}”` : sentence;
}

/**
 * The lead of a failure line: `os.create_os_output` → `Couldn't create the
 * output`. Verb-first tool names read as an action; anything else is named.
 */
export function describeToolFailure(
	toolName: string,
	args?: Record<string, unknown> | null,
): string {
	const description = describeToolCall(toolName, args);
	const words = toolWords(toolName);
	if (!ACTION_VERBS.has(words[0]!)) return `Couldn't run ${description}`;
	const [verb, ...rest] = description.split(" ");
	return rest.length
		? `Couldn't ${verb!.toLowerCase()} the ${rest.join(" ")}`
		: `Couldn't ${verb!.toLowerCase()}`;
}

export type JsonPayload =
	| { complete: true; value: unknown; raw: string }
	/** The server shortened the payload (`…`), so it no longer parses. */
	| { complete: false; raw: string };

/** Read a JSON payload that may have been cut short with a trailing `…`. */
export function readJsonPayload(raw: string): JsonPayload | null {
	const trimmed = raw.trim();
	if (!/^[[{]/.test(trimmed)) return null;
	const parsed = parseJsonLoose(trimmed);
	if (parsed) return { complete: true, value: parsed.value, raw: trimmed };
	return { complete: false, raw: trimmed.replace(/…$/, "") };
}

export type WriteApprovalRequest = {
	/** The server's plain summary, e.g. `Create sheet “Plan”`. */
	summary: string;
	/** Extra paragraphs between the summary and the "Nothing has been executed" line. */
	note: string | null;
	/** "Nothing has been executed. Reply “approve” …", as the server wrote it. */
	instruction: string;
	toolName: string;
	appSlug: string | null;
	requestId: string | null;
	args: JsonPayload | null;
};

const NOT_EXECUTED = /Nothing has been executed\.?/;

/**
 * Read the Home write-approval message (`kernelWriteCardContent`):
 *
 *     Create sheet “Plan”.
 *     Nothing has been executed. Reply “approve” or “yes” to proceed, …
 *     ### Details
 *     Tool: `os.create_os_output` on acme
 *     Request: <uuid>
 *     Arguments: {…}
 *
 * Accepts the paragraph form the server writes and the same text flattened
 * to one line. Returns null for anything else.
 */
export function parseWriteApprovalRequest(
	text: string,
): WriteApprovalRequest | null {
	const notExecuted = NOT_EXECUTED.exec(text);
	if (!notExecuted) return null;
	const tool =
		/(?:^|\s)Tool:\s*`?([A-Za-z0-9_.:-]+?)`?(?:\s+on\s+([A-Za-z0-9_.-]+?))?\.?(?=\s|$)/.exec(
			text,
		);
	if (!tool || tool.index < notExecuted.index) return null;
	const argsMatch = /(?:^|\s)Arguments:\s*/.exec(text);
	const request = /(?:^|\s)Request:\s*([A-Za-z0-9_-]+)/.exec(text);
	const lead = text.slice(0, notExecuted.index).trim();
	const paragraphs = lead
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter(Boolean);
	const summary = (paragraphs[0] ?? "").replace(/\.$/, "").trim();
	if (!summary) return null;
	const details = /(?:#{1,6}\s*)?\bDetails\b:?/.exec(
		text.slice(notExecuted.index),
	);
	const instructionEnd = details
		? notExecuted.index + details.index
		: tool.index;
	return {
		summary,
		note: paragraphs.slice(1).join("\n\n") || null,
		instruction: text
			.slice(notExecuted.index, instructionEnd)
			.replace(/\s+/g, " ")
			.trim(),
		toolName: tool[1]!,
		appSlug: tool[2] ?? null,
		requestId: request?.[1] ?? null,
		args: argsMatch
			? readJsonPayload(text.slice(argsMatch.index + argsMatch[0].length))
			: null,
	};
}

export type WriteFailure = {
	toolName: string;
	appSlug: string | null;
	/** Plain error text, unwrapped from an MCP content array when it was one. */
	error: string;
};

/**
 * Read `Approved write <tool> on <app> failed: <error>`, where the error is
 * often a raw MCP content array.
 */
export function parseWriteFailure(text: string): WriteFailure | null {
	const match =
		/^\s*Approved write ([A-Za-z0-9_.:-]+)(?: on ([A-Za-z0-9_.-]+))? failed:\s*([\s\S]*)$/.exec(
			text,
		);
	if (!match) return null;
	return {
		toolName: match[1]!,
		appSlug: match[2] ?? null,
		error: plainError(match[3]!),
	};
}

/** Error text with any MCP content array or `{error|message}` object unwrapped. */
export function plainError(raw: string): string {
	const trimmed = raw.trim();
	const parsed = parseJsonLoose(trimmed);
	if (parsed) {
		const text = unwrapMcpContent(parsed.value);
		if (text) return text;
		const record =
			parsed.value && typeof parsed.value === "object"
				? (parsed.value as Record<string, unknown>)
				: null;
		for (const key of ["message", "error"]) {
			if (typeof record?.[key] === "string" && record[key]) {
				return record[key] as string;
			}
		}
	}
	return trimmed || "No reason was given.";
}

/**
 * Pretty-print a value for the JSON view. With `fold`, string values longer
 * than `FOLDED_STRING_LENGTH` are shortened and report how much was hidden,
 * so one huge field does not bury the rest.
 */
export function formatJson(
	value: unknown,
	options: { fold?: boolean } = {},
): { text: string; folded: number } {
	let folded = 0;
	const text = JSON.stringify(
		value,
		options.fold
			? (_key, item: unknown) => {
					if (typeof item === "string" && item.length > FOLDED_STRING_LENGTH) {
						folded += 1;
						const hidden = item.length - FOLDED_STRING_LENGTH;
						return `${item.slice(0, FOLDED_STRING_LENGTH)}… (${hidden} more characters)`;
					}
					return item;
				}
			: undefined,
		2,
	);
	return { text: text ?? String(value), folded };
}

/**
 * Indent JSON text that may be cut short and so cannot be parsed. Strings are
 * copied as they are; only structure outside strings is re-indented.
 */
export function formatPartialJson(raw: string): string {
	let out = "";
	let depth = 0;
	let inString = false;
	const newline = () => `\n${"  ".repeat(depth)}`;
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index]!;
		if (inString) {
			out += char;
			if (char === "\\" && index + 1 < raw.length) {
				out += raw[index + 1];
				index += 1;
			} else if (char === '"') inString = false;
			continue;
		}
		if (/\s/.test(char)) continue;
		if (char === '"') {
			inString = true;
			out += char;
		} else if (char === "{" || char === "[") {
			depth += 1;
			out += char + newline();
		} else if (char === "}" || char === "]") {
			depth = Math.max(0, depth - 1);
			out += newline() + char;
		} else if (char === ",") {
			out += char + newline();
		} else if (char === ":") {
			out += ": ";
		} else {
			out += char;
		}
	}
	return out.replace(/\{\n\s*\}/g, "{}").replace(/\[\n\s*\]/g, "[]");
}

/** "3 fields", "12 items" — the size hint on a collapsed JSON view. */
export function jsonSizeLabel(value: unknown): string | null {
	if (Array.isArray(value)) {
		return `${value.length} item${value.length === 1 ? "" : "s"}`;
	}
	if (value && typeof value === "object") {
		const count = Object.keys(value).length;
		return `${count} field${count === 1 ? "" : "s"}`;
	}
	return null;
}
