import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * @tedix/mcp-shared — Schema Normalization
 *
 * Normalizes the small JSON Schema subset used for MCP tool inputs into a
 * stable, dependency-free field map. Runtime-specific adapters can then convert
 * the normalized fields to Zod, TypeBox, or other validator implementations.
 */

export type NormalizedSchemaFieldType =
	| "string"
	| "number"
	| "boolean"
	| "array"
	| "object"
	| "unknown";

export interface NormalizedSchemaField {
	type: NormalizedSchemaFieldType;
	optional?: boolean;
	default?: unknown;
	description?: string;
	enum?: string[];
	min?: number;
	max?: number;
	items?: NormalizedSchemaField;
	properties?: NormalizedToolInputSchema;
	pattern?: string;
	format?: string;
}

export interface NormalizedToolInputSchema {
	[key: string]: NormalizedSchemaField;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter(
		(item): item is string => typeof item === "string",
	);
	return values.length > 0 ? values : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const number = asFiniteNumber(value);
		if (number !== undefined) return number;
	}
	return undefined;
}

function schemaType(
	value: unknown,
	schema: Record<string, unknown>,
): NormalizedSchemaFieldType {
	const rawType = Array.isArray(value)
		? value.find(
				(item): item is string => typeof item === "string" && item !== "null",
			)
		: value;

	switch (rawType) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "array":
			return "array";
		case "object":
			return "object";
		default:
			if (isRecord(schema.properties)) return "object";
			if (isRecord(schema.items)) return "array";
			if (Array.isArray(schema.enum)) return "string";
			return "unknown";
	}
}

function normalizeProperties(
	properties: Record<string, unknown>,
	required: Set<string>,
): NormalizedToolInputSchema {
	const normalized: NormalizedToolInputSchema = {};

	for (const [key, property] of Object.entries(properties)) {
		if (!isRecord(property)) continue;
		normalized[key] = normalizeSchemaField(property, !required.has(key));
	}

	return normalized;
}

/**
 * Normalize one JSON Schema property or already-normalized field definition.
 */
export function normalizeSchemaField(
	field: Record<string, unknown>,
	optional = Boolean(field.optional),
): NormalizedSchemaField {
	const type = schemaType(field.type, field);
	const normalized: NormalizedSchemaField = {
		type,
	};

	if (optional) normalized.optional = true;
	if (field.default !== undefined) normalized.default = field.default;
	if (typeof field.description === "string")
		normalized.description = field.description;

	const enumValues = asStringArray(field.enum);
	if (enumValues) normalized.enum = enumValues;

	const min = firstFiniteNumber(
		field.minimum,
		field.min,
		field.minLength,
		field.minItems,
	);
	if (min !== undefined) normalized.min = min;

	const max = firstFiniteNumber(
		field.maximum,
		field.max,
		field.maxLength,
		field.maxItems,
	);
	if (max !== undefined) normalized.max = max;

	if (isRecord(field.items)) {
		normalized.items = normalizeSchemaField(
			field.items,
			Boolean(field.items.optional),
		);
	}

	if (isRecord(field.properties)) {
		const required = new Set(asStringArray(field.required) ?? []);
		normalized.properties = normalizeProperties(field.properties, required);
	}

	if (typeof field.pattern === "string") normalized.pattern = field.pattern;
	if (typeof field.format === "string") normalized.format = field.format;

	return normalized;
}

/**
 * Normalize a top-level MCP JSON Schema object.
 *
 * JSON Schema input:
 * `{ type: "object", properties: { query: { type: "string" } }, required: ["query"] }`
 *
 */
export function normalizeToolInputSchema(
	schema: unknown,
): NormalizedToolInputSchema | null {
	if (!isRecord(schema)) return null;

	if (schema.type !== "object") return null;
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(asStringArray(schema.required) ?? []);
	return normalizeProperties(properties, required);
}
