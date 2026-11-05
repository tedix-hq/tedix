/**
 * Sanitize and label content returned by third-party tools.
 *
 * Mirrors github-mcp-server's `pkg/sanitize` and `pkg/ifc`: text coming back
 * from `external` and upstream `mcp` transports can carry prompt-injection
 * payloads — invisible Unicode (zero-width, tag and bidirectional override
 * characters) and unsafe HTML (`<script>`, event handlers, `javascript:`
 * URLs). Both are removed before the payload reaches a model, a Code Mode
 * sandbox, or a client.
 *
 * Sanitization applies to text only: string leaves are treated as text and
 * every transform is removal-only, so clean identifiers, URLs and structured
 * numbers pass through byte-identical. There is no model or network call —
 * the module is pure.
 */

/** The `_meta` key carrying the gateway's trust label on every tool result. */
export const TOOL_TRUST_META_KEY = "com.tedix/trust";

export interface ToolTrustLabel {
	integrity: "trusted" | "untrusted";
	confidentiality: "public" | "private";
}

/** Third-party content enters only through these transports. */
export function isUntrustedTransport(transport: unknown): boolean {
	return transport === "external" || transport === "mcp";
}

/**
 * The result label: integrity follows the app's transport (external and
 * upstream-MCP results are third-party content), confidentiality follows the
 * tool row's `sensitiveData` declaration.
 */
export function resolveToolTrustLabel(input: {
	transport?: unknown;
	sensitiveData?: unknown;
}): ToolTrustLabel {
	return {
		integrity: isUntrustedTransport(input.transport) ? "untrusted" : "trusted",
		confidentiality: input.sensitiveData === true ? "private" : "public",
	};
}

// ---------------------------------------------------------------------------
// Invisible and bidirectional Unicode
// ---------------------------------------------------------------------------

/**
 * The same character set github-mcp-server removes: Unicode tag characters,
 * BiDi controls and isolates, and hidden modifier characters. ZWJ (U+200D)
 * and variation selectors stay — emoji and CJK text need them.
 */
const INVISIBLE_CHAR_RE =
	/[\u00AD\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0001}\u{E0020}-\u{E007F}]/gu;

export function stripInvisibleCharacters(text: string): string {
	return text.replace(INVISIBLE_CHAR_RE, "");
}

// ---------------------------------------------------------------------------
// Unsafe HTML
// ---------------------------------------------------------------------------

/** Formatting markup that survives, matching the GitHub policy set. */
const ALLOWED_ELEMENTS = new Set([
	"a",
	"b",
	"blockquote",
	"br",
	"code",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"li",
	"ol",
	"p",
	"pre",
	"strong",
	"sub",
	"sup",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
	"ul",
]);

/** Attributes kept per allowed element; everything else is dropped. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(["href", "title"]),
	img: new Set(["src", "alt", "title"]),
};

/**
 * Elements whose whole subtree is dropped. Their contents are markup or
 * code, never prose — bluemonday skips them the same way.
 */
const DROP_CONTENT_ELEMENTS = new Set([
	"applet",
	"embed",
	"frame",
	"frameset",
	"iframe",
	"math",
	"object",
	"script",
	"style",
	"svg",
	"template",
]);

const VOID_ELEMENTS = new Set(["br", "hr", "img"]);

const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

function isSafeUrl(value: string): boolean {
	// Strip control and whitespace characters a scheme can hide inside.
	const compact = value.replace(/[\u0000-\u0020]/g, "");
	if (compact.startsWith("#") || compact.startsWith("/")) return true;
	const schemeEnd = compact.indexOf(":");
	if (schemeEnd === -1) return true;
	return SAFE_URL_SCHEMES.has(compact.slice(0, schemeEnd).toLowerCase());
}

