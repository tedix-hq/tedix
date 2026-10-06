import type {
	OpenApiImportInput,
	OpenApiImportResult,
} from "@tedix/api-contract/schemas/catalog";
import {
	EMPTY_TOOL_INPUT_SCHEMA,
	type ToolConfig,
	type ToolInputJsonSchema,
	ToolInputJsonSchemaSchema,
	type ToolJsonSchema,
	ToolJsonSchemaSchema,
} from "@tedix/api-contract/schemas/tools";
import type { DbClient } from "@tedix/db/client";
import {
	type PortableWebMcpReconciliation,
	reconcilePublishedWebMcpProfiles,
} from "./reconcile-portable-webmcp-profiles";
import { getAppById, updateApp } from "@tedix/db/queries/app-records";
import {
	deleteTool,
	getToolsByAppId,
	upsertTool,
} from "@tedix/db/queries/tools";
import type { AppMetadata } from "@tedix/db/schema/apps";
import { toJsonRecord } from "@tedix/db/utils/json";
import { parse as parseYaml } from "yaml";
import { isRecord } from "@tedix/api-contract/utils/is-record";

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type StoredOpenApiSyncConfig = Partial<
	Pick<
		OpenApiImportInput,
		| "spec"
		| "specUrl"
		| "supplementalSpecUrls"
		| "baseUrl"
		| "namespace"
		| "connectionProviderId"
		| "connectionScope"
		| "authScopes"
		| "authHeader"
		| "authTemplate"
		| "authEncoding"
		| "staticHeaders"
		| "includeOperationIds"
		| "includePathPrefixes"
		| "excludePathPrefixes"
		| "stripPathPrefixes"
		| "pathReplacements"
		| "widgetDefaults"
		| "widgetOverrides"
		| "replaceExisting"
	>
> & {
	enabled?: boolean;
	lastSyncedAt?: string;
	lastError?: string;
	lastResult?: JsonObject;
};
type ResolvedOpenApiImportInput = OpenApiImportInput & {
	baseUrl: string;
	specUrl?: string;
};

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const TEDIX_INJECTED_ARGUMENTS_EXTENSION = "x-tedix-injected-arguments";
const OPENAPI_CONFIG_OVERLAY_KEYS = ["layoutId", "layoutSpec"] as const;
const DEFAULT_TABLE_COLUMN_LIMIT = 7;
const MAX_OPENAPI_SPEC_BYTES = 5 * 1024 * 1024;
type OpenApiWidgetDefaults = NonNullable<OpenApiImportInput["widgetDefaults"]>;

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as JsonObject;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return stableStringify(a ?? null) === stableStringify(b ?? null);
}

function mergeOpenApiConfigOverlay(
	generatedConfig: ToolConfig & JsonObject,
	existingConfig: unknown,
	options: { preserveWidgetProjection?: boolean } = {
		preserveWidgetProjection: true,
	},
): ToolConfig & JsonObject {
	if (!isRecord(existingConfig)) return generatedConfig;

	if (options.preserveWidgetProjection === false) return generatedConfig;

	const overlay = Object.fromEntries(
		OPENAPI_CONFIG_OVERLAY_KEYS.flatMap((key) =>
			existingConfig[key] === undefined ? [] : [[key, existingConfig[key]]],
		),
	);

	return {
		...generatedConfig,
		...overlay,
	};
}

function firstArrayProjection(
	schema: ToolJsonSchema | null | undefined,
): { key: string; dataPath: string; itemSchema: JsonObject } | null {
	if (isRecord(schema) && schemaTypeIncludes(schema, "array")) {
		const itemSchema = isRecord(schema.items) ? schema.items : null;
		if (!itemSchema) return null;
		return { key: "data", dataPath: "/", itemSchema };
	}

	const properties = isRecord(schema?.properties) ? schema.properties : null;
	if (!properties) return null;

	for (const [key, property] of Object.entries(properties)) {
		if (!isRecord(property)) continue;
		if (!schemaTypeIncludes(property, "array")) continue;
		const itemSchema = isRecord(property.items) ? property.items : null;
		if (!itemSchema) continue;
		return { key, dataPath: `/${key}`, itemSchema };
	}

	return null;
}

function schemaTypeIncludes(schema: JsonObject, typeName: string): boolean {
	const type = schema.type;
	return Array.isArray(type) ? type.includes(typeName) : type === typeName;
}

function scalarColumnFormat(
	field: string,
	schema: JsonObject,
): "text" | "number" | "date" | "badge" {
	const format = typeof schema.format === "string" ? schema.format : "";
	const normalized = field.toLowerCase();
	if (normalized === "status" || normalized.endsWith("status")) return "badge";
	if (
		format === "date" ||
		format === "date-time" ||
		normalized.endsWith("at") ||
		normalized.endsWith("date") ||
		normalized.endsWith("time")
	) {
		return "date";
	}
	if (
		schemaTypeIncludes(schema, "integer") ||
		schemaTypeIncludes(schema, "number")
	) {
		return "number";
	}
	return "text";
}

function columnPriority(field: string): number {
	const normalized = field.toLowerCase();
	const priorities = [
		"id",
		"name",
		"title",
		"status",
		"state",
		"type",
		"market",
		"createdat",
		"created_at",
		"updatedat",
		"updated_at",
	];
	const index = priorities.indexOf(normalized);
	return index === -1 ? priorities.length : index;
}

function isScalarSchema(schema: JsonObject): boolean {
	if (composedBranches(schema).some((branch) => isScalarSchema(branch))) {
		return true;
	}
	return ["string", "number", "integer", "boolean"].some((type) =>
		schemaTypeIncludes(schema, type),
	);
}

function composedBranches(schema: JsonObject): JsonObject[] {
	return ["allOf", "anyOf", "oneOf"].flatMap((key) => {
		const value = schema[key];
		if (!Array.isArray(value)) return [];
		return value.filter(isRecord);
	});
}

function objectProperties(schema: JsonObject): Record<string, unknown> {
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const merged = { ...properties };

	for (const branch of composedBranches(schema)) {
		Object.assign(merged, objectProperties(branch));
	}

	return merged;
}

function defaultTableColumns(
	itemSchema: JsonObject,
	limit = DEFAULT_TABLE_COLUMN_LIMIT,
): JsonObject[] {
	const properties = objectProperties(itemSchema);
	return Object.entries(properties)
		.filter(([, schema]) => isRecord(schema) && isScalarSchema(schema))
		.sort(([left], [right]) => columnPriority(left) - columnPriority(right))
		.slice(0, limit)
		.map(([field, schema]) => ({
			field,
			header: titleFromName(field),
			format: scalarColumnFormat(field, schema as JsonObject),
			sortable: true,
		}));
}

function normalizeWidgetDataPath(
	path: string | undefined,
	fallbackKey: string,
): string {
	if (!path) return `/${fallbackKey}`;
	if (path === "/") return "/";
	return path.startsWith("/") ? path : `/${path}`;
}

