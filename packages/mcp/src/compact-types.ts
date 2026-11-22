/**
 * @tedix/mcp — Compact Type Generation
 *
 * Generates TypeScript-like type declarations from JSON Schema tool
 * descriptors for Code Mode. Shared by apps/mcp (customer-facing MCP) and
 * apps/tedi (tedi runtime MCP).
 *
 * - buildCompactTypes: shallow method signatures for the `code` tool
 *   description. No JSDoc or field descriptions.
 * - renderSchemaType / resultTypeFromSchema: one bounded schema walker.
 * - buildToolDeclaration: one tool as a .d.ts-style declaration for
 *   discover.describe({ callable, format: "ts" }).
 *
 * @see docs/engineering/mcp/codemode.md
 */

import type { JsonSchemaToolDescriptors } from "@cloudflare/codemode";
import { isRecord } from "@tedix/api-contract/utils/is-record";

// =============================================================================
// TYPES
// =============================================================================

export interface NamespaceGroup {
	fns: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
	schemas: JsonSchemaToolDescriptors;
}

// =============================================================================
// COMPACT TYPE GENERATION — minimal signatures, no JSDoc/descriptions
// =============================================================================

export function schemaPrimitiveToTs(t: string): string {
	switch (t) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "array":
			return "unknown[]";
		case "object":
			return "Record<string, unknown>";
		case "null":
			return "null";
		default:
			return "unknown";
	}
}

export function schemaPropertyToTs(prop: Record<string, unknown>): string {
	const enumValues = prop.enum as unknown[] | undefined;
	if (enumValues && enumValues.length <= 6) {
		return enumValues
			.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
			.join(" | ");
	}
	const type = prop.type as string | string[] | undefined;
	if (Array.isArray(type)) {
		return type.map((t) => schemaPrimitiveToTs(t)).join(" | ");
	}
	return type ? schemaPrimitiveToTs(type) : "unknown";
}

/**
 * Build compact type declarations for the code tool description.
 *
 * Emits typed method signatures with shallow parameter types — enough for
 * the LLM to call tools correctly. No JSDoc, no separate type declarations,
 * no field descriptions. Use discover.search() for full detail.
 */
export function buildCompactTypes(
	namespaceGroups: Map<string, NamespaceGroup>,
): string {
	const blocks: string[] = [];

	for (const [ns, group] of namespaceGroups) {
		const methods: string[] = [];
		for (const [toolName, schema] of Object.entries(group.schemas)) {
			const props = schema.inputSchema?.properties as
				| Record<string, Record<string, unknown>>
				| undefined;
			const required = new Set(
				(schema.inputSchema?.required as string[] | undefined) ?? [],
			);

			let paramType: string;
			if (!props || Object.keys(props).length === 0) {
				paramType = "Record<string, unknown>";
			} else {
				const fields = Object.entries(props).map(([name, prop]) => {
					const opt = required.has(name) ? "" : "?";
					const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
						? name
						: JSON.stringify(name);
					return `${safeName}${opt}: ${schemaPropertyToTs(prop)}`;
				});
				paramType = `{ ${fields.join("; ")} }`;
			}

			methods.push(
				`  function ${toolName}(input: ${paramType}): Promise<unknown>;`,
			);
		}
		blocks.push(`declare namespace ${ns} {\n${methods.join("\n")}\n}`);
	}

	return blocks.join("\n\n");
}

// =============================================================================
// BOUNDED SCHEMA WALKER — shared by describe's resultType and format "ts"
// =============================================================================

const MAX_ENUM_MEMBERS = 12;
const MAX_UNION_MEMBERS = 12;
const MAX_OBJECT_FIELDS = 40;

export interface RenderSchemaTypeOptions {
	/** Nesting depth past which a schema renders as `unknown`. */
	maxDepth: number;
	/** Output length past which the whole walk gives up. */
	maxChars: number;
	/** Schema nodes visited past which the whole walk gives up. */
	maxNodes: number;
}

