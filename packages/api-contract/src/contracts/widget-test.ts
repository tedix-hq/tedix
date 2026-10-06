import "@orpc/openapi/extensions/route";
/**
 * Widget Test Contract for oRPC
 *
 * End-to-end widget testing: calls real MCP tool, renders widget
 * with real data via Puppeteer (Browser Rendering), takes screenshot,
 * and returns structural analysis + diagnostics.
 *
 * Two modes:
 * - `run`: Static screenshot — render + capture
 * - `runInteractive`: Multi-step interaction — click, type, assert, screenshot sequence
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	WidgetBrowserQaEvidenceSchema,
	WidgetVisualDiffSchema,
} from "../schemas/widget-test-runs";

const SpecIssueSchema = z.object({
	severity: z.enum(["error", "warning"]),
	message: z.string(),
});

// ---------------------------------------------------------------------------
// Interaction step schemas (discriminated union on `action`)
// ---------------------------------------------------------------------------

const ClickStepSchema = z.object({
	action: z.literal("click"),
	selector: z.string().optional().describe("CSS selector to click"),
	text: z
		.string()
		.optional()
		.describe("Button/element text to click (uses locator :has-text)"),
	index: z
		.number()
		.default(0)
		.describe("Which match to click when multiple elements match (0-indexed)"),
});

const TypeStepSchema = z.object({
	action: z.literal("type"),
	selector: z.string().describe("CSS selector of input element"),
	text: z.string().describe("Text to type"),
});

const PressStepSchema = z.object({
	action: z.literal("press"),
	key: z
		.string()
		.describe("Key to press (e.g. 'Escape', 'Enter', 'ArrowRight')"),
});

const WaitStepSchema = z.object({
	action: z.literal("wait"),
	ms: z
		.number()
		.min(100)
		.max(10000)
		.default(1000)
		.describe("Milliseconds to wait"),
});

const WaitForStepSchema = z.object({
	action: z.literal("waitFor"),
	selector: z.string().describe("CSS selector to wait for"),
	state: z
		.enum(["visible", "hidden", "attached", "detached"])
		.default("visible")
		.describe("Element state to wait for"),
	timeout: z.number().min(500).max(15000).default(5000),
});

const ScreenshotStepSchema = z.object({
	action: z.literal("screenshot"),
	label: z
		.string()
		.describe("Human-readable label for this screenshot (e.g. 'dialog-open')"),
	fullPage: z.boolean().default(true),
});

const AssertStepSchema = z.object({
	action: z.literal("assert"),
	selector: z.string().optional().describe("CSS selector to check"),
	visible: z
		.boolean()
		.optional()
		.describe("Assert element is visible (true) or hidden (false)"),
	text: z.string().optional().describe("Assert element contains this text"),
	count: z
		.number()
		.optional()
		.describe("Assert this many elements match the selector"),
});

const ScrollStepSchema = z.object({
	action: z.literal("scroll"),
	selector: z
		.string()
		.optional()
		.describe("CSS selector of scrollable container (default: window)"),
	x: z.number().default(0),
	y: z.number().default(300).describe("Pixels to scroll vertically"),
});

export const InteractionStepSchema = z.discriminatedUnion("action", [
	ClickStepSchema,
	TypeStepSchema,
	PressStepSchema,
	WaitStepSchema,
	WaitForStepSchema,
	ScreenshotStepSchema,
	AssertStepSchema,
	ScrollStepSchema,
]);

export type InteractionStep = z.infer<typeof InteractionStepSchema>;

const StepResultSchema = z.object({
	step: z.number(),
	action: z.string(),
	label: z.string().optional(),
	success: z.boolean(),
	error: z.string().optional(),
	screenshotUrl: z.string().optional(),
	durationMs: z.number(),
});

export const widgetTestContract = oc
	.route({ tags: ["internal", "widget-test"] })
	.router({
		/**
		 * Run a full end-to-end widget test:
		 * 1. Connect to real MCP server
		 * 2. Call tool with real args → get real data
		 * 3. Merge data into layoutSpec
		 * 4. Render widget with Puppeteer (headless)
		 * 5. Screenshot + structural analysis
		 */
		run: oc
			.input(
				z.object({
					appSlug: z.string().describe("App slug (MCP subdomain)"),
					toolName: z.string().describe("MCP tool name to invoke"),
					toolArgs: z
						.record(z.string(), z.unknown())
						.default({})
						.describe("Tool arguments (real query, params, etc.)"),
					viewport: z
						.object({
							width: z.number().min(320).max(1920).default(420),
							height: z.number().min(320).max(1200).default(800),
						})
						.optional()
						.describe("Browser viewport size (defaults to 420x800 mobile)"),
					format: z.enum(["png", "jpeg"]).default("png"),
					waitMs: z
						.number()
						.min(0)
						.max(15000)
						.default(3000)
						.describe(
							"Extra wait after network idle for animations/lazy loading",
						),
				}),
			)
			.output(
				z.object({
					screenshotUrl: z
						.string()
						.describe("Public R2 URL to the rendered screenshot"),
					previewUrl: z
						.string()
						.describe("Live preview URL for manual/Chrome DevTools inspection"),
					mimeType: z.string(),
					toolResult: z.object({
						contentSummary: z
							.string()
							.describe("Text summary of the MCP tool response"),
						dataKeys: z
							.array(z.string())
							.describe("Top-level keys in the tool output data"),
						itemCount: z
							.number()
							.optional()
							.describe("Number of items if result contains an array"),
						isError: z.boolean().optional(),
					}),
					widgetAnalysis: z.object({
						componentTree: z.string(),
						totalElements: z.number(),
						stateKeys: z.array(z.string()),
						dataBindings: z
							.array(z.string())
							.describe("All $state paths found in the spec"),
						issues: z.array(SpecIssueSchema),
					}),
					domSummary: z.object({
						title: z.string().optional(),
						elementCount: z.number(),
						textContent: z
							.string()
							.describe("Visible text content (first 3000 chars)"),
						errors: z
							.array(z.string())
							.describe("Browser console errors during render"),
						qaEvidence: WidgetBrowserQaEvidenceSchema,
					}),
					visualDiff: WidgetVisualDiffSchema.nullable().describe(
						"Screenshot comparison against the latest promoted or passed baseline run, when available",
					),
					renderTimeMs: z.number(),
				}),
			),

		/**
		 * Run an interactive widget test with multi-step interactions:
		 * 1. Connect to real MCP server, call tool → get real data
		 * 2. Render widget with Firecrawl Browser Sandbox (Playwright)
		 * 3. Execute interaction steps (click, type, scroll, assert, screenshot)
		 * 4. Return ordered screenshot sequence + assertion results
		 */
		runInteractive: oc
			.input(
				z.object({
					appSlug: z.string().describe("App slug (MCP subdomain)"),
					toolName: z.string().describe("MCP tool name to invoke"),
					toolArgs: z
						.record(z.string(), z.unknown())
						.default({})
						.describe("Tool arguments (real query, params, etc.)"),
					viewport: z
						.object({
							width: z.number().min(320).max(1920).default(420),
							height: z.number().min(320).max(1200).default(800),
						})
						.optional()
						.describe("Browser viewport size (defaults to 420x800 mobile)"),
					steps: z
						.array(InteractionStepSchema)
						.min(1)
						.max(20)
						.describe(
							"Ordered interaction steps to execute after widget renders",
						),
					waitMs: z
						.number()
						.min(0)
						.max(15000)
						.default(3000)
						.describe("Extra wait after data injection before running steps"),
				}),
			)
			.output(
				z.object({
					previewUrl: z.string(),
					toolResult: z.object({
						contentSummary: z.string(),
						dataKeys: z.array(z.string()),
						itemCount: z.number().optional(),
						isError: z.boolean().optional(),
					}),
					steps: z.array(StepResultSchema),
					screenshots: z
						.array(
							z.object({
								label: z.string(),
								url: z.string(),
								mimeType: z.string(),
							}),
						)
						.describe("Ordered screenshots captured during the test"),
					domSummary: z.object({
						title: z.string().optional(),
						elementCount: z.number(),
						textContent: z.string(),
						errors: z.array(z.string()),
						qaEvidence: WidgetBrowserQaEvidenceSchema,
					}),
					totalDurationMs: z.number(),
				}),
			),
	});

export type WidgetTestContract = typeof widgetTestContract;