function widgetColumns(
	itemSchema: JsonObject,
	defaults: OpenApiWidgetDefaults | undefined,
): JsonObject[] {
	if (defaults?.columns?.length) {
		return defaults.columns.map(
			(column) =>
				withoutUndefined({
					field: column.field,
					header: column.header ?? titleFromName(column.field),
					format: column.format ?? "text",
					align: column.align,
					sortable: column.sortable ?? true,
					width: column.width,
				}) as JsonObject,
		);
	}

	return defaultTableColumns(
		itemSchema,
		defaults?.columnLimit ?? DEFAULT_TABLE_COLUMN_LIMIT,
	);
}

function defaultOpenApiWidgetForOutput(
	toolId: string,
	outputSchema: ToolJsonSchema | null | undefined,
	defaults?: OpenApiWidgetDefaults,
): { widgetKey: "render"; config: JsonObject } | null {
	if (defaults?.enabled === false) return null;

	const arrayProjection = firstArrayProjection(outputSchema);
	if (!arrayProjection) return null;

	const columns = widgetColumns(arrayProjection.itemSchema, defaults);
	if (columns.length === 0) return null;

	const dataPath = normalizeWidgetDataPath(
		defaults?.dataPath,
		arrayProjection.dataPath === "/" ? "" : arrayProjection.key,
	);
	const showTitle = defaults?.showTitle !== false;
	const title =
		defaults?.title ??
		titleFromName(
			dataPath === "/"
				? arrayProjection.key
				: (dataPath.split("/").at(-1) ?? arrayProjection.key),
		);
	const layoutSpec = {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 4 },
				children: showTitle ? ["title", "table"] : ["table"],
			},
			...(showTitle
				? {
						title: {
							type: "Text",
							props: {
								text: title,
								variant: "default",
							},
							children: [],
						},
					}
				: {}),
			table: {
				type: "DataTable",
				props: {
					columns,
					compact: defaults?.compact ?? true,
					data: { $state: dataPath },
					pageSize: defaults?.pageSize ?? 10,
					striped: defaults?.striped ?? true,
				},
				children: [],
			},
		},
	};

	return {
		widgetKey: "render",
		config: {
			layoutId: defaults?.layoutId ?? arrayProjection.key ?? toolId,
			layoutSpec,
		},
	};
}

function widgetDefaultsForTool(
	input: ResolvedOpenApiImportInput,
	toolId: string,
	operationId: string | null,
): OpenApiWidgetDefaults | undefined {
	return (
		input.widgetOverrides?.[toolId] ??
		(operationId ? input.widgetOverrides?.[operationId] : undefined) ??
		input.widgetDefaults
	);
}

function annotationsForMethod(method: string): {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
} {
	const normalizedMethod = method.toUpperCase();
	return {
		readOnlyHint: normalizedMethod === "GET",
		destructiveHint: normalizedMethod === "DELETE",
		idempotentHint: ["GET", "PUT", "DELETE"].includes(normalizedMethod),
		openWorldHint: true,
	};
}

function writeCapabilityForMethod(
	method: string,
): "read" | "write" | "destructive" {
	const normalizedMethod = method.toUpperCase();
	if (normalizedMethod === "GET") return "read";
	if (normalizedMethod === "DELETE") return "destructive";
	return "write";
}

async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(stableStringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function resolveRef(spec: JsonObject, ref: string): unknown {
	if (!ref.startsWith("#/")) return {};
	let current: unknown = spec;
	for (const part of ref.slice(2).split("/")) {
		if (!isRecord(current)) return {};
		current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")];
	}
	return current;
}

function recursiveRefPlaceholder(ref: string): JsonObject {
	return {
		type: "object",
		additionalProperties: true,
		description: `Recursive OpenAPI schema reference ${ref} omitted to keep the MCP tool schema finite.`,
	};
}

function derefSchema(
	spec: JsonObject,
	schema: unknown,
	refStack = new Set<string>(),
): unknown {
	if (!isRecord(schema)) return schema;
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		if (refStack.has(ref)) {
			return recursiveRefPlaceholder(ref);
		}
		const nextStack = new Set(refStack);
		nextStack.add(ref);
		return derefSchema(spec, resolveRef(spec, ref), nextStack);
	}
	const out: JsonObject = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref") continue;
		if (Array.isArray(value)) {
			out[key] = value.map((item) => derefSchema(spec, item, refStack));
		} else if (isRecord(value)) {
			out[key] = derefSchema(spec, value, refStack);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function withoutUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutUndefined);
	if (!isRecord(value)) return value;
	const out: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		if (child !== undefined) out[key] = withoutUndefined(child);
	}
	return out;
}

function withNullableType(schema: JsonObject): JsonObject {
	if (schema.nullable !== true) return schema;
	const out = { ...schema };
	delete out.nullable;
	const type = out.type;
	if (typeof type === "string") {
		out.type = type === "null" ? "null" : [type, "null"];
	} else if (Array.isArray(type)) {
		out.type = type.includes("null") ? type : [...type, "null"];
	} else if (Array.isArray(out.anyOf)) {
		const hasNull = out.anyOf.some(
			(entry) => isRecord(entry) && entry.type === "null",
		);
		if (!hasNull) out.anyOf = [...out.anyOf, { type: "null" }];
	} else if (Array.isArray(out.oneOf)) {
		const hasNull = out.oneOf.some(
			(entry) => isRecord(entry) && entry.type === "null",
		);
		if (!hasNull) out.oneOf = [...out.oneOf, { type: "null" }];
	} else {
		out.anyOf = [{ ...out }, { type: "null" }];
	}
	return out;
}

function normalizeOpenApiSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(normalizeOpenApiSchema);
	if (!isRecord(schema)) return schema;

	let out: JsonObject = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "nullable") continue;
		if (key === "example") {
			if (schema.examples === undefined) out.examples = [value];
			continue;
		}
		out[key] = normalizeOpenApiSchema(value);
	}

	out = withNullableType(out);
	if (Array.isArray(out.enum) && out.enum.includes(null)) {
		const type = out.type;
		if (typeof type === "string" && type !== "null") {
			out.type = [type, "null"];
		} else if (Array.isArray(type) && !type.includes("null")) {
			out.type = [...type, "null"];
		}
	}
	return out;
}

function jsonSchemaObject(schema: unknown): JsonObject {
	const derefed = isRecord(schema)
		? (normalizeOpenApiSchema(schema) as JsonObject)
		: {};
	return derefed;
}

function addNullToSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;
	const out = { ...schema };
	if (Array.isArray(out.enum) && !out.enum.includes(null)) {
		out.enum = [...out.enum, null];
	}

	const type = out.type;
	if (typeof type === "string") {
		out.type = type === "null" ? "null" : [type, "null"];
		return out;
	}
	if (Array.isArray(type)) {
		out.type = type.includes("null") ? type : [...type, "null"];
		return out;
	}
	if (Array.isArray(out.anyOf)) {
		const hasNull = out.anyOf.some(
			(entry) => isRecord(entry) && entry.type === "null",
		);
		out.anyOf = hasNull ? out.anyOf : [...out.anyOf, { type: "null" }];
		return out;
	}
	if (Array.isArray(out.oneOf)) {
		const hasNull = out.oneOf.some(
			(entry) => isRecord(entry) && entry.type === "null",
		);
		out.oneOf = hasNull ? out.oneOf : [...out.oneOf, { type: "null" }];
		return out;
	}

	out.anyOf = [{ ...out }, { type: "null" }];
	return out;
}

