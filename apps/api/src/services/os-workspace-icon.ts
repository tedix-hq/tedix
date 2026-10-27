/**
 * Validation for uploaded workspace icons. An icon is shown across the OS and
 * served publicly, so this is a security boundary: the bytes must match the
 * declared type, and an SVG passes only when every element and attribute is
 * on a small allowlist that cannot run script or load anything external.
 * Anything unexpected is rejected rather than rewritten.
 */
import {
	OS_WORKSPACE_ICON_MAX_BYTES,
	type OS_WORKSPACE_ICON_CONTENT_TYPES,
} from "@tedix/api-contract/schemas/os-workspaces";

export type OsWorkspaceIconContentType =
	(typeof OS_WORKSPACE_ICON_CONTENT_TYPES)[number];

export type OsWorkspaceIconCheck =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; reason: string };

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** Drawing-only SVG elements. No script, foreignObject, image, a, style, animation or filter. */
const SVG_ELEMENTS = new Set([
	"svg",
	"g",
	"path",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"rect",
	"title",
	"desc",
	"defs",
	"lineargradient",
	"radialgradient",
	"stop",
	"clippath",
	"mask",
	"symbol",
	"use",
	"text",
	"tspan",
]);

export function decodeOsWorkspaceIcon(fileData: string): Uint8Array | null {
	try {
		return Uint8Array.from(atob(fileData), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

export function checkOsWorkspaceIcon(
	bytes: Uint8Array,
	contentType: OsWorkspaceIconContentType,
): OsWorkspaceIconCheck {
	if (bytes.byteLength === 0)
		return { ok: false, reason: "The image is empty" };
	if (bytes.byteLength > OS_WORKSPACE_ICON_MAX_BYTES) {
		return { ok: false, reason: "The image must be 1 MB or smaller" };
	}
	switch (contentType) {
		case "image/png":
			return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
				? { ok: true, bytes }
				: { ok: false, reason: "The file is not a PNG image" };
		case "image/jpeg":
			return startsWith(bytes, [0xff, 0xd8, 0xff])
				? { ok: true, bytes }
				: { ok: false, reason: "The file is not a JPEG image" };
		case "image/webp":
			return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
				ascii(bytes.subarray(8, 12)) === "WEBP"
				? { ok: true, bytes }
				: { ok: false, reason: "The file is not a WebP image" };
		case "image/svg+xml": {
			let text: string;
			try {
				text = new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: false,
				}).decode(bytes);
			} catch {
				return { ok: false, reason: "The SVG is not valid UTF-8 text" };
			}
			const reason = unsafeSvgReason(text);
			return reason ? { ok: false, reason } : { ok: true, bytes };
		}
	}
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
	return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array): string {
	return String.fromCharCode(...bytes);
}

const TAG_OPEN =
	/^<([A-Za-z][\w.-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/;
const TAG_CLOSE = /^<\/([A-Za-z][\w.-]*)\s*>/;
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Returns why an SVG document is unsafe, or null when every tag and attribute
 * is allowed. Exported for tests.
 */
export function unsafeSvgReason(source: string): string | null {
	let rest = source.replace(/^﻿/, "").trimStart();
	const declaration = /^<\?xml\s[^?]*\?>/.exec(rest);
	if (declaration) rest = rest.slice(declaration[0].length);

	const stack: string[] = [];
	let sawRoot = false;
	while (rest.length > 0) {
		const lt = rest.indexOf("<");
		if (lt === -1) {
			if (stack.length > 0 || rest.trim()) return "The SVG is not well formed";
			break;
		}
		const textBefore = rest.slice(0, lt);
		if (stack.length === 0 && textBefore.trim()) {
			return "The SVG has content outside its root element";
		}
		rest = rest.slice(lt);

		if (rest.startsWith("<!--")) {
			const end = rest.indexOf("-->", 4);
			if (end === -1) return "The SVG is not well formed";
			rest = rest.slice(end + 3);
			continue;
		}
		if (rest.startsWith("<!") || rest.startsWith("<?")) {
			return "SVG icons cannot contain DOCTYPE, entity, CDATA or processing instructions";
		}

		const close = TAG_CLOSE.exec(rest);
		if (close) {
			if (stack.pop() !== close[1]) return "The SVG is not well formed";
			rest = rest.slice(close[0].length);
			continue;
		}

		const open = TAG_OPEN.exec(rest);
		if (!open) return "The SVG is not well formed";
		const [whole, name = "", attributes = "", selfClosing] = open;
		if (stack.length === 0) {
			if (sawRoot) return "The SVG has more than one root element";
			if (name !== "svg") return "The file's root element is not <svg>";
			sawRoot = true;
		}
		if (!SVG_ELEMENTS.has(name.toLowerCase())) {
			return `SVG icons cannot contain <${name}> elements`;
		}
		const attributeReason = unsafeAttributesReason(attributes);
		if (attributeReason) return attributeReason;
		if (!selfClosing) stack.push(name);
		rest = rest.slice(whole.length);
	}
	if (!sawRoot) return "The file's root element is not <svg>";
	if (stack.length > 0) return "The SVG is not well formed";
	return null;
}

function unsafeAttributesReason(attributes: string): string | null {
	for (const match of attributes.matchAll(ATTRIBUTE)) {
		const name = match[1] ?? "";
		const value = decodeEntities(match[2] ?? match[3] ?? "");
		if (value === null)
			return "The SVG uses an unsupported character reference";
		const lower = name.toLowerCase();
		const compact = value.replace(/[\s\p{Cc}]+/gu, "").toLowerCase();

		if (lower.startsWith("on")) {
			return "SVG icons cannot contain event handlers";
		}
		if (lower === "xmlns") {
			if (value !== SVG_NAMESPACE)
				return "The SVG declares an unsupported namespace";
			continue;
		}
		if (lower.startsWith("xmlns:")) {
			if (lower !== "xmlns:xlink" || value !== XLINK_NAMESPACE) {
				return "The SVG declares an unsupported namespace";
			}
			continue;
		}
		if (
			lower.includes(":") &&
			lower !== "xlink:href" &&
			lower !== "xml:space"
		) {
			return `SVG icons cannot contain the ${name} attribute`;
		}
		if (lower === "href" || lower === "xlink:href") {
			if (!/^#[\w.-]*$/.test(value.trim())) {
				return "SVG icons can only link to their own elements";
			}
			continue;
		}
		if (
			compact.includes("javascript:") ||
			compact.includes("vbscript:") ||
			compact.includes("data:") ||
			compact.includes("@import") ||
			compact.includes("expression(") ||
			/url\((?!['"]?#)/.test(compact)
		) {
			return "SVG icons cannot reference scripts or external resources";
		}
	}
	return null;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/** Decodes XML character references; null on one XML does not define. */
function decodeEntities(value: string): string | null {
	let failed = false;
	const decoded = value.replace(/&([^;]*);?/g, (_, body: string) => {
		const numeric = /^#(x[0-9a-f]+|[0-9]+)$/i.exec(body);
		if (numeric?.[1]) {
			const digits = numeric[1];
			const code =
				digits[0] === "x" || digits[0] === "X"
					? Number.parseInt(digits.slice(1), 16)
					: Number.parseInt(digits, 10);
			if (code > 0x10ffff) {
				failed = true;
				return "";
			}
			return String.fromCodePoint(code);
		}
		const named = NAMED_ENTITIES[body];
		if (named === undefined) failed = true;
		return named ?? "";
	});
	return failed ? null : decoded;
}
