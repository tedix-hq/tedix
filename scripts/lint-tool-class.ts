#!/usr/bin/env bun

/**
 * Tool class declarations (`bun scripts/lint-tool-class.ts`, part of `lint:repo`).
 *
 * Every tool defined in code or in a versioned asset must say what it does:
 * a write class (read, write or destructive) and, unless it only reads, a risk
 * tier. Approval checks trust that statement before the tool's name, so a
 * tool without one is judged by how its name happens to read.
 *
 * Checked here:
 * - platform operator tools: each has a `kind`, and the tier derived from it
 *   fits;
 * - Home tools: annotations state the write class, and each non-read tool has
 *   a risk tier in `critical-actions.v1.json` `builtinToolPolicies`;
 * - `builtinToolPolicies` entries are complete and valid.
 *
 * No exceptions are permitted for existing Home tools. Database rows are checked
 * when they are saved (`toolClassDeclarationGap`).
 */

import {
	deriveToolWriteCapability,
	ToolPolicyMetadataSchema,
	withDerivedToolOperationalRiskPolicy,
	type ToolAnnotations,
} from "../packages/api-contract/src/schemas/tools";
import criticalActions from "../packages/api-contract/src/assets/critical-actions.v1.json";
import { toolClassDeclarationGap } from "../packages/api-contract/src/utils/tool-declared-class";

interface CodeTool {
	toolId: string;
	annotations?: unknown;
	meta?: unknown;
}

export function operatorToolFindings(
	definitions: readonly { toolId: string; kind?: unknown }[],
): string[] {
	const problems: string[] = [];
	for (const definition of definitions) {
		const kind = definition.kind;
		if (kind !== "read" && kind !== "write" && kind !== "destructive") {
			problems.push(
				`operator tool ${definition.toolId}: kind must be "read", "write" or "destructive"`,
			);
			continue;
		}
		const gap = toolClassDeclarationGap({
			writeCapability: kind,
			meta: withDerivedToolOperationalRiskPolicy({
				writeCapability: kind,
				config: { transport: "rpc" },
			}),
		});
		if (gap) problems.push(`operator tool ${definition.toolId} ${gap}`);
	}
	return problems;
}

export function homeToolFindings(tools: readonly CodeTool[]): string[] {
	const problems: string[] = [];
	for (const tool of tools) {
		const writeCapability = deriveToolWriteCapability(
			tool.annotations as ToolAnnotations | null,
		);
		const gap = toolClassDeclarationGap({
			writeCapability,
			meta: tool.meta as Record<string, unknown> | null,
		});
		if (!gap) continue;
		problems.push(
			`Home tool ${tool.toolId} ${gap}. State readOnlyHint/destructiveHint on the tool and add its risk tier to builtinToolPolicies in critical-actions.v1.json.`,
		);
	}
	return problems;
}

export function builtinPolicyFindings(
	policies: Record<string, unknown>,
): string[] {
	const problems: string[] = [];
	for (const [toolId, policy] of Object.entries(policies)) {
		const parsed = ToolPolicyMetadataSchema.safeParse(policy);
		if (!parsed.success)
			problems.push(
				`builtinToolPolicies.${toolId}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
			);
		else if (!parsed.data.riskTier || !parsed.data.blastRadius)
			problems.push(
				`builtinToolPolicies.${toolId}: riskTier and blastRadius are required`,
			);
	}
	return problems;
}

/** Loaded by path so this script's type-check does not pull in the gateway. */
async function load<T>(path: string): Promise<T> {
	return (await import(new URL(path, import.meta.url).href)) as T;
}

if (import.meta.main) {
	const { PLATFORM_OPERATOR_TOOL_DEFINITIONS } = await load<{
		PLATFORM_OPERATOR_TOOL_DEFINITIONS: { toolId: string; kind?: unknown }[];
	}>("../apps/mcp/src/mcp/platform-operator-tools.ts");
	const { buildHomeSurfaceTools } = await load<{
		buildHomeSurfaceTools: () => CodeTool[];
	}>("../apps/mcp/src/mcp/home-surface-tools.ts");
	const homeTools = buildHomeSurfaceTools();
	const problems = [
		...operatorToolFindings(PLATFORM_OPERATOR_TOOL_DEFINITIONS),
		...homeToolFindings(homeTools),
		...builtinPolicyFindings(criticalActions.builtinToolPolicies),
	];
	for (const problem of problems) console.error(problem);
	if (problems.length) process.exit(1);
	console.log(
		`Tool classes: ${PLATFORM_OPERATOR_TOOL_DEFINITIONS.length} operator tools and ${homeTools.length} Home tools state a write class; all non-read Home tools state a risk tier.`,
	);
}
