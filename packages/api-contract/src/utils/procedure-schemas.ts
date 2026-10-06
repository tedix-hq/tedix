/**
 * The one place that reads a procedure contract's schemas.
 *
 * oRPC keeps them behind the private `~orpc` definition key, and v2 reshaped it:
 * `inputSchema` / `outputSchema` became `inputSchemas` / `outputSchemas`
 * ARRAYS, because `.input()` and `.output()` now stack additively instead of
 * replacing. Before this module, ~109 call sites across `apps/mcp`'s
 * aggregate-tedis-* files read `procedure["~orpc"].inputSchema` directly, which
 * meant the v2 upgrade touched every one of them — and those sites feed the MCP
 * tool-schema projection, so quietly taking the wrong element publishes wrong
 * tool schemas to tenants.
 *
 * Stacking is deliberately NOT merged here. Combining two arbitrary standard
 * schemas is not something this layer can do correctly, so a stacked procedure
 * throws instead of silently projecting a partial schema. Every contract in
 * this repo calls `.input()` at most once, so the throw is a guard against a
 * future change, not a live case.
 */

const ORPC_DEF = "~orpc" as const;

interface ProcedureSchemaDefinition {
	inputSchemas?: unknown[];
	outputSchemas?: unknown[];
}

function definitionOf(
	procedure: unknown,
): ProcedureSchemaDefinition | undefined {
	if (typeof procedure !== "object" || procedure === null) return undefined;
	const def = (procedure as Record<string, unknown>)[ORPC_DEF];
	if (typeof def !== "object" || def === null) return undefined;
	return def as ProcedureSchemaDefinition;
}

function single(
	schemas: unknown[] | undefined,
	kind: "input" | "output",
): unknown {
	if (!schemas || schemas.length === 0) return undefined;
	if (schemas.length > 1) {
		throw new Error(
			`Procedure declares ${schemas.length} stacked ${kind} schemas; ` +
				`this projection cannot merge them. Give the procedure a single ` +
				`.${kind}() schema, or teach procedure-schemas.ts how to combine them.`,
		);
	}
	return schemas[0];
}

/** The procedure's single input schema, or `undefined` when it takes no input. */
export function procedureInputSchema(procedure: unknown): unknown {
	return single(definitionOf(procedure)?.inputSchemas, "input");
}

/** The procedure's single output schema, or `undefined` when none is declared. */
export function procedureOutputSchema(procedure: unknown): unknown {
	return single(definitionOf(procedure)?.outputSchemas, "output");
}
