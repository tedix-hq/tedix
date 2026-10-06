/**
 * Preview Widget Tool
 *
 * MCP tool that analyzes a json-render spec structurally and returns
 * a preview analysis with component tree, issue detection, and preview URL.
 *
 * @module @tedix/mcp/mcp/tools/preview-widget
 */

import { isNonEmptySpec, validateSpec } from "@json-render/core";
import type { ToolAuthShape } from "@tedix/mcp-shared/auth/tool-scopes";
import * as z from "zod";
import { enforceMcpToolScopeAuthorization } from "../codemode-auth";
import type { ServerContext } from "../server-context";

const PREVIEW_WIDGET_REQUIRED_SCOPES = ["mcp:apps.read"] as const;
const PREVIEW_WIDGET_AUTH = {
	toolId: "preview_widget",
	authRequired: true,
	visibility: "private",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		openWorldHint: false,
	},
} satisfies ToolAuthShape;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ElementMap = Record<string, Record<string, unknown>>;

/**
 * Truncate a string to maxLen characters, appending ellipsis if truncated.
 */
function truncate(value: unknown, maxLen = 40): string {
	const str = typeof value === "string" ? value : String(value ?? "");
	return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}

/**
 * Walk the element tree from a given key and build an indented text description.
 */
function describeElement(
	key: string,
	elements: ElementMap,
	depth: number,
	visited: Set<string>,
): string[] {
	const indent = "  ".repeat(depth);

	if (visited.has(key)) {
		return [`${indent}- ${key} [CIRCULAR]`];
	}
	visited.add(key);

	const el = elements[key];
	if (!el) {
		return [`${indent}- ${key} [MISSING]`];
	}

	const type = typeof el.type === "string" ? el.type : "unknown";

	// Gather key props for display
	const props: string[] = [];
	for (const prop of ["title", "label", "text"]) {
		if (el[prop] != null) {
			props.push(`${prop}=${JSON.stringify(truncate(el[prop]))}`);
		}
	}

	// Repeat info
	if (el.repeat != null) {
		const repeatSrc =
			typeof el.repeat === "object" && el.repeat !== null
				? ((el.repeat as Record<string, unknown>).source ?? "?")
				: el.repeat;
		props.push(`repeat=${truncate(repeatSrc, 30)}`);
	}

	const propsStr = props.length > 0 ? ` (${props.join(", ")})` : "";
	const lines: string[] = [`${indent}- ${key}: ${type}${propsStr}`];

	// Recurse into children
	const children = el.children;
	if (Array.isArray(children)) {
		for (const childKey of children) {
			if (typeof childKey === "string") {
				lines.push(...describeElement(childKey, elements, depth + 1, visited));
			}
		}
	}

	return lines;
}

/**
 * Build a full text description of the spec starting from root.
 */
function describeSpec(root: string, elements: ElementMap): string {
	const visited = new Set<string>();
	return describeElement(root, elements, 0, visited).join("\n");
}

/**
 * Count elements by their type field.
 */
function countByType(elements: ElementMap): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const el of Object.values(elements)) {
		const type = typeof el.type === "string" ? el.type : "unknown";
		counts[type] = (counts[type] ?? 0) + 1;
	}
	return counts;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `preview_widget` tool on the MCP server.
 *
 * Analyzes a json-render spec structurally and returns a preview analysis
 * including component tree, counts, state keys, issues, and a preview URL.
 */
export function registerPreviewWidgetTool(agent: ServerContext): void {
	const registeredTool = agent.server.registerTool(
		"preview_widget",
		{
			title: "Preview Widget",
			description:
				"Analyze a json-render widget spec structurally. Returns a component tree, issue diagnostics, and a preview URL. Does not execute any side effects.",
			inputSchema: {
				spec: z
					.record(z.string(), z.unknown())
					.describe(
						"The json-render spec object (must contain `root` and `elements`)",
					),
				data: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Optional runtime data to merge into spec.state"),
				width: z
					.number()
					.min(320)
					.max(1920)
					.optional()
					.describe(
						"Viewport width in pixels (reserved for future screenshot support)",
					),
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false,
			},
		},
		async ({ spec, data }) => {
			const scopeDenial = enforceMcpToolScopeAuthorization(
				agent,
				PREVIEW_WIDGET_AUTH,
				"apps",
				PREVIEW_WIDGET_REQUIRED_SCOPES,
			);
			if (scopeDenial) return scopeDenial;

			// 1. Validate spec has root and elements
			if (!isNonEmptySpec(spec)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `## Validation Failed\n\n- Spec is missing required \`root\` key and/or \`elements\` object.`,
						},
					],
					isError: true,
				};
			}

			const root = spec.root as string;
			const elements = spec.elements as unknown as ElementMap;

			// 2. Merge data into spec.state if provided
			const mergedSpec = { ...spec };
			if (data) {
				const existingState =
					typeof spec.state === "object" &&
					spec.state !== null &&
					!Array.isArray(spec.state)
						? (spec.state as Record<string, unknown>)
						: {};
				mergedSpec.state = { ...existingState, ...data };
			}

			// 3. Describe the element tree
			const tree = describeSpec(root, elements);

			// 4. Count components by type
			const counts = countByType(elements);
			const countLines = Object.entries(counts)
				.sort(([, a], [, b]) => b - a)
				.map(([type, count]) => `- ${type}: ${count}`)
				.join("\n");

			// 5. State keys
			const state = mergedSpec.state as Record<string, unknown> | undefined;
			const stateKeys = state ? Object.keys(state) : [];

			// 6. Check for issues
			const validation = validateSpec(mergedSpec as never);
			const issues = (validation.issues ?? []).map((i) => ({
				severity: (i.severity ?? "warning") as "error" | "warning",
				message: i.elementKey ? `${i.message} (at ${i.elementKey})` : i.message,
			}));
			const issueLines =
				issues.length > 0
					? issues
							.map((i) => `- [${i.severity.toUpperCase()}] ${i.message}`)
							.join("\n")
					: "No issues found.";

			// 7. Build preview URL
			const specJson = JSON.stringify(mergedSpec);
			let specBinary = "";
			for (const byte of new TextEncoder().encode(specJson)) {
				specBinary += String.fromCharCode(byte);
			}
			const previewUrl =
				specJson.length <= 8000
					? `${agent.getWidgetDomain()}/${agent.appSlug}/r/preview?spec=${encodeURIComponent(btoa(specBinary))}`
					: `${agent.getWidgetDomain()}/${agent.appSlug}/r/preview (spec too large for URL embedding)`;

			// 8. Build markdown analysis
			const totalElements = Object.keys(elements).length;
			const markdown = [
				"## Widget Preview Analysis",
				"",
				"### Component Tree",
				"```",
				tree,
				"```",
				"",
				`### Component Counts (${totalElements} total)`,
				countLines,
				"",
				`### State Keys (${stateKeys.length})`,
				stateKeys.length > 0
					? stateKeys.map((k) => `- \`${k}\``).join("\n")
					: "_No state defined._",
				"",
				"### Issues",
				issueLines,
				"",
				"### Preview URL",
				previewUrl,
			].join("\n");

			return {
				content: [{ type: "text" as const, text: markdown }],
				structuredContent: {
					tree,
					counts,
					stateKeys,
					issues,
					totalElements,
					previewUrl,
				},
			};
		},
	);

	agent.registeredTools.set("preview_widget", registeredTool);
	agent.appToolIds.add("preview_widget");

	console.log("[MCP] Registered tool: preview_widget");
}
