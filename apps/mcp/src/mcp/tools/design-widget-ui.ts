/**
 * Design Widget UI Tool
 *
 * MCP tool that uses tedi enrichment to generate json-render
 * layout specs for widget UIs. Falls back to tedi enrichment when sampling
 * is unavailable.
 *
 * @module @tedix/mcp/mcp/tools/design-widget-ui
 */

import * as z from "zod";
import type { ToolAuthShape } from "@tedix/mcp-shared/auth/tool-scopes";
import {
	LAYOUT_CATALOG_PROMPT,
	LAYOUT_CATALOG_YAML_PROMPT,
} from "@tedix/api-contract/generated/layout-catalog-prompt";
import type { ServerContext, AppTool } from "../server-context";
import { enforceMcpToolScopeAuthorization } from "../codemode-auth";
import {
	buildEditUserPrompt,
	formatSpecIssues,
	isNonEmptySpec,
	validateSpec,
} from "@json-render/core";
import type { EditMode, Spec, SpecIssue } from "@json-render/core";
import { parseSpec } from "../utils/spec-assembler";
import { contentFreeMcpException, createMcpLogger } from "../../log";

const log = createMcpLogger("mcp.widget.design");

const DESIGN_WIDGET_UI_REQUIRED_SCOPES = ["mcp:apps.write"] as const;
const DESIGN_WIDGET_UI_AUTH = {
	toolId: "design_widget_ui",
	authRequired: true,
	visibility: "private",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		openWorldHint: true,
	},
} satisfies ToolAuthShape;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Structural issue codes that make a spec render blank or drop a branch, as
 * opposed to cosmetic problems. json-render 0.20 added the four repeat/visible
 * codes; these are worth one regeneration round because the model can fix them
 * from the message alone, and shipping them produces a widget that silently
 * shows nothing.
 */
const BLANK_RENDER_ISSUE_CODES: ReadonlySet<SpecIssue["code"]> = new Set([
	"missing_root",
	"root_not_found",
	"missing_child",
	"empty_spec",
	"invalid_visible",
	"repeat_without_children",
	"repeat_item_outside_scope",
	"repeat_state_mismatch",
]);

/**
 * Safely truncate a JSON-serializable value to a character limit.
 */
function truncateJson(value: unknown, maxChars: number): string {
	const str =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	if (!str) return "";
	return str.length > maxChars
		? `${str.slice(0, maxChars)}... [truncated]`
		: str;
}

/**
 * Build the design prompt combining the layout catalog, tool info, sample data,
 * and the caller's design goal.
 */