function allowNullForOptionalOutputProperties(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(allowNullForOptionalOutputProperties);
	}
	if (!isRecord(schema)) return schema;

	const out: JsonObject = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && isRecord(value)) {
			const required = new Set(
				Array.isArray(schema.required)
					? schema.required.filter(
							(field): field is string => typeof field === "string",
						)
					: [],
			);
			const properties: JsonObject = {};
			for (const [propertyName, propertySchema] of Object.entries(value)) {
				const normalizedProperty =
					allowNullForOptionalOutputProperties(propertySchema);
				properties[propertyName] = required.has(propertyName)
					? normalizedProperty
					: addNullToSchema(normalizedProperty);
			}
			out.properties = properties;
			continue;
		}
		out[key] = allowNullForOptionalOutputProperties(value);
	}
	return out;
}

const OUTPUT_ONLY_CONSTRAINT_KEYS = new Set([
	"const",
	"enum",
	"exclusiveMaximum",
	"exclusiveMinimum",
	"format",
	"maxItems",
	"maxLength",
	"maxProperties",
	"maximum",
	"minItems",
	"minLength",
	"minProperties",
	"minimum",
	"multipleOf",
	"pattern",
	"required",
	"uniqueItems",
]);

const EXTERNAL_INPUT_CONSTRAINT_KEYS = new Set(["const", "enum"]);

function loosenExternalInputSchema(
	schema: unknown,
	options: { stripBinaryFormat?: boolean } = {},
): unknown {
	if (Array.isArray(schema)) {
		return schema.map((item) => loosenExternalInputSchema(item, options));
	}
	if (!isRecord(schema)) return schema;

	const out: JsonObject = {};
	for (const [key, value] of Object.entries(schema)) {
		if (EXTERNAL_INPUT_CONSTRAINT_KEYS.has(key)) continue;
		if (
			options.stripBinaryFormat === true &&
			key === "format" &&
			value === "binary" &&
			(schemaTypeIncludes(schema, "string") || schema.type === undefined)
		) {
			continue;
		}
		out[key] = loosenExternalInputSchema(value, options);
	}
	return out;
}

function loosenExternalOutputType(type: unknown): unknown {
	const values =
		typeof type === "string" ? [type] : Array.isArray(type) ? [...type] : null;
	if (!values) return type;

	const widened = new Set(values);
	if (
		widened.has("integer") ||
		widened.has("number") ||
		widened.has("boolean")
	) {
		widened.add("string");
	}
	return typeof type === "string" && widened.size === 1 ? type : [...widened];
}

function loosenExternalOutputSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(loosenExternalOutputSchema);
	if (!isRecord(schema)) return schema;

	const out: JsonObject = {};
	for (const [key, value] of Object.entries(schema)) {
		if (OUTPUT_ONLY_CONSTRAINT_KEYS.has(key)) continue;
		if (key === "oneOf") {
			out.anyOf = loosenExternalOutputSchema(value);
			continue;
		}
		out[key] =
			key === "type"
				? loosenExternalOutputType(value)
				: loosenExternalOutputSchema(value);
	}

	// External responses may contain OData annotations and derived properties.
	// SDK-oriented specs often type additionalProperties as object, including on
	// allOf base classes: that wrongly rejects sibling scalar fields. Keep known
	// property types, but allow extension data on resource objects. Typed maps
	// without a property map retain their value schema.
	if (
		isRecord(out.properties) ||
		(out.type === "object" && out.additionalProperties === undefined)
	) {
		out.additionalProperties = true;
	}

	return out;
}

function structuredOutputSchema(schema: unknown): ToolJsonSchema | null {
	const raw = loosenExternalOutputSchema(
		allowNullForOptionalOutputProperties(jsonSchemaObject(schema)),
	) as JsonObject;
	return ToolJsonSchemaSchema.parse(raw);
}

function normalizeToolId(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase()
		.slice(0, 128);
}

function pathToToolName(method: string, path: string): string {
	const cleanPath = path
		.replace(/[{}]/g, "")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
	const base = `${method.toLowerCase()}_${cleanPath || "root"}`;
	return normalizeToolId(base);
}