interface Walk extends RenderSchemaTypeOptions {
	root: unknown;
	nodes: number;
	overflow: boolean;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function propertyKey(name: string): string {
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Literal union, or the members' primitive types when it is too long to list. */
function enumType(values: unknown[], walk: Walk): string {
	if (values.length === 0) return "never";
	if (values.length > MAX_ENUM_MEMBERS) {
		const kinds = new Set(
			values.map((value) => (value === null ? "null" : typeof value)),
		);
		return [...kinds].every((kind) =>
			["string", "number", "boolean", "null"].includes(kind),
		)
			? [...kinds].join(" | ")
			: "unknown";
	}
	return joinBounded(
		values.map((value) => JSON.stringify(value) ?? "unknown"),
		" | ",
		walk,
	);
}

/** Join parts, marking the walk overflowed once the output budget is spent. */
function joinBounded(parts: string[], separator: string, walk: Walk): string {
	const text = parts.join(separator);
	if (text.length > walk.maxChars) walk.overflow = true;
	return walk.overflow ? "unknown" : text;
}

/**
 * Union or intersection without repeats. `unknown` absorbs a union and is the
 * identity of an intersection, so depth-capped members do not print as noise.
 */
function combineTypes(
	parts: string[],
	operator: "|" | "&",
	walk: Walk,
): string {
	const unique = [...new Set(parts)];
	if (operator === "|" && unique.includes("unknown")) return "unknown";
	const members =
		operator === "&" ? unique.filter((part) => part !== "unknown") : unique;
	if (members.length === 0) return "unknown";
	return joinBounded(members, ` ${operator} `, walk);
}

function renderNode(schema: unknown, walk: Walk, depth: number): string {
	if (walk.overflow) return "unknown";
	if (++walk.nodes > walk.maxNodes) {
		walk.overflow = true;
		return "unknown";
	}
	if (!isRecord(schema) || depth >= walk.maxDepth) return "unknown";
	const nested = (value: unknown) => renderNode(value, walk, depth + 1);
	if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
		let target = walk.root;
		for (const key of schema.$ref.slice(2).split("/")) {
			target = isRecord(target)
				? target[key.replace(/~1/g, "/").replace(/~0/g, "~")]
				: undefined;
		}
		return nested(target);
	}
	if (schema.const !== undefined) return enumType([schema.const], walk);
	if (Array.isArray(schema.enum)) return enumType(schema.enum, walk);
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const members = schema[key];
		if (!Array.isArray(members)) continue;
		// A partial union or intersection would claim a shape the tool lacks.
		if (members.length > MAX_UNION_MEMBERS) return "unknown";
		const parts: string[] = [];
		for (const member of members) {
			parts.push(nested(member));
			if (walk.overflow) return "unknown";
		}
		const combined = combineTypes(parts, key === "allOf" ? "&" : "|", walk);
		return combined.includes(key === "allOf" ? " & " : " | ")
			? `(${combined})`
			: combined;
	}
	if (Array.isArray(schema.type)) {
		if (schema.type.length > MAX_UNION_MEMBERS) return "unknown";
		return combineTypes(
			schema.type.map((type) => nested({ ...schema, type })),
			"|",
			walk,
		);
	}
	switch (schema.type ?? (isRecord(schema.properties) ? "object" : undefined)) {
		case "null":
			return "null";
		case "string":
			return "string";
		case "boolean":
			return "boolean";
		case "number":
		case "integer":
			return "number";
		case "array":
			return `Array<${nested(schema.items)}>`;
		case "object": {
			const required = Array.isArray(schema.required) ? schema.required : [];
			const entries = Object.entries(
				isRecord(schema.properties) ? schema.properties : {},
			);
			const fields: string[] = [];
			let length = 0;
			for (const [key, value] of entries.slice(0, MAX_OBJECT_FIELDS)) {
				const field = `${propertyKey(key)}${required.includes(key) ? "" : "?"}: ${nested(value)}`;
				length += field.length + 2;
				if (walk.overflow || length > walk.maxChars) {
					walk.overflow = true;
					return "unknown";
				}
				fields.push(field);
			}
			// Unlisted fields stay visible as an index signature.
			if (entries.length > MAX_OBJECT_FIELDS)
				fields.push("[key: string]: unknown");
			return fields.length
				? `{ ${fields.join("; ")} }`
				: "Record<string, unknown>";
		}
		default:
			return "unknown";
	}
}

/**
 * Render one schema as a TypeScript type. The walk is bounded by depth, by
 * visited nodes and by output length; past either budget it yields `unknown`.
 * Recursive and unsupported parts stay `unknown`.
 */
export function renderSchemaType(
	schema: unknown,
	options: RenderSchemaTypeOptions,
	root: unknown = schema,
): string {
	const walk: Walk = { ...options, root, nodes: 0, overflow: false };
	const rendered = renderNode(schema, walk, 0);
	return walk.overflow || rendered.length > options.maxChars
		? "unknown"
		: rendered;
}

/** Shallowest-first retry: the deepest rendering that fits `maxChars`. */
function fittedSchemaType(
	schema: unknown,
	maxChars: number,
	root: unknown = schema,
): string {
	for (const maxDepth of [6, 4, 2, 1]) {
		const result = renderSchemaType(
			schema,
			{ maxDepth, maxChars, maxNodes: 2_000 },
			root,
		);
		if (result !== "unknown" || maxDepth === 1) return result;
	}
	return "unknown";
}

