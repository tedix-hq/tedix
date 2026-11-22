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
 * Upper bound for the `code` tool description, below the 4,096 characters
 * hosts such as Claude Code keep. Mirrors the gateway's
 * `MAX_CODEMODE_DESCRIPTION_CHARS` in `apps/mcp/src/mcp/codemode-guidance.ts`.
 */
export const MAX_CODE_DESCRIPTION_CHARS = 4_000;

const MAX_NAMESPACE_SUMMARY_CHARS = 500;

/** Group tools by the prefix before the first `_`, largest group first. */
function namespaceSummary(toolSummaries: ToolSummary[]): string {
	const counts = new Map<string, number>();
	for (const { name } of toolSummaries) {
		const namespace = name.split("_")[0] || name;
		counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
	}
	const sorted = [...counts].sort((a, b) => b[1] - a[1]);
	const shown: string[] = [];
	let length = 0;
	for (const [name, count] of sorted) {
		const entry = `${name}_* (${count})`;
		if (length + entry.length + 2 > MAX_NAMESPACE_SUMMARY_CHARS) break;
		shown.push(entry);
		length += entry.length + 2;
	}
	const hidden = sorted.length - shown.length;
	return hidden > 0 ? `${shown.join(", ")}, +${hidden} more` : shown.join(", ");
}

/**
 * Build the outer `code` tool description from discovered tool summaries
 * plus a sample first tool used to render the inline example. Every tool
 * signature is inlined while it fits within MAX_CODE_DESCRIPTION_CHARS;
 * beyond that the description lists tool-name prefixes and points the
 * model at `codemode.__tools()` / `codemode.__doc()`.
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

	const render = (types: string) =>
		CODE_DESCRIPTION_TEMPLATE.replace("{{types}}", types).replace(
			"{{example}}",
			example,
		);

	const signatureLines = toolSummaries
		.map((t) => `  ${t.name}${t.paramSummary}`)
		.join("\n");
	const full = render(
		`Tools (${toolSummaries.length}, plus __tools/__doc/__runtime):\n${signatureLines}`,
	);
	if (full.length <= MAX_CODE_DESCRIPTION_CHARS) return full;

	const summary = render(
		`Tools (${toolSummaries.length}) by name prefix: ${namespaceSummary(toolSummaries)}.\nToo many to list here: call \`await codemode.__tools()\` for names and parameter summaries, then \`await codemode.__doc({name})\` before first use.`,
	);
	return summary.slice(0, MAX_CODE_DESCRIPTION_CHARS);
}
