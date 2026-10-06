import type { ToolJsonSchema } from "@tedix/api-contract/schemas/tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";

type JsonObject = Record<string, unknown>;

function schemaBranches(schema: JsonObject): unknown[] {
	const branches: unknown[] = [];
	for (const key of ["allOf", "anyOf", "oneOf"] as const) {
		if (Array.isArray(schema[key])) branches.push(...schema[key]);
	}
	return branches;
}

function schemaAllowsType(schema: unknown, type: string): boolean {
	if (!isRecord(schema)) return false;

	if (schema.type === type) return true;
	if (Array.isArray(schema.type) && schema.type.includes(type)) return true;

	return schemaBranches(schema).some((branch) =>
		schemaAllowsType(branch, type),
	);
}

function schemaProperties(schema: unknown): Record<string, unknown> {
	if (!isRecord(schema)) return {};

	const properties: Record<string, unknown> = {};
	if (isRecord(schema.properties)) Object.assign(properties, schema.properties);

	for (const branch of schemaBranches(schema)) {
		Object.assign(properties, schemaProperties(branch));
	}

	return properties;
}

function schemaItems(schema: unknown): unknown {
	if (!isRecord(schema)) return undefined;
	if ("items" in schema) return schema.items;

	for (const branch of schemaBranches(schema)) {
		const items = schemaItems(branch);
		if (items !== undefined) return items;
	}

	return undefined;
}

function schemaRequiredIncludes(schema: unknown, key: string): boolean {
	if (!isRecord(schema)) return false;
	return Array.isArray(schema.required) && schema.required.includes(key);
}

function booleanFromString(value: string): boolean | null {
	switch (value.trim().toLowerCase()) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		default:
			return null;
	}
}

function normalizeValue(value: unknown, schema: unknown): unknown {
	if (!isRecord(schema)) return value;

	if (typeof value === "string" && schemaAllowsType(schema, "boolean")) {
		const booleanValue = booleanFromString(value);
		if (booleanValue !== null) return booleanValue;
	}

	if (Array.isArray(value)) {
		const itemSchema = schemaItems(schema);
		if (itemSchema === undefined) return value;

		let next: unknown[] | null = null;
		value.forEach((item, index) => {
			const normalized = normalizeValue(item, itemSchema);
			if (normalized !== item) {
				next ??= [...value];
				next[index] = normalized;
			}
		});
		return next ?? value;
	}

	if (isRecord(value)) {
		const properties = schemaProperties(schema);
		if (Object.keys(properties).length === 0) return value;

		let next: JsonObject | null = null;
		for (const [key, childValue] of Object.entries(value)) {
			if (!(key in properties)) continue;

			const normalized = normalizeValue(childValue, properties[key]);
			if (normalized !== childValue) {
				next ??= { ...value };
				next[key] = normalized;
			}
		}
		return next ?? value;
	}

	return value;
}

export function normalizeOpenApiStructuredContent(
	structuredContent: unknown,
	outputSchema: ToolJsonSchema | null | undefined,
): unknown {
	if (!outputSchema) return structuredContent;

	if (isRecord(structuredContent) && "data" in structuredContent) {
		const data = structuredContent.data;
		const rootTypes = [
			"array",
			"boolean",
			"integer",
			"number",
			"string",
			"null",
		];
		if (rootTypes.some((type) => schemaAllowsType(outputSchema, type))) {
			return normalizeValue(data, outputSchema);
		}
	}

	const properties = schemaProperties(outputSchema);
	if (
		schemaRequiredIncludes(outputSchema, "data") &&
		"data" in properties &&
		(!isRecord(structuredContent) || !("data" in structuredContent))
	) {
		return {
			data: normalizeValue(structuredContent, properties.data),
		};
	}

	const normalized = normalizeValue(structuredContent, outputSchema);
	return normalized;
}
