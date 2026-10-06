/**
 * Kernel — delegation output-schema validation (opt-in "result-tool" pattern).
 *
 * A delegation caller may OPTIONALLY supply a JSON Schema-shaped contract the
 * child tedi's final answer must satisfy. This module is deliberately split
 * from `delegation-dispatch.ts` (which THREADS the schema into the work order
 * text) and `run-store.ts` (which VALIDATES the child's final answer against
 * it at the relay point): three pure, dependency-free functions, no I/O.
 *
 * Three concerns:
 *
 *  1. `extractJsonBlock`    — pull a JSON value out of the child's free-form
 *     final message (fenced ```json block, or the whole message as a last
 *     resort).
 *  2. `validateAgainstMinimalSchema` — a MINIMAL, explicitly-scoped structural
 *     validator. This is NOT a JSON Schema implementation: it supports only
 *     `type`, `required`, `properties`, `enum`, and `items`, and it is
 *     deliberately permissive on unknown object properties (matches JSON
 *     Schema's `additionalProperties: true` default). There is no `$ref`,
 *     `oneOf`/`anyOf`/`allOf`, `minLength`/`maximum`/pattern constraints, or
 *     any other JSON Schema keyword. Reach for a real JSON Schema library if
 *     this ever needs to grow beyond that surface.
 *  3. `validateDelegationOutput` — combines the two above into the single
 *     entry point `run-store.ts` calls at the relay point.
 */

// ---------------------------------------------------------------------------
// 1. Extraction
// ---------------------------------------------------------------------------

export interface ExtractedJsonBlock {
	value: unknown;
	source: "fenced" | "whole-text";
}

// Matches ```json ... ``` fenced code blocks (case-insensitive language tag).
// Non-greedy body so multiple fenced blocks in the same message are matched
// individually rather than collapsed into one.
const FENCED_JSON_BLOCK = /```json\b[ \t]*\r?\n?([\s\S]*?)```/gi;

/**
 * Find a JSON value in a free-form message.
 *
 * Strategy: prefer the LAST fenced ```json block in the text (a later block
 * wins when the child included several — e.g. one inside an explanation and
 * one as the actual structured answer). If no fenced block exists, or the
 * last fenced block fails to parse, fall back to `JSON.parse` on the whole
 * trimmed text. Returns `undefined` when neither attempt parses.
 */
export function extractJsonBlock(text: string): ExtractedJsonBlock | undefined {
	const fencedMatches = Array.from(text.matchAll(FENCED_JSON_BLOCK));
	const last = fencedMatches.at(-1);
	if (last) {
		const body = (last[1] ?? "").trim();
		if (body) {
			try {
				return { value: JSON.parse(body), source: "fenced" };
			} catch {
				// fall through to the whole-text attempt below
			}
		}
	}
	const wholeText = text.trim();
	if (!wholeText) return undefined;
	try {
		return { value: JSON.parse(wholeText), source: "whole-text" };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// 2. Minimal structural validator
// ---------------------------------------------------------------------------

export type MinimalSchemaType =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "object"
	| "array"
	| "null";

/**
 * A deliberately narrow JSON-Schema-SHAPED contract — not full JSON Schema.
 * See the module doc comment for exactly what is (and is not) supported.
 */
export interface MinimalSchema {
	type?: MinimalSchemaType | MinimalSchemaType[];
	required?: string[];
	properties?: Record<string, MinimalSchema>;
	enum?: unknown[];
	items?: MinimalSchema;
	[key: string]: unknown;
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeActualType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function matchesType(value: unknown, type: MinimalSchemaType): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isPlainObject(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			return false;
	}
}

function enumContains(allowed: unknown[], value: unknown): boolean {
	const needle = JSON.stringify(value);
	return allowed.some((candidate) => JSON.stringify(candidate) === needle);
}

/**
 * Recursively validate `value` against `schema`, accumulating every violation
 * found (never short-circuiting on the first) so a human — or the child tedi
 * on a retry — can see the full list of problems at once. Each error names
 * the exact path (e.g. `root.items[2].status`) where it occurred.
 */
function walk(
	value: unknown,
	schema: MinimalSchema,
	path: string,
	errors: string[],
): void {
	if (schema.type !== undefined) {
		const allowedTypes = Array.isArray(schema.type)
			? schema.type
			: [schema.type];
		const ok = allowedTypes.some((type) => matchesType(value, type));
		if (!ok) {
			errors.push(
				`${path}: expected type ${allowedTypes.join(" | ")}, got ${describeActualType(value)}`,
			);
		}
	}

	if (schema.enum !== undefined) {
		if (!enumContains(schema.enum, value)) {
			errors.push(
				`${path}: value ${JSON.stringify(value)} is not one of the allowed enum values [${schema.enum
					.map((item) => JSON.stringify(item))
					.join(", ")}]`,
			);
		}
	}

	// Object-shaped checks run whenever the ACTUAL value is a plain object,
	// independent of whether the `type` check above passed — this maximizes
	// how much of the contract we can still evaluate against a malformed
	// value instead of stopping at the first mismatch.
	if (isPlainObject(value)) {
		if (schema.required) {
			for (const key of schema.required) {
				if (!Object.hasOwn(value, key)) {
					errors.push(`${path}.${key}: required property is missing`);
				}
			}
		}
		if (schema.properties) {
			for (const [key, subSchema] of Object.entries(schema.properties)) {
				if (Object.hasOwn(value, key)) {
					walk(value[key], subSchema, `${path}.${key}`, errors);
				}
				// Unknown/extra properties on the value are allowed — deliberately
				// permissive, matching JSON Schema's default additionalProperties:true.
			}
		}
	}

	if (Array.isArray(value) && schema.items) {
		value.forEach((item, index) => {
			walk(item, schema.items as MinimalSchema, `${path}[${index}]`, errors);
		});
	}
}

/**
 * Validate `value` against a `MinimalSchema`. See the module doc comment for
 * the exact (narrow) supported keyword set.
 */
export function validateAgainstMinimalSchema(
	value: unknown,
	schema: MinimalSchema,
): ValidationResult {
	const errors: string[] = [];
	walk(value, schema, "root", errors);
	return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 3. Combined entry point
// ---------------------------------------------------------------------------

/**
 * Extract a JSON value from the child tedi's final message and validate it
 * against the caller-supplied output schema. Used at the Home relay point —
 * see `homeDelegationCompletionContent` in `run-store.ts`.
 */
export function validateDelegationOutput(
	finalMessage: string,
	outputSchema: MinimalSchema,
): ValidationResult {
	const extracted = extractJsonBlock(finalMessage);
	if (!extracted) {
		return {
			valid: false,
			errors: [
				"no JSON object found in the final message matching the required output schema",
			],
		};
	}
	return validateAgainstMinimalSchema(extracted.value, outputSchema);
}
