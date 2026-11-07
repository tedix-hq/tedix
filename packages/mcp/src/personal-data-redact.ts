/**
 * Personal-data redaction for tool results.
 *
 * Opt-in per organization (`organizations.metadata.personalDataRedaction`);
 * the MCP gateway applies it in response shaping when the `app_tools` row is
 * declared `sensitive_data`. Two passes mask a result:
 *
 *   - Field pattern: a property whose name marks personal data (email, phone,
 *     national identifier, …) has its scalar values masked.
 *   - Value pattern: anywhere in a string leaf, email addresses, phone
 *     numbers and national identifiers are replaced in place — this catches
 *     personal data embedded in free text, not just dedicated fields.
 *
 * Strings mask as `[REDACTED]`; numbers and booleans under a personal-data
 * field name mask as `null` (never a fabricated value). Object and array
 * children always recurse, so structure survives. Like `content-sanitize`,
 * the module is pure — no model or network call.
 */

const MASK = "[REDACTED]";

/**
 * Whole-token field names that mark personal data. Kept to unambiguous words
 * so a token match is safe on its own (`sin`, `tin`, `rg`, `dob`, `fax` are
 * too short to substring-match).
 */
const PERSONAL_DATA_FIELD_TOKENS = new Set([
	"email",
	"mail",
	"phone",
	"mobile",
	"telephone",
	"tel",
	"cellphone",
	"fax",
	"ssn",
	"sin",
	"tin",
	"cpf",
	"nino",
	"rg",
	"dob",
	"passport",
	"aadhaar",
	"iban",
]);

/**
 * Substring field patterns for longer, unambiguous names — applied to the
 * field name with separators and case removed, so `contactEmailAddress`,
 * `primary_phone_number` and `socialSecurityNumber` all match.
 */
const PERSONAL_DATA_FIELD_NAME_RE =
	/email|phone|mobile|telephone|passport|ssn|socialsecurity|nationalid|licen[cs]e|taxid|aadhaar|nino|dateofbirth|birthdate|iban|cardnumber|creditcard|ccnum/;

/** Whether a JSON property name marks personal data. */
export function isPersonalDataField(key: string): boolean {
	const tokens = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (tokens.some((token) => PERSONAL_DATA_FIELD_TOKENS.has(token)))
		return true;
	return PERSONAL_DATA_FIELD_NAME_RE.test(tokens.join(""));
}

// ---------------------------------------------------------------------------
// Value patterns — applied inside every string leaf.
// ---------------------------------------------------------------------------

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;

/**
 * National-identifier shapes. Kept to formats with separators or check
 * letters so bare numbers (ids, counters) are never touched.
 */
const NATIONAL_ID_PATTERNS: readonly RegExp[] = [
	// US Social Security number: 123-45-6789 or 123 45 6789.
	/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
	// Aadhaar-style twelve digits in three groups of four.
	/\b\d{4}\s\d{4}\s\d{4}\b/g,
	// UK National Insurance number: QQ 12 34 56 C.
	/\b[A-CEGHJ-PR-TW-Z]{1,2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
];

/**
 * A phone-shaped run: optional leading `+` or `(`, then digits with spaces,
 * dots, dashes or parentheses. A match only masks when it carries a real
 * phone shape — a `+`, parenthesis or separator — and 9 to 15 digits, so
 * dates (`2026-11-07`), short ids and bare long numbers pass through.
 */
const PHONE_CANDIDATE_RE = /(?<![\w+])\+?\(?\d[\d\s().-]{7,18}\d(?!\d)/g;
const PHONE_SEPARATOR_RE = /[\s().+-]/;

function maskPhoneCandidates(text: string): string {
	PHONE_CANDIDATE_RE.lastIndex = 0;
	return text.replace(PHONE_CANDIDATE_RE, (match) => {
		if (!PHONE_SEPARATOR_RE.test(match)) return match;
		const digits = match.replace(/\D/g, "");
		return digits.length >= 9 && digits.length <= 15 ? MASK : match;
	});
}

/** Mask email addresses, phone numbers and national identifiers inside text. */
export function redactPersonalDataText(text: string): string {
	if (!text) return text;
	let out = text.replace(EMAIL_RE, MASK);
	for (const pattern of NATIONAL_ID_PATTERNS) {
		pattern.lastIndex = 0;
		out = out.replace(pattern, MASK);
	}
	return maskPhoneCandidates(out);
}

const MAX_REDACT_DEPTH = 50;

function redactValue(
	value: unknown,
	seen: Set<object>,
	depth: number,
	personalField: boolean,
): unknown {
	if (typeof value === "string")
		return personalField ? MASK : redactPersonalDataText(value);
	if (value === null || typeof value !== "object")
		return personalField && typeof value !== "undefined" ? null : value;
	if (depth > MAX_REDACT_DEPTH || seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) {
		const out: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i += 1)
			out[i] = redactValue(value[i], seen, depth + 1, personalField);
		seen.delete(value);
		return out;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		seen.delete(value);
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		out[key] = redactValue(
			child,
			seen,
			depth + 1,
			personalField || isPersonalDataField(key),
		);
	}
	seen.delete(value);
	return out;
}

/**
 * Deep-mask a tool result: string leaves are value-pattern redacted, fields
 * named for personal data are fully masked. Object keys pass through — a key
 * is metadata, not content.
 */
export function redactPersonalDataValue(value: unknown): unknown {
	return redactValue(value, new Set(), 0, false);
}
