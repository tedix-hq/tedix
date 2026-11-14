import {
	HAS_DIGIT_RE,
	HAS_LETTER_RE,
	LONG_OPAQUE_SECRET_RE,
	SECRET_VALUE_PATTERNS,
	URL_BASIC_AUTH_RE,
} from "./payload-capture";

/**
 * Secret scan for tool-call arguments before public egress.
 *
 * High-confidence patterns (bearer tokens, JWTs, provider-prefixed keys, URL
 * credentials) apply to every string and every object key. The broad "long
 * opaque token" check is skipped only for content Tedix can positively
 * identify: base64 file bytes (by file signature, or a field the tool schema or
 * the argument shape declares as file content) and declared pagination
 * cursors. Base64 that decodes to text is scanned as that text.
 *
 * @module @tedix/mcp/secret-egress-scan
 */

type JsonSchema = Record<string, unknown>;

const FILE_CONTENT_KEYS = new Set([
	"base64",
	"bytes",
	"content",
	"contents",
	"data",
	"file",
	"filecontent",
	"filedata",
]);
const FILE_METADATA_KEYS = new Set([
	"contenttype",
	"filename",
	"mediatype",
	"mimetype",
	"mime_type",
	"name",
]);
const CURSOR_KEY_RE =
	/^(?:next|prev|previous)?_?(?:cursor|page_?token|continuation(?:_?token)?)$/i;
const DATA_URL_RE = /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const WHITESPACE_RE = /\s+/g;
/** Undeclared binary of this size is file content, not a credential. */
const MIN_UNSIGNED_BINARY_BYTES = 512;

/** Leading bytes of common upload formats. */
const FILE_SIGNATURES: readonly (readonly number[])[] = [
	[0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
	[0x89, 0x50, 0x4e, 0x47], // PNG
	[0xff, 0xd8, 0xff], // JPEG
	[0x47, 0x49, 0x46, 0x38], // GIF8
	[0x50, 0x4b, 0x03, 0x04], // ZIP, docx, xlsx, pptx
	[0x1f, 0x8b], // gzip
	[0x52, 0x49, 0x46, 0x46], // RIFF (WebP, WAV)
	[0x49, 0x49, 0x2a, 0x00], // TIFF little-endian
	[0x4d, 0x4d, 0x00, 0x2a], // TIFF big-endian
	[0xd0, 0xcf, 0x11, 0xe0], // legacy Office
];

type StringRole = "plain" | "file" | "cursor";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown): JsonSchema | undefined {
	return isRecord(value) ? value : undefined;
}

/** Subschemas a value may match: the schema itself plus its combinators. */
function schemaVariants(schema: JsonSchema | undefined): JsonSchema[] {
	if (!schema) return [];
	const variants = [schema];
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const list = schema[key];
		if (Array.isArray(list)) {
			for (const entry of list) {
				const sub = asSchema(entry);
				if (sub) variants.push(...schemaVariants(sub));
			}
		}
	}
	return variants;
}

function propertySchema(
	schema: JsonSchema | undefined,
	key: string,
): JsonSchema | undefined {
	for (const variant of schemaVariants(schema)) {
		const properties = asSchema(variant.properties);
		const property = asSchema(properties?.[key]);
		if (property) return property;
	}
	return undefined;
}

function itemSchema(schema: JsonSchema | undefined): JsonSchema | undefined {
	for (const variant of schemaVariants(schema)) {
		const items = asSchema(variant.items);
		if (items) return items;
	}
	return undefined;
}

function declaresBinary(schema: JsonSchema | undefined): boolean {
	return schemaVariants(schema).some(
		(variant) =>
			variant.format === "binary" ||
			variant.format === "byte" ||
			variant.contentEncoding === "base64" ||
			typeof variant.contentMediaType === "string",
	);
}

/** A file object: one content field next to a filename or media type. */
function isFileShaped(parent: Record<string, unknown>): boolean {
	const keys = Object.keys(parent).map((key) => key.toLowerCase());
	return (
		keys.some((key) => FILE_CONTENT_KEYS.has(key)) &&
		keys.some((key) => FILE_METADATA_KEYS.has(key))
	);
}

