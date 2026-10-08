/**
 * @tedix/mcp — Compact Type Generation
 *
 * Generates minimal TypeScript-like type declarations from JSON Schema
 * tool descriptors for Code Mode descriptions. Shared by apps/mcp
 * (customer-facing MCP) and apps/tedi (tedi runtime MCP).
 *
 * Emits typed method signatures with shallow parameter types — enough for
 * the LLM to call tools correctly. No JSDoc, no separate type declarations,
 * no field descriptions. Use discover.search() for full detail.
 *
 * @see docs/engineering/mcp/codemode.md
 */

import type { JsonSchemaToolDescriptors } from "@cloudflare/codemode";

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
