import type { ToolJsonSchema } from "@tedix/api-contract/schemas/tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const PAGE_SIZE_PARAM_RE =
	/^(limit|size|page[_-]?size|per[_-]?page|max[_-]?results)$/i;

/**
 * External OpenAPI-sourced tools carry vendor-authored schemas that drift; they
 * get lenient edge validation plus page-size arg normalization.
 */
export function isExternalOpenApiTool(tool: {
	config?: unknown;
	schemaSource?: string | null;
}): boolean {
	const config = tool.config as Record<string, unknown> | null | undefined;
	return config?.transport === "external" && tool.schemaSource === "openapi";
}

function numericValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function collectNumericChoices(
	schema: unknown,
	out: Array<{ value: number; kind: "number" | "string" }> = [],
): Array<{ value: number; kind: "number" | "string" }> {
	if (!isRecord(schema)) return out;

	if ("const" in schema) {
		const value = numericValue(schema.const);
		if (value !== null) {
			out.push({
				value,
				kind: typeof schema.const === "string" ? "string" : "number",
			});
		}
	}

	if (Array.isArray(schema.enum)) {
		for (const entry of schema.enum) {
			const value = numericValue(entry);
			if (value !== null) {
				out.push({
					value,
					kind: typeof entry === "string" ? "string" : "number",
				});
			}
		}
	}

	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		if (!Array.isArray(schema[key])) continue;
		for (const branch of schema[key]) collectNumericChoices(branch, out);
	}

	return out;
}

function nearestAllowedPageSize(requested: number, allowed: number[]): number {
	const sorted = [...new Set(allowed)].sort((a, b) => a - b);
	return (
		sorted.find((value) => value >= requested) ?? sorted[sorted.length - 1]!
	);
}

function normalizePageSizeValue(value: unknown, schema: unknown): unknown {
	const requested = numericValue(value);
	if (requested === null) return value;

	const choices = collectNumericChoices(schema);
	const allowed = choices.map((choice) => choice.value);
	if (allowed.length === 0 || allowed.includes(requested)) return value;

	const normalized = nearestAllowedPageSize(requested, allowed);
	const stringOnly = choices.every((choice) => choice.kind === "string");
	return stringOnly ? String(normalized) : normalized;
}

/**
 * OpenAPI-generated REST tools can expose vendor page-size enums such as
 * `10 | 20 | 50 | 100`. Agents routinely ask for `limit: 5`; sending that
 * upstream only produces a vendor validation wall. Normalize those paging-size
 * fields to the nearest supported value while leaving semantic enums untouched.
 */
export function normalizeOpenApiExternalArgs(
	args: Record<string, unknown>,
	inputSchema: ToolJsonSchema | null | undefined,
): Record<string, unknown> {
	if (!inputSchema || !isRecord(inputSchema.properties)) return args;

	let next: Record<string, unknown> | null = null;
	for (const [name, propertySchema] of Object.entries(inputSchema.properties)) {
		if (!PAGE_SIZE_PARAM_RE.test(name)) continue;
		if (!(name in args)) continue;

		const normalized = normalizePageSizeValue(args[name], propertySchema);
		if (Object.is(normalized, args[name])) continue;
		next ??= { ...args };
		next[name] = normalized;
	}

	return next ?? args;
}