function toEndpoint(path: string): string {
	return path.replace(/^\//, "").replace(/\{([a-zA-Z_]\w*)\}/g, ":$1");
}

function endpointKey(method: string, endpoint: string): string {
	return `${method.toUpperCase()} ${endpoint.replace(/^\/+/, "")}`;
}

function normalizePathPrefix(prefix: string): string {
	const trimmed = prefix.trim();
	if (!trimmed) return "/";
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function matchesPathPrefix(path: string, prefix: string): boolean {
	const normalized = normalizePathPrefix(prefix).replace(/\/+$/, "");
	if (!normalized || normalized === "/") return true;
	return path === normalized || path.startsWith(`${normalized}/`);
}

function stripPathPrefix(path: string, prefix: string): string {
	const normalized = normalizePathPrefix(prefix).replace(/\/+$/, "");
	if (!normalized || normalized === "/") return path;
	if (path === normalized) return "/";
	if (!path.startsWith(`${normalized}/`)) return path;
	const stripped = path.slice(normalized.length);
	return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function applyStripPathPrefixes(path: string, prefixes: string[]): string {
	const sortedPrefixes = [...prefixes].sort(
		(a, b) => normalizePathPrefix(b).length - normalizePathPrefix(a).length,
	);
	for (const prefix of sortedPrefixes) {
		if (matchesPathPrefix(path, prefix)) {
			return stripPathPrefix(path, prefix);
		}
	}
	return path;
}

function pathParameterNames(path: string): Set<string> {
	return new Set(
		[...path.matchAll(/\{([^{}]+)\}/g)].map((match) =>
			String(match[1]).toLowerCase(),
		),
	);
}

function removedPathParameterNames(sourcePath: string, generatedPath: string) {
	const generated = pathParameterNames(generatedPath);
	return new Set(
		[...pathParameterNames(sourcePath)].filter((name) => !generated.has(name)),
	);
}

function generatedOpenApiPath(
	path: string,
	stripPathPrefixes: string[],
	pathReplacements: Record<string, string> | undefined,
) {
	return (
		pathReplacements?.[path] ?? applyStripPathPrefixes(path, stripPathPrefixes)
	);
}

function mergeOpenApiSpecs(specs: JsonObject[]): JsonObject {
	const [first, ...rest] = specs;
	if (!first) throw new Error("At least one OpenAPI spec is required");

	const merged: JsonObject = { ...first };
	for (const spec of rest) {
		merged.paths = {
			...(isRecord(merged.paths) ? merged.paths : {}),
			...(isRecord(spec.paths) ? spec.paths : {}),
		};

		const existingComponents = isRecord(merged.components)
			? merged.components
			: {};
		const supplementalComponents = isRecord(spec.components)
			? spec.components
			: {};
		const componentSections = new Set([
			...Object.keys(existingComponents),
			...Object.keys(supplementalComponents),
		]);
		merged.components = Object.fromEntries(
			[...componentSections].map((section) => {
				const existing = existingComponents[section];
				const supplemental = supplementalComponents[section];
				return [
					section,
					isRecord(existing) || isRecord(supplemental)
						? {
								...(isRecord(existing) ? existing : {}),
								...(isRecord(supplemental) ? supplemental : {}),
							}
						: supplemental,
				];
			}),
		);
	}
	return merged;
}

function operationRequiresAuth(
	spec: JsonObject,
	operation: JsonObject,
	defaultRequiresAuth = false,
): boolean {
	const operationDefinesSecurity = Object.hasOwn(operation, "security");
	const security = operationDefinesSecurity
		? operation.security
		: spec.security;
	if (!Array.isArray(security) || security.length === 0) {
		return operationDefinesSecurity ? false : defaultRequiresAuth;
	}

	const requirements = security.filter(isRecord);
	if (requirements.length === 0) return false;

	// OpenAPI treats an empty security requirement object as an authless
	// alternative. If any alternative is authless, the generated MCP tool should
	// remain public and skip provider-token injection.
	return requirements.every(
		(requirement) => Object.keys(requirement).length > 0,
	);
}

function titleFromName(name: string): string {
	return name.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function operationDescription(operation: JsonObject): string | null {
	return (
		(typeof operation.description === "string" && operation.description) ||
		(typeof operation.summary === "string" && operation.summary) ||
		null
	);
}

function collectParameters(
	spec: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
) {
	const rawParams = [
		...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
		...(Array.isArray(operation.parameters) ? operation.parameters : []),
	];
	return rawParams
		.map((param) => derefSchema(spec, param))
		.filter(isRecord)
		.filter((param) => typeof param.name === "string");
}

function parameterNamesByLocation(
	spec: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
	location: "header" | "query",
	options: { omitParameterNames?: ReadonlySet<string> } = {},
): string[] {
	const omit = options.omitParameterNames ?? new Set<string>();
	return collectParameters(spec, pathItem, operation)
		.filter((param) => param.in === location)
		.map((param) => String(param.name))
		.filter((name) => !omit.has(name.toLowerCase()));
}

function runtimeOnlyParameterNames(operation: JsonObject): string[] {
	const injectedArguments = operation[TEDIX_INJECTED_ARGUMENTS_EXTENSION];
	if (!isRecord(injectedArguments)) return [];
	return Object.keys(injectedArguments);
}

function queryArrayFormats(
	spec: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
): NonNullable<ToolConfig["queryArrayFormats"]> {
	const formats: NonNullable<ToolConfig["queryArrayFormats"]> = {};
	for (const param of collectParameters(spec, pathItem, operation)) {
		if (
			param.in !== "query" ||
			!isRecord(param.schema) ||
			param.schema.type !== "array"
		)
			continue;
		const name = String(param.name);
		// OpenAPI defaults query parameters to form + explode:true.
		if ((param.style ?? "form") === "form" && param.explode === false)
			formats[name] = "comma";
		else if (param.style === "spaceDelimited") formats[name] = "space";
		else if (param.style === "pipeDelimited") formats[name] = "pipe";
	}
	return formats;
}

const CREDENTIAL_HEADER_NAMES = new Set([
	"authorization",
	"api-key",
	"apikey",
	"x-api-key",
	"x-auth-token",
	"x-access-token",
	"x-nosana-api",
]);

function isCredentialLikeHeaderParameter(
	param: JsonObject,
	injectedHeaderName: string,
): boolean {
	if (param.in !== "header") return false;
	const name = String(param.name).toLowerCase();
	if (name === injectedHeaderName) return true;
	if (CREDENTIAL_HEADER_NAMES.has(name)) return true;

	const description =
		typeof param.description === "string"
			? param.description.toLowerCase()
			: "";
	return (
		description.includes("api key") ||
		description.includes("apikey") ||
		description.includes("authentication token") ||
		description.includes("authorization token") ||
		description.includes("bearer token") ||
		description.includes("wallet authentication") ||
		description.includes("wallet-signed message")
	);
}

function providerManagedCredentialHeaderNames(
	spec: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
	authHeader: string,
): ReadonlySet<string> {
	const injectedHeaderName = authHeader.toLowerCase();
	const omitted = new Set<string>([injectedHeaderName]);
	for (const param of collectParameters(spec, pathItem, operation)) {
		if (isCredentialLikeHeaderParameter(param, injectedHeaderName)) {
			omitted.add(String(param.name).toLowerCase());
		}
	}
	return omitted;
}

function normalizeRequestContentType(contentType: string): string {
	const lower = contentType.toLowerCase();
	if (lower === "form-data") return "multipart/form-data";
	if (lower.includes(";")) return lower.split(";")[0]!.trim();
	return lower;
}

function isJsonContentType(contentType: string | null | undefined): boolean {
	if (!contentType) return false;
	const normalized = normalizeRequestContentType(contentType);
	return (
		normalized === "application/json" ||
		normalized.endsWith("+json") ||
		normalized.includes("/json")
	);
}

function toolRequestContentType(
	contentType: string | null | undefined,
): ToolConfig["requestContentType"] | null {
	if (!contentType) return null;
	const normalized = normalizeRequestContentType(contentType);
	if (isJsonContentType(normalized)) {
		return normalized as ToolConfig["requestContentType"];
	}
	switch (normalized) {
		case "application/x-www-form-urlencoded":
		case "multipart/form-data":
		case "text/markdown":
		case "text/plain":
			return normalized;
		default:
			return null;
	}
}

function firstContentEntry(
	spec: JsonObject,
	content: unknown,
	preferredTypes: string[],
): { contentType: string; schema: unknown } | null {
	if (!isRecord(content)) return null;
	for (const type of preferredTypes) {
		const entry = content[type];
		if (isRecord(entry)) {
			return {
				contentType: normalizeRequestContentType(type),
				schema: derefSchema(spec, entry.schema),
			};
		}
	}
	const first = Object.entries(content).find(([, value]) => isRecord(value));
	if (!first) return null;
	return {
		contentType: normalizeRequestContentType(first[0]),
		schema: derefSchema(spec, (first[1] as JsonObject).schema),
	};
}

function requestBodyInfo(
	spec: JsonObject,
	operation: JsonObject,
): { contentType: string; schema: unknown; required: boolean } | null {
	const requestBody = derefSchema(spec, operation.requestBody);
	if (!isRecord(requestBody)) return null;
	const entry = firstContentEntry(spec, requestBody.content, [
		"application/json",
		"text/markdown",
		"text/plain",
		"application/x-www-form-urlencoded",
		"multipart/form-data",
		"form-data",
	]);
	if (!entry) return null;
	return { ...entry, required: requestBody.required === true };
}

function responseInfo(
	spec: JsonObject,
	operation: JsonObject,
): { contentType: string | null; schema: unknown } | null {
	const responses = operation.responses;
	if (!isRecord(responses)) return null;
	const statusKey =
		Object.keys(responses).find((key) => key.startsWith("2")) ?? "default";
	const response = derefSchema(spec, responses[statusKey]);
	if (!isRecord(response)) return null;
	const entry = firstContentEntry(spec, response.content, ["application/json"]);
	return entry ?? { contentType: null, schema: null };
}

function responseSchema(spec: JsonObject, operation: JsonObject): unknown {
	return responseInfo(spec, operation)?.schema ?? null;
}

function binaryFileInputSchema(description: unknown): JsonObject {
	const baseDescription =
		typeof description === "string" && description.trim()
			? `${description.trim()} Supply a data URL, raw base64 string, or an object with {content|data|base64, filename, mimeType}.`
			: "File bytes as a data URL, raw base64 string, or an object with {content|data|base64, filename, mimeType}.";
	return {
		anyOf: [
			{
				type: "string",
				format: "binary",
				description: baseDescription,
			},
			{
				type: "object",
				description: baseDescription,
				properties: {
					content: { type: "string", description: "Base64 bytes or data URL." },
					data: { type: "string", description: "Base64 bytes or data URL." },
					base64: { type: "string", description: "Base64 bytes." },
					filename: { type: "string" },
					name: { type: "string" },
					mimeType: { type: "string" },
					type: { type: "string" },
				},
				additionalProperties: true,
			},
		],
	};
}

function isBinarySchema(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (
		schema.format === "binary" &&
		(schemaTypeIncludes(schema, "string") || schema.type === undefined)
	) {
		return true;
	}
	return composedBranches(schema).some(isBinarySchema);
}

function normalizeBinaryInputSchemas(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(normalizeBinaryInputSchemas);
	if (!isRecord(schema)) return schema;
	if (isBinarySchema(schema)) {
		return binaryFileInputSchema(schema.description);
	}
	const out: JsonObject = {};
	for (const [key, value] of Object.entries(schema)) {
		out[key] = normalizeBinaryInputSchemas(value);
	}
	return out;
}

function collectTopLevelFileParams(schema: unknown): string[] {
	if (!isRecord(schema)) return [];
	if (isRecord(schema.properties)) {
		return Object.entries(schema.properties)
			.filter(([, property]) => isBinarySchema(property))
			.map(([name]) => name);
	}
	return isBinarySchema(schema) ? ["body"] : [];
}

function requestBodyParamForSchema(schema: unknown): string | null {
	if (!schema) return null;
	const normalized = normalizeOpenApiSchema(schema);
	if (isRecord(normalized) && isRecord(normalized.properties)) return null;
	return "body";
}

function binaryResponseOutputSchema(): ToolJsonSchema {
	return ToolJsonSchemaSchema.parse({
		type: "object",
		properties: {
			filename: { type: ["string", "null"] },
			mimeType: { type: "string" },
			base64encoded: { type: "boolean" },
			content: { type: "string" },
		},
		required: ["mimeType", "base64encoded", "content"],
		additionalProperties: true,
	});
}

function inputSchemaForOperation(
	spec: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
	options: { omitParameterNames?: ReadonlySet<string> } = {},
): ToolInputJsonSchema {
	const properties: JsonObject = {};
	const required = new Set<string>();
	const omitParameterNames = options.omitParameterNames ?? new Set<string>();

	for (const param of collectParameters(spec, pathItem, operation)) {
		const name = String(param.name);
		if (omitParameterNames.has(name.toLowerCase())) continue;
		properties[name] = loosenExternalInputSchema(
			normalizeOpenApiSchema(derefSchema(spec, param.schema)),
			{ stripBinaryFormat: true },
		) ?? {
			type: "string",
		};
		if (param.required === true || param.in === "path") required.add(name);
	}

	const bodyInfo = requestBodyInfo(spec, operation);
	const rawBodySchema = normalizeOpenApiSchema(bodyInfo?.schema);
	const contentType = toolRequestContentType(bodyInfo?.contentType);
	const bodySchema = loosenExternalInputSchema(
		contentType === "multipart/form-data"
			? normalizeBinaryInputSchemas(rawBodySchema)
			: rawBodySchema,
		{ stripBinaryFormat: contentType !== "multipart/form-data" },
	);
	const bodyRequired = bodyInfo?.required === true;
	if (isRecord(bodySchema) && isRecord(bodySchema.properties)) {
		Object.assign(properties, bodySchema.properties);
		for (const field of Array.isArray(bodySchema.required)
			? bodySchema.required
			: []) {
			if (typeof field === "string") required.add(field);
		}
	} else if (bodySchema) {
		properties.body = bodySchema;
		if (bodyRequired) required.add("body");
	}

	const injectedArguments = operation[TEDIX_INJECTED_ARGUMENTS_EXTENSION];
	if (injectedArguments !== undefined && !isRecord(injectedArguments)) {
		throw new Error(
			`${TEDIX_INJECTED_ARGUMENTS_EXTENSION} must be an object of JSON Schemas`,
		);
	}
	for (const [name, schema] of Object.entries(injectedArguments ?? {})) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
			throw new Error(
				`${TEDIX_INJECTED_ARGUMENTS_EXTENSION} contains invalid argument name ${name}`,
			);
		}
		if (Object.hasOwn(properties, name)) {
			throw new Error(
				`${TEDIX_INJECTED_ARGUMENTS_EXTENSION} collides with transport parameter ${name}`,
			);
		}
		properties[name] = loosenExternalInputSchema(
			normalizeOpenApiSchema(derefSchema(spec, schema)),
			{ stripBinaryFormat: true },
		) ?? { type: "string" };
	}

	if (Object.keys(properties).length === 0) return EMPTY_TOOL_INPUT_SCHEMA;
	const propertyNames = new Set(Object.keys(properties));
	const requiredFields = [...required].filter((field) =>
		propertyNames.has(field),
	);
	return ToolInputJsonSchemaSchema.parse({
		type: "object",
		properties,
		required: requiredFields,
		additionalProperties: false,
	});
}

function operations(spec: JsonObject) {
	const paths = isRecord(spec.paths) ? spec.paths : {};
	const result: Array<{
		method: HttpMethod;
		path: string;
		pathItem: JsonObject;
		operation: JsonObject;
	}> = [];

	for (const [path, pathItem] of Object.entries(paths)) {
		if (!isRecord(pathItem)) continue;
		for (const [method, operation] of Object.entries(pathItem)) {
			if (!METHODS.has(method) || !isRecord(operation)) continue;
			result.push({
				method: method.toUpperCase() as HttpMethod,
				path,
				pathItem,
				operation,
			});
		}
	}
	return result;
}

async function parseOpenApiSpecResponse(response: Response): Promise<unknown> {
	const declaredBytes = Number(response.headers.get("content-length"));
	if (
		Number.isFinite(declaredBytes) &&
		declaredBytes > MAX_OPENAPI_SPEC_BYTES
	) {
		throw new Error(
			`OpenAPI spec is ${declaredBytes} bytes; maximum is ${MAX_OPENAPI_SPEC_BYTES}. Publish a service-specific or pre-filtered spec before enabling scheduled sync.`,
		);
	}

	const reader = response.body?.getReader();
	if (!reader) throw new Error("OpenAPI spec response has no body");
	const decoder = new TextDecoder();
	let receivedBytes = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		receivedBytes += value.byteLength;
		if (receivedBytes > MAX_OPENAPI_SPEC_BYTES) {
			await reader.cancel();
			throw new Error(
				`OpenAPI spec exceeded ${MAX_OPENAPI_SPEC_BYTES} bytes while downloading. Publish a service-specific or pre-filtered spec before enabling scheduled sync.`,
			);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	const contentType = response.headers.get("content-type") ?? "";
	if (
		contentType.includes("json") ||
		response.url.endsWith(".json") ||
		text.trimStart().startsWith("{")
	) {
		return JSON.parse(text);
	}
	return parseYaml(text);
}

function readStoredSyncConfig(metadata: unknown): StoredOpenApiSyncConfig {
	if (!isRecord(metadata)) return {};
	const mcpConfig = isRecord(metadata.mcpConfig) ? metadata.mcpConfig : {};
	return isRecord(mcpConfig.openApiSync) ? mcpConfig.openApiSync : {};
}

/** `undefined` keeps the stored allowlist; an explicit `null` removes it. */
function clearableAllowlist(
	supplied: readonly string[] | null | undefined,
	stored: readonly string[] | null | undefined,
): string[] | undefined {
	if (supplied === null) return undefined;
	if (supplied) return [...supplied];
	return stored ? [...stored] : undefined;
}

function mergeStoredOpenApiImportInput(
	input: OpenApiImportInput,
	stored: StoredOpenApiSyncConfig,
): OpenApiImportInput {
	const sourceExplicitlyReplaced =
		input.spec !== undefined || input.specUrl !== undefined;
	return {
		...stored,
		...input,
		spec: sourceExplicitlyReplaced ? input.spec : stored.spec,
		specUrl: sourceExplicitlyReplaced ? input.specUrl : stored.specUrl,
		supplementalSpecUrls: sourceExplicitlyReplaced
			? input.supplementalSpecUrls
			: (input.supplementalSpecUrls ?? stored.supplementalSpecUrls),
		baseUrl: input.baseUrl ?? stored.baseUrl,
		namespace: input.namespace ?? stored.namespace,
		connectionProviderId:
			input.connectionProviderId ?? stored.connectionProviderId,
		connectionScope: input.connectionScope ?? stored.connectionScope,
		authScopes: input.authScopes ?? stored.authScopes,
		authHeader: input.authHeader ?? stored.authHeader,
		authTemplate: input.authTemplate ?? stored.authTemplate,
		authEncoding: input.authEncoding ?? stored.authEncoding,
		staticHeaders: input.staticHeaders ?? stored.staticHeaders,
		// An allowlist is cleared by passing null, kept by omitting it. Without an
		// explicit clear these were impossible to undo: the resolved value is what
		// gets persisted, so a filter supplied once was written back on every later
		// sync and quietly excluded every endpoint added afterwards.
		includeOperationIds: clearableAllowlist(
			input.includeOperationIds,
			stored.includeOperationIds,
		),
		includePathPrefixes: clearableAllowlist(
			input.includePathPrefixes,
			stored.includePathPrefixes,
		),
		excludePathPrefixes:
			input.excludePathPrefixes ?? stored.excludePathPrefixes,
		stripPathPrefixes: input.stripPathPrefixes ?? stored.stripPathPrefixes,
		pathReplacements: input.pathReplacements ?? stored.pathReplacements,
		widgetDefaults: input.widgetDefaults ?? stored.widgetDefaults,
		widgetOverrides: input.widgetOverrides ?? stored.widgetOverrides,
		replaceExisting: input.replaceExisting ?? true,
	};
}

async function resolveImportInput(
	db: DbClient,
	input: OpenApiImportInput,
): Promise<{
	appMetadata: JsonObject;
	resolved: ResolvedOpenApiImportInput;
}> {
	const app = await getAppById(db, input.appId);
	if (!app) throw new Error(`App not found: ${input.appId}`);
	if (app.slug === "tedix") {
		throw new Error(
			"OpenAPI imports must target an external/customer app, not the Tedix platform admin app.",
		);
	}

	const appMetadata = isRecord(app.metadata) ? app.metadata : {};
	const stored = readStoredSyncConfig(appMetadata);
	const resolved = mergeStoredOpenApiImportInput(input, stored);

	if (!resolved.specUrl && !resolved.spec) {
		throw new Error(
			"Either specUrl/spec input or metadata.mcpConfig.openApiSync.specUrl must be provided",
		);
	}
	if (!resolved.baseUrl) {
		throw new Error(
			"baseUrl input or metadata.mcpConfig.openApiSync.baseUrl must be provided",
		);
	}

	return {
		appMetadata,
		resolved: resolved as ResolvedOpenApiImportInput,
	};
}

async function persistOpenApiSyncConfig(
	db: DbClient,
	input: ResolvedOpenApiImportInput,
	appMetadata: JsonObject,
	result: Omit<OpenApiImportResult, "items">,
): Promise<void> {
	await updateApp(db, input.appId, {
		metadata: buildOpenApiSyncMetadata(appMetadata, input, result),
	});
}

export function buildOpenApiSyncMetadata(
	appMetadata: JsonObject,
	input: ResolvedOpenApiImportInput,
	result: Omit<OpenApiImportResult, "items">,
	syncedAt = new Date().toISOString(),
): AppMetadata {
	const mcpConfig = isRecord(appMetadata.mcpConfig)
		? appMetadata.mcpConfig
		: {};
	const openApiSync: StoredOpenApiSyncConfig = {
		enabled: true,
		spec: input.spec,
		specUrl: input.specUrl,
		supplementalSpecUrls: input.supplementalSpecUrls,
		baseUrl: input.baseUrl,
		namespace: input.namespace,
		connectionProviderId: input.connectionProviderId,
		connectionScope: input.connectionScope ?? "tenant",
		authScopes: input.authScopes,
		authHeader: input.authHeader,
		authTemplate: input.authTemplate,
		authEncoding: input.authEncoding,
		staticHeaders: input.staticHeaders,
		includeOperationIds: input.includeOperationIds,
		includePathPrefixes: input.includePathPrefixes,
		excludePathPrefixes: input.excludePathPrefixes,
		stripPathPrefixes: input.stripPathPrefixes,
		pathReplacements: input.pathReplacements,
		widgetDefaults: input.widgetDefaults,
		widgetOverrides: input.widgetOverrides,
		replaceExisting: input.replaceExisting !== false,
		lastSyncedAt: syncedAt,
		lastError: undefined,
		lastResult: {
			totalOperations: result.totalOperations,
			planned: result.planned,
			created: result.created,
			updated: result.updated,
			deleted: result.deleted,
			inSync: result.inSync,
			failed: result.failed,
		},
	};
	const nextMcpConfig = { ...mcpConfig };

	// OpenAPI-generated external tools store their credential provider on each
	// generated tool config. A top-level connectionLabel is legacy metadata.
	delete nextMcpConfig.connectionLabel;

	return withoutUndefined({
		...appMetadata,
		mcpConfig: {
			...nextMcpConfig,
			openApiSync,
		},
	}) as AppMetadata;
}

/** @internal */
export const openApiToolImportTestInternals = {
	TEDIX_INJECTED_ARGUMENTS_EXTENSION,
	mergeStoredOpenApiImportInput,
	mergeOpenApiSpecs,
	generatedOpenApiPath,
	annotationsForMethod,
	writeCapabilityForMethod,
	allowNullForOptionalOutputProperties,
	derefSchema,
	endpointKey,
	applyStripPathPrefixes,
	removedPathParameterNames,
	parseOpenApiSpecResponse,
	MAX_OPENAPI_SPEC_BYTES,
	inputSchemaForOperation,
	loosenExternalInputSchema,
	matchesPathPrefix,
	operationRequiresAuth,
	parameterNamesByLocation,
	queryArrayFormats,
	runtimeOnlyParameterNames,
	providerManagedCredentialHeaderNames,
	toolRequestContentType,
	defaultOpenApiWidgetForOutput,
	mergeOpenApiConfigOverlay,
	widgetDefaultsForTool,
	collectTopLevelFileParams,
	requestBodyParamForSchema,
	requestBodyInfo,
	responseSchema,
	responseInfo,
	structuredOutputSchema,
};

export async function executeOpenApiToolImport(
	db: DbClient,
	input: OpenApiImportInput,
): Promise<OpenApiImportResult> {
	const { appMetadata, resolved } = await resolveImportInput(db, input);

	let spec: unknown = resolved.spec;
	if (!spec && resolved.specUrl) {
		const specUrls = [
			resolved.specUrl,
			...(resolved.supplementalSpecUrls ?? []),
		];
		const parsedSpecs: JsonObject[] = [];
		for (const specUrl of specUrls) {
			const response = await fetch(specUrl);
			if (!response.ok) {
				throw new Error(
					`OpenAPI spec fetch failed for ${specUrl}: HTTP ${response.status}`,
				);
			}
			const parsed = await parseOpenApiSpecResponse(response);
			if (!isRecord(parsed)) {
				throw new Error(`OpenAPI spec must be a JSON object: ${specUrl}`);
			}
			parsedSpecs.push(parsed);
		}
		spec = mergeOpenApiSpecs(parsedSpecs);
	}
	if (!isRecord(spec)) throw new Error("OpenAPI spec must be a JSON object");

	const include = resolved.includeOperationIds
		? new Set(resolved.includeOperationIds)
		: null;
	const includePathPrefixes = resolved.includePathPrefixes ?? [];
	const excludePathPrefixes = resolved.excludePathPrefixes ?? [];
	const stripPathPrefixes = resolved.stripPathPrefixes ?? [];
	const dryRun = resolved.dryRun ?? true;
	const replaceExisting = resolved.replaceExisting !== false;
	const items: OpenApiImportResult["items"] = [];
	const existingTools = await getToolsByAppId(db, resolved.appId);
	const existingByToolId = new Map(
		existingTools.map((tool) => [tool.toolId, tool]),
	);
	const existingByEndpoint = new Map(
		existingTools
			.map((tool) => {
				const config =
					tool.config && typeof tool.config === "object"
						? (tool.config as Record<string, unknown>)
						: null;
				const method =
					typeof config?.method === "string" ? config.method : null;
				const endpoint =
					typeof config?.endpoint === "string" ? config.endpoint : null;
				return method && endpoint
					? ([endpointKey(method, endpoint), tool] as const)
					: null;
			})
			.filter(
				(entry): entry is readonly [string, (typeof existingTools)[number]] =>
					Boolean(entry),
			),
	);
	const normalizedBaseUrl = resolved.baseUrl.replace(/\/+$/, "");
	let planned = 0;
	let created = 0;
	let updated = 0;
	let inSync = 0;
	let deleted = 0;
	let skipped = 0;
	let failed = 0;
	const generatedToolIds = new Set<string>();

	for (const entry of operations(spec)) {
		const operationId =
			typeof entry.operation.operationId === "string"
				? entry.operation.operationId
				: null;
		if (include && (!operationId || !include.has(operationId))) continue;
		if (
			includePathPrefixes.length > 0 &&
			!includePathPrefixes.some((prefix) =>
				matchesPathPrefix(entry.path, prefix),
			)
		) {
			continue;
		}
		if (
			excludePathPrefixes.some((prefix) =>
				matchesPathPrefix(entry.path, prefix),
			)
		) {
			continue;
		}

		const generatedPath = generatedOpenApiPath(
			entry.path,
			stripPathPrefixes,
			resolved.pathReplacements,
		);
		const removedPathParams = removedPathParameterNames(
			entry.path,
			generatedPath,
		);
		const generatedToolId = operationId
			? normalizeToolId(operationId)
			: pathToToolName(entry.method, generatedPath);
		const endpoint = toEndpoint(generatedPath);
		const existing =
			existingByToolId.get(generatedToolId) ??
			existingByEndpoint.get(endpointKey(entry.method, endpoint));
		const toolId = existing?.toolId ?? generatedToolId;
		generatedToolIds.add(toolId);
		planned++;
		if (resolved.limit && planned > resolved.limit) {
			planned--;
			skipped++;
			items.push({
				toolId,
				operationId,
				method: entry.method,
				path: entry.path,
				status: "skipped",
				message: "Limit reached",
			});
			continue;
		}

		try {
			const authRequired = operationRequiresAuth(
				spec,
				entry.operation,
				Boolean(resolved.connectionProviderId),
			);
			const omittedCredentialHeaders =
				resolved.connectionProviderId && authRequired
					? providerManagedCredentialHeaderNames(
							spec,
							entry.pathItem,
							entry.operation,
							resolved.authHeader ?? "Authorization",
						)
					: undefined;
			const omittedInputParameters = new Set([
				...(omittedCredentialHeaders ?? []),
				...removedPathParams,
			]);
			const inputSchema = inputSchemaForOperation(
				spec,
				entry.pathItem,
				entry.operation,
				{
					omitParameterNames: omittedInputParameters,
				},
			);
			const headerParams = parameterNamesByLocation(
				spec,
				entry.pathItem,
				entry.operation,
				"header",
				{
					omitParameterNames: omittedCredentialHeaders,
				},
			);
			const queryParams = parameterNamesByLocation(
				spec,
				entry.pathItem,
				entry.operation,
				"query",
			);
			const runtimeOnlyParams = runtimeOnlyParameterNames(entry.operation);
			const arrayFormats = queryArrayFormats(
				spec,
				entry.pathItem,
				entry.operation,
			);
			const bodyInfo = requestBodyInfo(spec, entry.operation);
			const response = responseInfo(spec, entry.operation);
			const responseContentType = response?.contentType ?? null;
			const outputSchema =
				responseContentType && !isJsonContentType(responseContentType)
					? binaryResponseOutputSchema()
					: structuredOutputSchema(response?.schema ?? null);
			const requestContentType = toolRequestContentType(bodyInfo?.contentType);
			const requestBodyParam = requestBodyParamForSchema(bodyInfo?.schema);
			const fileParams =
				requestContentType === "multipart/form-data"
					? collectTopLevelFileParams(normalizeOpenApiSchema(bodyInfo?.schema))
					: [];
			const widgetDefaults = widgetDefaultsForTool(
				resolved,
				toolId,
				operationId,
			);
			const defaultWidget = defaultOpenApiWidgetForOutput(
				toolId,
				outputSchema,
				widgetDefaults,
			);
			const authConfig: Partial<Pick<ToolConfig, "auth">> =
				resolved.connectionProviderId && authRequired
					? {
							auth: {
								type: "connection" as const,
								connectionId: resolved.connectionProviderId,
								scope: resolved.connectionScope ?? "tenant",
								credentialScope: resolved.connectionScope ?? "tenant",
								...(resolved.connectionScope === "hybrid"
									? { credentialPreference: "user-first" as const }
									: {}),
								...(resolved.authScopes?.length
									? { scopes: resolved.authScopes }
									: {}),
								...(resolved.authHeader ? { header: resolved.authHeader } : {}),
								...(resolved.authTemplate
									? { template: resolved.authTemplate }
									: {}),
								...(resolved.authEncoding
									? { encoding: resolved.authEncoding }
									: {}),
							},
						}
					: {};
			const config: ToolConfig & Record<string, unknown> = {
				transport: "external",
				method: entry.method,
				baseUrl: normalizedBaseUrl,
				endpoint,
				responsePath: undefined,
				...(requestContentType && requestContentType !== "application/json"
					? { requestContentType }
					: {}),
				...(responseContentType && !isJsonContentType(responseContentType)
					? { responseMode: "base64" as const }
					: {}),
				...(fileParams.length > 0 ? { fileParams } : {}),
				...(requestBodyParam ? { requestBodyParam } : {}),
				...(headerParams.length > 0 ? { headerParams } : {}),
				...(queryParams.length > 0 ? { queryParams } : {}),
				...(Object.keys(arrayFormats).length > 0
					? { queryArrayFormats: arrayFormats }
					: {}),
				...(runtimeOnlyParams.length > 0 ? { runtimeOnlyParams } : {}),
				...(resolved.namespace
					? { _aggregateNamespace: resolved.namespace }
					: {}),
				...(resolved.staticHeaders
					? { staticHeaders: resolved.staticHeaders }
					: {}),
				...defaultWidget?.config,
				...authConfig,
			};
			const sourceConfig = withoutUndefined(config) as ToolConfig &
				Record<string, unknown>;
			const normalizedConfig = mergeOpenApiConfigOverlay(
				sourceConfig,
				existing?.config,
				{ preserveWidgetProjection: !widgetDefaults },
			);
			const widgetKey =
				isRecord(normalizedConfig.layoutSpec) ||
				typeof normalizedConfig.layoutSpec === "string"
					? "render"
					: (defaultWidget?.widgetKey ?? null);
			const annotations = annotationsForMethod(entry.method);
			const writeCapability = writeCapabilityForMethod(entry.method);
			const schemaSourceRef = `${resolved.specUrl ?? "inline"}#${entry.method} ${entry.path}`;
			const schemaSourceHash = await sha256({
				operation: entry.operation,
				inputSchema,
				outputSchema,
				config: sourceConfig,
				annotations,
				writeCapability,
				authRequired,
				visibility: authRequired ? "private" : "public",
				fileParams,
			});
			const storedFieldsMatch = existing
				? jsonEqual(existing.inputSchema, inputSchema) &&
					jsonEqual(existing.outputSchema, outputSchema) &&
					jsonEqual(existing.config, normalizedConfig) &&
					jsonEqual(existing.annotations, annotations) &&
					existing.writeCapability === writeCapability &&
					jsonEqual(
						existing.fileParams ?? null,
						fileParams.length > 0 ? fileParams : null,
					)
				: false;
			const importStatus = existing
				? existing.schemaSource === "openapi" &&
					existing.schemaSourceHash === schemaSourceHash &&
					storedFieldsMatch
					? "inSync"
					: dryRun
						? "wouldUpdate"
						: "updated"
				: dryRun
					? "wouldCreate"
					: "created";

			if (importStatus === "inSync") {
				inSync++;
				items.push({
					toolId,
					operationId,
					method: entry.method,
					path: entry.path,
					status: importStatus,
				});
				continue;
			}

			if (!dryRun) {
				await upsertTool(db, {
					appId: resolved.appId,
					toolId,
					toolTypeId: "external",
					title: titleFromName(toolId),
					description: operationDescription(entry.operation),
					inputSchema,
					outputSchema,
					config: toJsonRecord(normalizedConfig),
					widgetKey,
					authRequired,
					visibility: authRequired ? "private" : "public",
					annotations,
					writeCapability,
					fileParams: fileParams.length > 0 ? fileParams : null,
					schemaDialect: "json-schema-2020-12",
					schemaSource: "openapi",
					schemaSourceRef,
					schemaSourceHash,
					schemaSyncedAt: new Date().toISOString(),
					enabled: true,
					sortOrder: 0,
				});
				if (importStatus === "created") created++;
				else updated++;
			}

			items.push({
				toolId,
				operationId,
				method: entry.method,
				path: entry.path,
				status: importStatus,
			});
		} catch (error) {
			failed++;
			items.push({
				toolId,
				operationId,
				method: entry.method,
				path: entry.path,
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (replaceExisting) {
		for (const tool of existingTools) {
			const config =
				tool.config && typeof tool.config === "object"
					? (tool.config as Record<string, unknown>)
					: null;
			if (config?.transport !== "external") continue;
			if (generatedToolIds.has(tool.toolId)) continue;
			if (!dryRun) {
				await deleteTool(db, tool.id);
				deleted++;
			}
			items.push({
				toolId: tool.toolId,
				operationId: null,
				method: String(config.method ?? "GET"),
				path: String(config.endpoint ?? ""),
				status: dryRun ? "wouldDelete" : "deleted",
				message:
					"Existing external tool not present in generated OpenAPI import",
			});
		}
	}

	const result = {
		appId: resolved.appId,
		dryRun,
		totalOperations: operations(spec).length,
		planned,
		created,
		updated,
		inSync,
		deleted,
		skipped,
		failed,
		items,
	};

	if (!dryRun) {
		await persistOpenApiSyncConfig(db, resolved, appMetadata, result);
	}

	// A removed tool strands every published profile that still admits it, so
	// the profiles are reconciled here rather than left to fail one session at a
	// time. This never fails the import: the tool catalogue is the source of
	// truth and has already been written, so a reconciliation problem is
	// reported alongside the result instead of rolling back a correct sync.
	let profileReconciliations: PortableWebMcpReconciliation[] | undefined;
	if (!dryRun && deleted > 0) {
		const app = await getAppById(db, resolved.appId);
		if (app?.organizationId) {
			try {
				profileReconciliations = await reconcilePublishedWebMcpProfiles(db, {
					providerOrganizationId: app.organizationId,
					providerAppId: resolved.appId,
					reason: `OpenAPI import removed ${deleted} tool(s) from ${app.slug}`,
					publishedBy: "system:openapi-import",
				});
			} catch (error) {
				console.error("Portable WebMCP profile reconciliation failed", {
					appId: resolved.appId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return profileReconciliations
		? { ...result, profileReconciliations }
		: result;
}

export async function previewOpenApiToolImport(
	db: DbClient,
	input: OpenApiImportInput,
): Promise<OpenApiImportResult> {
	return executeOpenApiToolImport(db, { ...input, dryRun: true });
}