function decodeBase64(value: string): Uint8Array | null {
	const compact = value.replace(DATA_URL_RE, "").replace(WHITESPACE_RE, "");
	if (compact.length < 4 || compact.length % 4 === 1) return null;
	let normalized: string;
	if (BASE64_RE.test(compact)) normalized = compact;
	else if (BASE64URL_RE.test(compact))
		normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
	else return null;
	normalized = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	try {
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

function hasFileSignature(bytes: Uint8Array): boolean {
	return FILE_SIGNATURES.some((signature) =>
		signature.every((byte, index) => bytes[index] === byte),
	);
}

/** UTF-8 text without control characters other than tab and newlines. */
function decodeText(bytes: Uint8Array): string | null {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			bytes,
		);
	} catch {
		return null;
	}
	// oxlint-disable-next-line no-control-regex -- detects binary bytes
	return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
		? null
		: text;
}

function findHighConfidencePattern(text: string): string | null {
	URL_BASIC_AUTH_RE.lastIndex = 0;
	if (URL_BASIC_AUTH_RE.test(text)) return "URL basic authentication";
	for (const { name, pattern } of SECRET_VALUE_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(text)) return name;
	}
	return null;
}

function findOpaqueToken(text: string): string | null {
	LONG_OPAQUE_SECRET_RE.lastIndex = 0;
	for (const match of text.matchAll(LONG_OPAQUE_SECRET_RE)) {
		const candidate = match[0];
		if (HAS_LETTER_RE.test(candidate) && HAS_DIGIT_RE.test(candidate))
			return "long opaque token";
	}
	return null;
}

function findInText(text: string): string | null {
	return findHighConfidencePattern(text) ?? findOpaqueToken(text);
}

function scanString(value: string, role: StringRole): string | null {
	const highConfidence = findHighConfidencePattern(value);
	if (highConfidence) return highConfidence;
	if (!findOpaqueToken(value)) return null;

	const bytes = decodeBase64(value);
	if (!bytes) return "long opaque token";
	// File signatures identify uploads wherever they appear.
	if (hasFileSignature(bytes)) return null;
	const text = decodeText(bytes);
	if (role === "cursor") {
		// A declared cursor is opaque by design; still reject a credential
		// hidden inside its decoded form.
		return text === null ? null : findHighConfidencePattern(text);
	}
	if (role === "file") {
		if (text !== null) return findInText(text);
		return bytes.length >= MIN_UNSIGNED_BINARY_BYTES
			? null
			: "long opaque token";
	}
	return "long opaque token";
}

function scan(
	value: unknown,
	schema: JsonSchema | undefined,
	role: StringRole,
): string | null {
	if (typeof value === "string") return scanString(value, role);
	if (Array.isArray(value)) {
		const items = itemSchema(schema);
		for (const item of value) {
			const found = scan(item, items, role === "file" ? "file" : "plain");
			if (found) return found;
		}
		return null;
	}
	if (!isRecord(value)) return null;
	const fileShaped = isFileShaped(value);
	for (const [key, child] of Object.entries(value)) {
		const keyFinding = findInText(key);
		if (keyFinding) return keyFinding;
		const childSchema = propertySchema(schema, key);
		let childRole: StringRole = "plain";
		if (
			declaresBinary(childSchema) ||
			(fileShaped && FILE_CONTENT_KEYS.has(key.toLowerCase()))
		) {
			childRole = "file";
		} else if (CURSOR_KEY_RE.test(key) && childSchema) {
			childRole = "cursor";
		}
		const found = scan(child, childSchema, childRole);
		if (found) return found;
	}
	return null;
}

/**
 * Return the first secret pattern in tool-call arguments, or null.
 * `inputSchema` is the tool's JSON Schema; it marks binary fields
 * (`format: binary|byte`, `contentEncoding: base64`, `contentMediaType`) and
 * declares cursor fields.
 */
export function findSecretValuePattern(
	value: unknown,
	inputSchema?: Record<string, unknown>,
): string | null {
	return scan(value, inputSchema, "plain");
}
