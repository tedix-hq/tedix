/**
 * Description template for the outer `code` tool.
 *
 * `{{types}}` and `{{example}}` placeholders match upstream
 * `@cloudflare/codemode/mcp::codeMcpServer`'s convention. Keeping
 * the same shape isolates copy edits from the substitution machinery
 * and keeps a future migration to upstream's `description` option
 * (added in 0.3.4) a one-liner.
 */

import { sanitizeToolName } from "@cloudflare/codemode";
import type { ToolSummary } from "./types";

export const CODE_DESCRIPTION_TEMPLATE = `Run JS in a sandbox. Available globals are only \`codemode\` plus any explicitly documented extra namespaces; there is no host, fs, require, process, or external fetch. Discover tools: \`await codemode.__tools()\`. Get full types for one: \`await codemode.__doc({name})\`. Inspect the current execution context with \`await codemode.__runtime()\`. Write an async arrow fn returning the result. No TS syntax.

{{types}}

{{example}}`;

/**
 * Build the outer `code` tool description from discovered tool summaries
 * plus a sample first tool used to render the inline example.
 */
export function buildCodeDescription(
	toolSummaries: ToolSummary[],
	firstTool:
		| {
				name: string;
				inputSchema: Record<string, unknown>;
		  }
		| undefined,
): string {
	const signatureLines = toolSummaries
		.map((t) => `  ${t.name}${t.paramSummary}`)
		.join("\n");

	let example = "";
	if (firstTool) {
		const props = (firstTool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string }
		>;
		const parts: string[] = [];
		for (const [key, prop] of Object.entries(props)) {
			if (prop.type === "number" || prop.type === "integer")
				parts.push(`${key}: 0`);
			else if (prop.type === "boolean") parts.push(`${key}: true`);
			else parts.push(`${key}: "..."`);
		}
		const args = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
		example = `Example: async () => await codemode.${sanitizeToolName(firstTool.name)}(${args})`;
	}

	const types = `Tools (${toolSummaries.length}, plus __tools/__doc/__runtime):\n${signatureLines}`;

	return CODE_DESCRIPTION_TEMPLATE.replace("{{types}}", types).replace(
		"{{example}}",
		example,
	);
}