function escapeAttrValue(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

interface ParsedTag {
	name: string;
	closing: boolean;
	selfClosing: boolean;
	attributes: Map<string, string | null>;
	/** Index just past the tag's `>`. */
	end: number;
}

const TAG_NAME_RE = /[a-zA-Z][a-zA-Z0-9-]*/y;

/**
 * Parse the tag starting at `open` (`input[open] === "<"`). Returns null when
 * the `<` is not markup at all or the tag never terminates — callers then
 * treat the `<` as literal text.
 */
function parseTag(input: string, open: number): ParsedTag | null {
	let i = open + 1;
	let closing = false;
	if (input.charAt(i) === "/") {
		closing = true;
		i += 1;
	}
	TAG_NAME_RE.lastIndex = i;
	const nameMatch = TAG_NAME_RE.exec(input);
	if (!nameMatch) return null;
	const name = nameMatch[0].toLowerCase();
	i = TAG_NAME_RE.lastIndex;

	const attributes = new Map<string, string | null>();
	let selfClosing = false;
	const skipSpace = () => {
		while (i < input.length && /\s/.test(input.charAt(i))) i += 1;
	};
	for (;;) {
		skipSpace();
		if (i >= input.length) return null;
		const ch = input.charAt(i);
		if (ch === ">") {
			i += 1;
			return { name, closing, selfClosing, attributes, end: i };
		}
		if (ch === "/" && input.charAt(i + 1) === ">") {
			i += 2;
			selfClosing = true;
			return { name, closing, selfClosing, attributes, end: i };
		}
		// Attribute name: anything up to whitespace, `=`, `/` or `>`.
		const nameStart = i;
		while (i < input.length && !/[\s=/>]/.test(input.charAt(i))) i += 1;
		if (i === nameStart) return null;
		const attrName = input.slice(nameStart, i).toLowerCase();
		skipSpace();
		if (input.charAt(i) === "=") {
			i += 1;
			skipSpace();
			const quote = input.charAt(i);
			let value: string;
			if (quote === '"' || quote === "'") {
				const valueStart = ++i;
				const close = input.indexOf(quote, i);
				if (close === -1) return null;
				value = input.slice(valueStart, close);
				i = close + 1;
			} else {
				const valueStart = i;
				while (i < input.length && !/[\s>]/.test(input.charAt(i))) i += 1;
				value = input.slice(valueStart, i);
			}
			attributes.set(attrName, value);
		} else {
			attributes.set(attrName, null);
		}
	}
}

const HTML_ENTITIES_RE = /&(?:#(x[0-9a-fA-F]+|\d+)|([a-zA-Z][a-zA-Z0-9]*));?/g;
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * Decode entities in an attribute value so `java&#115;cript:` cannot smuggle
 * a dangerous scheme past the URL check. The original value is what gets
 * re-emitted (escaped) — this is only for the safety decision.
 */
function decodeEntities(text: string): string {
	return text.replace(HTML_ENTITIES_RE, (match, code, named) => {
		if (code !== undefined) {
			const cp = code.startsWith("x")
				? parseInt(code.slice(1), 16)
				: parseInt(code, 10);
			try {
				return String.fromCodePoint(cp);
			} catch {
				return match;
			}
		}
		// Unknown entities are preserved — `?a=1&b=2` is a URL, not markup.
		return NAMED_ENTITIES[named.toLowerCase()] ?? match;
	});
}

/** Find `</name` (case-insensitive) at or after `from`; -1 when absent. */
function findCloseTag(input: string, name: string, from: number): number {
	const needle = `</${name}`;
	const haystack = input.toLowerCase();
	let i = haystack.indexOf(needle, from);
	while (i !== -1) {
		const after = input[i + needle.length];
		if (
			after === undefined ||
			/\s/.test(after) ||
			after === "/" ||
			after === ">"
		)
			return i;
		i = haystack.indexOf(needle, i + 1);
	}
	return -1;
}

function renderTag(tag: ParsedTag): string {
	if (tag.closing) return `</${tag.name}>`;
	const allowed = ALLOWED_ATTRIBUTES[tag.name];
	let attrs = "";
	if (allowed) {
		for (const [attrName, attrValue] of tag.attributes) {
			if (!allowed.has(attrName)) continue;
			if (
				(attrName === "href" || attrName === "src") &&
				(attrValue === null || !isSafeUrl(decodeEntities(attrValue)))
			)
				continue;
			attrs +=
				attrValue === null
					? ` ${attrName}`
					: ` ${attrName}="${escapeAttrValue(attrValue)}"`;
		}
	}
	return VOID_ELEMENTS.has(tag.name)
		? `<${tag.name}${attrs}/>`
		: `<${tag.name}${attrs}>`;
}

/**
 * Remove comments, processing instructions, every element outside the
 * formatting allowlist and every unsafe attribute. Content of raw-text or
 * embed elements (script/style/iframe/svg/…) is dropped with the element;
 * other disallowed elements lose only their markup.
 */
export function stripUnsafeHtml(input: string): string {
	// Decode entities first so `&lt;script>` and `<scr&#105;pt>` cannot hide
	// markup from the tag parser.
	const decoded = decodeEntities(input);
	if (!decoded.includes("<")) return decoded;
	input = decoded;
	let out = "";
	let i = 0;
	while (i < input.length) {
		const open = input.indexOf("<", i);
		if (open === -1) {
			out += input.slice(i);
			break;
		}
		out += input.slice(i, open);
		const next = input[open + 1];
		if (next === "!") {
			// Comments drop entirely; declarations end at `>`.
			if (input.startsWith("<!--", open)) {
				const close = input.indexOf("-->", open + 4);
				i = close === -1 ? input.length : close + 3;
				continue;
			}
			const close = input.indexOf(">", open + 2);
			i = close === -1 ? input.length : close + 1;
			continue;
		}
		if (next === "?") {
			const close = input.indexOf(">", open + 2);
			i = close === -1 ? input.length : close + 1;
			continue;
		}
		const tag = parseTag(input, open);
		if (!tag) {
			out += "<";
			i = open + 1;
			continue;
		}
		i = tag.end;
		if (tag.closing) {
			if (ALLOWED_ELEMENTS.has(tag.name)) out += renderTag(tag);
			continue;
		}
		if (DROP_CONTENT_ELEMENTS.has(tag.name)) {
			if (tag.selfClosing) continue;
			const close = findCloseTag(input, tag.name, i);
			if (close === -1) {
				i = input.length;
				continue;
			}
			const closeTag = parseTag(input, close);
			i = closeTag ? closeTag.end : input.length;
			continue;
		}
		if (ALLOWED_ELEMENTS.has(tag.name)) {
			out += renderTag(tag);
		}
		// Any other element loses its markup but keeps its text content.
	}
	return out;
}

/**
 * Clean one text field: invisible and bidirectional characters first (so a
 * zero-width character cannot hide inside a tag name), then unsafe HTML.
 */
export function sanitizeUntrustedText(text: string): string {
	if (!text) return text;
	return stripUnsafeHtml(stripInvisibleCharacters(text));
}

const MAX_SANITIZE_DEPTH = 50;

function sanitizeValue(value: unknown, seen: Set<object>, depth: number) {
	if (typeof value === "string") return sanitizeUntrustedText(value);
	if (value === null || typeof value !== "object") return value;
	if (depth > MAX_SANITIZE_DEPTH || seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) {
		const out: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i += 1)
			out[i] = sanitizeValue(value[i], seen, depth + 1);
		seen.delete(value);
		return out;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		seen.delete(value);
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value))
		out[key] = sanitizeValue(child, seen, depth + 1);
	seen.delete(value);
	return out;
}

/**
 * Deep-sanitize an untrusted result payload. Every string leaf is treated as
 * text; object keys, numbers, booleans, null and non-plain objects pass
 * through unchanged, so identifiers and URLs are never re-encoded or
 * restructured.
 */
export function sanitizeUntrustedValue(value: unknown): unknown {
	return sanitizeValue(value, new Set(), 0);
}