function buildDesignPrompt(params: {
	tool: AppTool;
	sampleData?: Record<string, unknown>;
	designGoal?: string;
	currentSpec?: Record<string, unknown>;
	editMode?: "patch" | "merge" | "diff";
}): string {
	const { tool, sampleData, designGoal, currentSpec, editMode } = params;

	// Edit mode: use buildEditUserPrompt for multi-turn refinement
	if (currentSpec && isNonEmptySpec(currentSpec as unknown as Spec)) {
		const editInstruction = designGoal ?? "Refine this widget UI.";
		const mode: EditMode = (editMode ?? "merge") as EditMode;

		return buildEditUserPrompt({
			prompt: editInstruction,
			currentSpec: currentSpec as unknown as Spec,
			config: { modes: [mode] },
			format: "yaml",
		});
	}

	// New spec: use YAML catalog prompt
	const lines: (string | undefined)[] = [
		LAYOUT_CATALOG_YAML_PROMPT,
		"",
		"---",
		"",
		"DESIGN TASK:",
		"",
		`Tool: ${tool.toolId}`,
		`Title: ${tool.title}`,
		tool.description ? `Description: ${tool.description}` : undefined,
		"",
		tool.outputSchema
			? `Output Schema:\n\`\`\`json\n${truncateJson(tool.outputSchema, 2000)}\n\`\`\``
			: undefined,
		"",
		sampleData
			? `Sample Data:\n\`\`\`json\n${truncateJson(sampleData, 4000)}\n\`\`\``
			: undefined,
		"",
		designGoal
			? `Design Goal: ${designGoal}`
			: "Design Goal: Create a clean, functional widget UI that displays the tool's output data effectively.",
		"",
		"Generate a json-render spec using YAML format.",
		"Include realistic sample data in the state based on the output schema and sample data provided.",
	];

	return lines.filter((line) => line !== undefined).join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `design_widget_ui` tool on the MCP server.
 *
 * Uses the tedi-enrichment path to generate json-render layout specs.
 * Falls back to tedi enrichment via the API if sampling is unavailable.
 */
export function registerDesignWidgetUiTool(agent: ServerContext): void {
	const registeredTool = agent.server.registerTool(
		"design_widget_ui",
		{
			title: "Design Widget UI",
			description:
				"Design a json-render widget UI for a tool's output. Uses AI to generate a layout spec with components, state bindings, and sample data. Returns the spec and a preview URL.",
			inputSchema: {
				toolId: z
					.string()
					.describe("The target tool's toolId to design a widget for"),
				appId: z.string().uuid().describe("The app UUID that owns the tool"),
				sampleData: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Sample output data from the tool to inform the UI design"),
				designGoal: z
					.string()
					.optional()
					.describe("Natural language description of the desired UI design"),
				currentSpec: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						"Existing layout spec to refine (enables edit mode instead of generating from scratch)",
					),
				editMode: z
					.enum(["patch", "merge", "diff"])
					.optional()
					.describe(
						"Edit strategy when refining currentSpec. Default: merge (RFC 7396 deep merge)",
					),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: true,
			},
		},
		async ({
			toolId,
			appId,
			sampleData,
			designGoal,
			currentSpec,
			editMode,
		}) => {
			const scopeDenial = enforceMcpToolScopeAuthorization(
				agent,
				DESIGN_WIDGET_UI_AUTH,
				"apps",
				DESIGN_WIDGET_UI_REQUIRED_SCOPES,
			);
			if (scopeDenial) return scopeDenial;

			// 1. Find the target tool
			let tool: AppTool | undefined = agent.loadedTools.get(toolId);

			if (!tool) {
				try {
					const result = await agent.apiClient.appTools.get({
						appId,
						toolId,
					});
					if (result) {
						tool = result as unknown as AppTool;
					}
				} catch (error) {
					log.warn("Widget design tool lookup failed", {
						event: "widget.design_tool_lookup_failed",
						outcome: "unavailable",
						error: contentFreeMcpException(error),
					});
				}
			}

			if (!tool) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Tool not found: "${toolId}" in app "${appId}". Use list tools to see available tools.`,
						},
					],
					isError: true,
				};
			}

			// 2. Build the design prompt
			const prompt = buildDesignPrompt({
				tool,
				sampleData,
				designGoal,
				currentSpec,
				editMode,
			});

			// 3. Generate the layout spec via the tedi-enrichment path. MCP sampling
			// (`sampling/createMessage`) is removed here — it is deprecated in the
			// 2026-07-28 revision in favor of direct integration.
			let spec: Spec | null = null;
			const tediId = agent.appMetadata?.mcpConfig?.tediPolicy?.tediId;

			/**
			 * One enrichment round. Extracted so the validation step below can
			 * spend exactly one more round repairing a spec that would render
			 * blank, instead of returning it with a warning nobody acts on.
			 */
			const runEnrichment = async (goal: string): Promise<Spec | null> => {
				if (!tediId) return null;
				try {
					const { invokeTediEnrichment, buildEnrichmentRequest } =
						await import("../tedi-enrichment");

					const enrichmentReq = buildEnrichmentRequest({
						tediId,
						appId,
						toolId: tool.toolId,
						toolTitle: tool.title,
						args: { designGoal: goal },
						rawResult: sampleData ?? {},
						appSlug: agent.appSlug,
						vertical: undefined,
						callerIdentity: agent.callerIdentity
							? {
									authType:
										agent.callerIdentity.authType === "anonymous"
											? "anonymous"
											: "oauth",
									userId: agent.callerIdentity.userId,
									scopes: agent.callerIdentity.scopes,
								}
							: undefined,
						policy: {
							allowedEnrichmentTools: ["memory_search", "memory_learn"],
							blockedEnrichmentTools: [],
							maxEnrichmentTokens: 8192,
							enrichmentTimeoutMs: 30_000,
						},
					});

					const enrichmentResult = await invokeTediEnrichment(
						agent.env,
						enrichmentReq,
					);

					if (enrichmentResult?.layoutSpec) {
						return enrichmentResult.layoutSpec as Spec;
					}
					if (enrichmentResult?.textContent) {
						return parseSpec(enrichmentResult.textContent);
					}
					return null;
				} catch (error) {
					log.warn("Widget design enrichment failed", {
						event: "widget.design_enrichment_failed",
						outcome: "unavailable",
						error: contentFreeMcpException(error),
					});
					return null;
				}
			};

			spec = await runEnrichment(designGoal ?? "Generate widget UI");

			// 5. Validate the spec
			if (!isNonEmptySpec(spec)) {
				return {
					content: [
						{
							type: "text" as const,
							text: [
								"## Design Failed",
								"",
								"Could not generate a valid layout spec for this tool.",
								"The tedi-enrichment path did not return a valid layout spec.",
								"",
								"Try providing more detailed `sampleData` or a clearer `designGoal`.",
							].join("\n"),
						},
					],
					isError: true,
				};
			}

			// 6. Validate with @json-render/core, and spend one repair round on a
			// spec that would render blank. Returning such a spec with a warning
			// buried in the summary means the operator only finds out when the
			// widget shows nothing.
			const validationIssues: string[] = [];
			let validationResult = validateSpec(spec as never);
			if (!validationResult.valid && validationResult.issues) {
				const blocking = validationResult.issues.filter((item) =>
					BLANK_RENDER_ISSUE_CODES.has(item.code),
				);
				if (blocking.length > 0 && tediId) {
					const repaired = await runEnrichment(
						[
							designGoal ?? "Generate widget UI",
							"",
							"The previous attempt produced a spec that fails structural",
							"validation and would render blank. Fix exactly these issues:",
							formatSpecIssues(blocking),
						].join("\n"),
					);
					if (repaired && isNonEmptySpec(repaired)) {
						const recheck = validateSpec(repaired as never);
						// Keep the repair only if it is a genuine improvement.
						if (
							recheck.valid ||
							(recheck.issues ?? []).filter((item) =>
								BLANK_RENDER_ISSUE_CODES.has(item.code),
							).length < blocking.length
						) {
							spec = repaired;
							validationResult = recheck;
						}
					}
				}
			}
			if (!validationResult.valid && validationResult.issues) {
				validationIssues.push(
					...validationResult.issues.map((i: { message: string }) => i.message),
				);
			}

			// 7. Build response
			const elementCount = Object.keys(spec.elements).length;
			const stateKeys = spec.state ? Object.keys(spec.state) : [];
			const specJson = JSON.stringify(spec);
			let specBinary = "";
			for (const byte of new TextEncoder().encode(specJson)) {
				specBinary += String.fromCharCode(byte);
			}
			const previewUrl =
				specJson.length <= 8000
					? `${agent.getWidgetDomain()}/${agent.appSlug}/r/preview?spec=${encodeURIComponent(btoa(specBinary))}`
					: `${agent.getWidgetDomain()}/${agent.appSlug}/r/preview (spec too large for URL — use preview_widget tool with the spec object)`;

			const summaryLines = [
				"## Widget UI Designed",
				"",
				`**Tool:** ${tool.title} (\`${tool.toolId}\`)`,
				`**Elements:** ${elementCount}`,
				`**State keys:** ${stateKeys.length > 0 ? stateKeys.map((k) => `\`${k}\``).join(", ") : "none"}`,
				`**Method:** Tedi enrichment`,
				"",
			];

			if (validationIssues.length > 0) {
				// A blank-render issue that survived the repair round is not a
				// warning — the widget will show nothing. Label it so the caller
				// cannot mistake it for cosmetic drift.
				const stillBlank = (validationResult.issues ?? []).some((item) =>
					BLANK_RENDER_ISSUE_CODES.has(item.code),
				);
				summaryLines.push(
					stillBlank
						? "### Validation Errors — this spec will render blank"
						: "### Validation Warnings",
					...validationIssues.map((msg) => `- ${msg}`),
					"",
				);
			}

			summaryLines.push(
				"### Preview",
				previewUrl,
				"",
				"### Next Steps",
				"1. Open the preview URL to see the rendered widget",
				"2. Use `preview_widget` to analyze the spec structure",
				"3. Refine the spec by calling this tool again with `currentSpec` and a new `designGoal` (YAML edit mode)",
				"4. Attach the spec to the tool via `update_tool` with `config.layoutSpec`",
				'5. Set `widgetKey: "render"` on the tool to enable widget rendering',
				"",
				"*Specs are generated in YAML format. Pass the returned spec as `currentSpec` for iterative refinement.*",
			);

			return {
				content: [{ type: "text" as const, text: summaryLines.join("\n") }],
				structuredContent: {
					spec,
					elementCount,
					stateKeys,
					previewUrl,
					validationIssues,
					method: "enrichment",
				},
			};
		},
	);

	agent.registeredTools.set("design_widget_ui", registeredTool);
	agent.appToolIds.add("design_widget_ui");

	console.log("[MCP] Registered tool: design_widget_ui");
}
