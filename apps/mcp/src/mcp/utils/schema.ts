/**
 * Schema Conversion Utilities
 *
 * Converts between JSON Schema format (stored in D1) and the schema shapes the
 * MCP SDK accepts at runtime.
 *
 * JSON Schema format (D1 storage):
 * { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
 *
 * ToolInputSchema format (intermediate, prompts only):
 * { query: { type: "string" }, limit: { type: "number", optional: true } }
 *
 * Input and output schemas skip Zod entirely: the raw D1 JSON Schema is wrapped
 * as a Standard Schema (input via `jsonSchemaToInputSchema`, output via the
 * SDK's `fromJsonSchema`), so `tools/list` advertises the stored schema verbatim.
 *
 * @module @tedix/mcp/utils/schema
 */
import {
	fromJsonSchema,
	type JsonSchemaType,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type {
	ToolInputSchema,
	ToolJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import { normalizeToolInputSchema } from "@tedix/mcp-shared/schema-normalization";
import { isRecord } from "@tedix/api-contract/utils/is-record";

type JsonObject = Record<string, unknown>;
type JsonValidator = (input: unknown) => {
	valid: boolean;
	data?: unknown;
	errorMessage?: string;
};

const jsonSchemaValidator = new CfWorkerJsonSchemaValidator({
	draft: "2020-12",
	shortcircuit: false,
});
const compiledValidatorCache = new WeakMap<object, JsonValidator>();

const EMPTY_OBJECT_INPUT_SCHEMA: ToolJsonSchema = {
	type: "object",
	properties: {},
} as ToolJsonSchema;

/**
 * Convert JSON Schema to ToolInputSchema format
 *
 * JSON Schema format (what we store):
 * { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
 *
 * ToolInputSchema format (what we need):
 * { query: { type: "string" }, limit: { type: "number", optional: true } }
 */
export function jsonSchemaToToolInputSchema(
	jsonSchema: unknown,
): ToolInputSchema | null {
	return normalizeToolInputSchema(jsonSchema) as ToolInputSchema | null;
}

/**
 * Merge JSON-Schema property `default`s into args (pre-validation), matching the
 * retired Zod path's z.default() semantics: top-level missing keys get defaults;
 * object-typed args that are present get nested defaults recursively. Copy-on-write.
 */
export function applyInputSchemaDefaults(
	args: Record<string, unknown>,
	schema: JsonObject,
): Record<string, unknown> {
	if (!isRecord(schema.properties)) return args;
	let out = args;
	for (const [key, prop] of Object.entries(schema.properties)) {
		if (!isRecord(prop)) continue;
		const current = out[key];
		if (current === undefined && prop.default !== undefined) {
			if (out === args) out = { ...args };
			out[key] = structuredClone(prop.default);
		} else if (isRecord(current) && isRecord(prop.properties)) {
			const nested = applyInputSchemaDefaults(current, prop);
			if (nested !== current) {
				if (out === args) out = { ...args };
				out[key] = nested;
			}
		}
	}
	return out;
}

/**
 * Preserve the retired `z.object` strip semantics: unknown top-level keys are
 * dropped unless the schema explicitly permits extras via `additionalProperties`.
 * Copy-on-write.
 */
function stripUnknownTopLevelKeys(
	args: Record<string, unknown>,
	schema: JsonObject,
): Record<string, unknown> {
	if (
		schema.additionalProperties === true ||
		isRecord(schema.additionalProperties)
	) {
		return args;
	}
	const properties = isRecord(schema.properties) ? schema.properties : {};
	let out: Record<string, unknown> | null = null;
	for (const key of Object.keys(args)) {
		if (Object.hasOwn(properties, key)) continue;
		out ??= { ...args };
		delete out[key];
	}
	return out ?? args;
}

/**
 * Input wrapper type: args are always object-shaped, so the SDK's
 * `registerTool` overload types the tool callback as
 * `(args: Record<string, unknown>, ctx)` instead of `(args: unknown, ctx)`.
 */
export type ToolInputStandardSchema = StandardSchemaWithJSON<
	Record<string, unknown>,
	Record<string, unknown>
>;

export interface ToolInputValidationOptions {
	toolId: string;
	/** Upstream-validated tool (transport "external" | "mcp"): validation failures
	 * warn + pass through instead of rejecting — the upstream is authoritative. */
	lenient: boolean;
	/** Pre-validation arg rewrite (external OpenAPI page-size enum correction).
	 * Runs before validation; its output is what the tool callback receives. */
	normalizeArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Wrap a stored MCP inputSchema JSON Schema as the Standard Schema shape the SDK
 * `registerTool` API accepts. Advertises the raw D1 JSON Schema verbatim in
 * `tools/list`; `~standard.validate` merges property defaults, runs the optional
 * OpenAPI arg normalizer, strips unknown top-level keys (z.object parity), then
 * validates. never returns undefined — a null/non-object stored schema falls back
 * to an empty object schema so the SDK keeps the (args, ctx) callback arity.
 */
export function jsonSchemaToInputSchema(
	jsonSchema: ToolJsonSchema | null | undefined,
	options: ToolInputValidationOptions,
): ToolInputStandardSchema {
	const effectiveSchema = (
		isRecord(jsonSchema) &&
		(jsonSchema.type === "object" || isRecord(jsonSchema.properties))
			? jsonSchema
			: EMPTY_OBJECT_INPUT_SCHEMA
	) as JsonObject;

	const validate = (data: unknown) => {
		if (!isRecord(data)) {
			return {
				issues: [
					{ message: `arguments for "${options.toolId}" must be an object` },
				],
			};
		}
		let args = applyInputSchemaDefaults(data, effectiveSchema);
		if (options.normalizeArgs) args = options.normalizeArgs(args);
		args = stripUnknownTopLevelKeys(args, effectiveSchema);

		let check = compiledValidatorCache.get(effectiveSchema);
		if (!check) {
			check = jsonSchemaValidator.getValidator(
				effectiveSchema,
			) as JsonValidator;
			compiledValidatorCache.set(effectiveSchema, check);
		}
		const result = check(args);
		if (!result.valid) {
			if (options.lenient) {
				console.warn(
					`[toolInput] "${options.toolId}" args failed schema validation (lenient upstream pass-through): ${result.errorMessage ?? "validation failed"}`,
				);
			} else {
				return {
					issues: [{ message: result.errorMessage ?? "validation failed" }],
				};
			}
		}
		return { value: args };
	};

	return {
		"~standard": {
			version: 1,
			vendor: "tedix",
			jsonSchema: {
				input: () => effectiveSchema,
				output: () => effectiveSchema,
			},
			validate,
		},
	};
}

/**
 * Wrap a stored MCP outputSchema JSON Schema as the Standard Schema shape the
 * SDK `registerTool` API accepts. `fromJsonSchema` advertises the raw D1 JSON
 * Schema verbatim in `tools/list` and validates structuredContent against it —
 * no lossy Zod round trip.
 *
 * MCP structuredContent can be any JSON value, but the registration surface
 * targets root-object output schemas; non-object output schemas are advertised
 * through our transport response transform instead of this helper.
 */
export function jsonSchemaToOutputSchema(
	jsonSchema: ToolJsonSchema | null | undefined,
): StandardSchemaWithJSON | undefined {
	if (!jsonSchema) return undefined;
	if (!hasObjectRoot(jsonSchema)) return undefined;
	return fromJsonSchema(jsonSchema as JsonSchemaType, jsonSchemaValidator);
}

function hasObjectRoot(jsonSchema: ToolJsonSchema): boolean {
	return jsonSchema.type === "object" || isRecord(jsonSchema.properties);
}

/**
 * Validate the actual MCP structuredContent against the stored outputSchema.
 * Runs for every output schema, including non-object roots that never reach
 * SDK registration.
 *
 * MCP structuredContent must be an object, so `ToolHandler.buildStructuredContent`
 * wraps a non-object upstream payload (an array, scalar, or null) as
 * `{ data }`. An upstream MCP server may still declare a non-object root
 * (GitHub's `list_commits` declares `type: ["null", "array"]`); that root
 * describes the wrapped value, so validate `data` against it rather than
 * rejecting the envelope the transport itself produced.
 */
export function validateStructuredContentAgainstOutputSchema(
	jsonSchema: ToolJsonSchema | null | undefined,
	structuredContent: unknown,
	toolId: string,
): void {
	if (!jsonSchema) return;
	if (
		!hasObjectRoot(jsonSchema) &&
		isRecord(structuredContent) &&
		"data" in structuredContent
	) {
		structuredContent = structuredContent.data;
	}
	const schemaObject = jsonSchema as JsonObject;
	let validate = compiledValidatorCache.get(schemaObject);
	if (!validate) {
		validate = jsonSchemaValidator.getValidator(schemaObject) as JsonValidator;
		compiledValidatorCache.set(schemaObject, validate);
	}
	const result = validate(structuredContent);
	if (!result.valid) {
		throw new Error(
			`Tool "${toolId}" returned structuredContent that does not match outputSchema: ${result.errorMessage ?? "validation failed"}`,
		);
	}
}
