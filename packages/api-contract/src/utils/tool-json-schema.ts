import * as z from "zod";
import {
	EMPTY_TOOL_INPUT_SCHEMA,
	type ToolInputJsonSchema,
	ToolInputJsonSchemaSchema,
	type ToolJsonSchema,
	ToolJsonSchemaSchema,
} from "../schemas/tools";
import { isRecord } from "./is-record";

type JsonObject = Record<string, unknown>;

function withoutDialect(schema: JsonObject): JsonObject {
	const { $schema: _schema, ...rest } = schema;
	return rest;
}

function zodToJsonSchema(
	schema: unknown,
	options: z.core.ToJSONSchemaParams = {},
): JsonObject {
	const jsonSchema = z.toJSONSchema(schema as z.ZodType, options);
	if (!isRecord(jsonSchema)) {
		throw new Error("zod to JSON Schema did not produce an object");
	}
	return withoutDialect(jsonSchema);
}

function withHoistedDefs(
	schema: JsonObject,
	rawSchema: JsonObject,
): JsonObject {
	const defs = rawSchema.$defs;
	if (!isRecord(defs) || "$defs" in schema) return schema;
	return { ...schema, $defs: defs };
}

function dataEnvelope(schema: JsonObject): JsonObject {
	return {
		type: "object",
		properties: { data: schema },
		required: ["data"],
		additionalProperties: false,
	};
}

function projectStructuredAlternative(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;
	if (schema.type === "object" || isRecord(schema.properties)) return schema;

	for (const keyword of ["anyOf", "oneOf"] as const) {
		const alternatives = schema[keyword];
		if (!Array.isArray(alternatives)) continue;
		return {
			...schema,
			[keyword]: alternatives.map(projectStructuredAlternative),
		};
	}

	// An unconstrained schema already accepts the adapter's object envelope.
	// Preserve refs and other schemas whose result type cannot be inferred here.
	if (schema.type === undefined) return schema;
	return dataEnvelope(schema);
}

export function zodToToolInputJsonSchema(schema: unknown): ToolInputJsonSchema {
	if (!schema) return EMPTY_TOOL_INPUT_SCHEMA;
	const jsonSchema = zodToJsonSchema(schema, { io: "input" });
	if (jsonSchema.type !== "object") {
		throw new Error(
			`top-level input schema must be a JSON object schema, got ${String(jsonSchema.type)}`,
		);
	}
	return ToolInputJsonSchemaSchema.parse(jsonSchema);
}

export function zodToStructuredOutputJsonSchema(
	schema: unknown,
): ToolJsonSchema | null {
	if (!schema) return null;
	const jsonSchema = zodToJsonSchema(schema, { unrepresentable: "any" });
	const projected = withHoistedDefs(jsonSchema, jsonSchema);
	const { $defs, ...rootSchema } = projected;

	// MCP permits any JSON value here, but the shared SDK ToolHandler exposes
	// every non-object API result as `{ data: value }`. Project that same shape
	// for root arrays/scalars/null and for those alternatives inside a root
	// composition. Object alternatives remain unchanged because the handler
	// returns their fields directly. Keep definitions at the document root so
	// nested `$ref: "#/$defs/..."` pointers continue to resolve.
	const normalized = projectStructuredAlternative(rootSchema) as JsonObject;
	return ToolJsonSchemaSchema.parse({
		...normalized,
		...($defs ? { $defs } : {}),
	});
}