/** Bounded result types for describe; recursive/unsupported schema parts stay unknown. */
export function resultTypeFromSchema(schema: unknown, maxChars = 700): string {
	return fittedSchemaType(schema, maxChars);
}

// =============================================================================
// TOOL DECLARATION — discover.describe({ callable, format: "ts" })
// =============================================================================

const MAX_FIELD_TYPE_CHARS = 600;
const MAX_FIELD_DOC_CHARS = 400;
const MAX_INPUT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 2_000;

/** Make text safe inside a JSDoc block: no comment breakout, one line per row. */
export function escapeJsDoc(text: string): string {
	return text.replace(/\*\//g, "*\\/").replace(/\r\n?/g, "\n").trim();
}

function jsDoc(text: string, indent: string): string[] {
	const lines = escapeJsDoc(text).split("\n");
	if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
	return [
		`${indent}/**`,
		...lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`),
		`${indent} */`,
	];
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function inputDeclaration(inputSchema: unknown): string[] {
	const schema = isRecord(inputSchema) ? inputSchema : {};
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		Array.isArray(schema.required) ? schema.required : [],
	);
	const names = Object.keys(properties);
	if (names.length === 0) return ["type Input = Record<string, unknown>;"];
	// Required fields first, so a size cut never drops one before an optional.
	const ordered = [
		...names.filter((name) => required.has(name)),
		...names.filter((name) => !required.has(name)),
	];
	const lines = ["interface Input {"];
	let length = 0;
	let omitted = 0;
	for (const name of ordered) {
		const property = properties[name];
		const field: string[] = [];
		const description = isRecord(property) ? property.description : undefined;
		const notes = [
			typeof description === "string" ? description : "",
			isRecord(property) && property.default !== undefined
				? `Default: ${clip(JSON.stringify(property.default) ?? "", 80)}`
				: "",
		].filter(Boolean);
		if (notes.length)
			field.push(...jsDoc(clip(notes.join(" "), MAX_FIELD_DOC_CHARS), "  "));
		const type = fittedSchemaType(property, MAX_FIELD_TYPE_CHARS, schema);
		field.push(
			`  ${propertyKey(name)}${required.has(name) ? "" : "?"}: ${type};`,
		);
		const size = field.reduce((sum, line) => sum + line.length + 1, 0);
		if (length + size > MAX_INPUT_CHARS) {
			omitted = ordered.length - ordered.indexOf(name);
			break;
		}
		length += size;
		lines.push(...field);
	}
	if (omitted > 0) {
		lines.push(
			`  // ${omitted} more fields omitted; describe with format "json" for the full schema.`,
			"  [key: string]: unknown;",
		);
	}
	lines.push("}");
	return lines;
}

export interface ToolDeclarationInput {
	namespace: string;
	tool: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	/** Output schema was sampled from results rather than declared. */
	outputInferred?: boolean;
	/** Set when the caller lacks scopes; the declaration then leads with them. */
	missingScopes?: readonly string[];
}

/** One tool as a .d.ts-style declaration: Input, Output and the function. */
export function buildToolDeclaration(input: ToolDeclarationInput): string {
	const lines: string[] = [];
	if (input.missingScopes) {
		lines.push(
			`// not callable by you: missing scopes ${
				input.missingScopes
					.map((scope) => scope.replace(/\s+/g, " "))
					.join(", ") || "(none listed)"
			}`,
		);
	}
	lines.push(...inputDeclaration(input.inputSchema));
	if (input.outputSchema === undefined) {
		lines.push("type Output = unknown;");
	} else {
		if (input.outputInferred) {
			lines.push(
				"/** Advisory: inferred from sampled results, not a declared contract. */",
			);
		}
		lines.push(
			`type Output = ${resultTypeFromSchema(input.outputSchema, MAX_OUTPUT_CHARS)};`,
		);
	}
	const doc = input.description?.trim() ? jsDoc(input.description, "  ") : [];
	if (IDENTIFIER.test(input.namespace) && IDENTIFIER.test(input.tool)) {
		lines.push(
			`declare namespace ${input.namespace} {`,
			...doc,
			`  function ${input.tool}(input: Input): Promise<Output>;`,
			"}",
		);
	} else {
		// Not expressible as a namespace member; the callable is a string key.
		const callable = JSON.stringify(`${input.namespace}.${input.tool}`);
		lines.push(
			...doc.map((line) => line.slice(2)),
			`declare function call(input: Input): Promise<Output>; // ${callable}`,
		);
	}
	return lines.join("\n");
}
