import "@orpc/openapi/extensions/route";
/**
 * MCP Eval Contract for oRPC
 * Async LLM-powered MCP tool routing evaluation
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	CLOUDFLARE_AUTO_MODEL_REF,
	ModelRefSchema,
	findCatalogEntry,
	parseModelRef,
} from "../schemas/model-catalog";

// =============================================================================
// SCHEMAS
// =============================================================================

const EvalTestSchema = z.object({
	title: z.string().describe("Test case name"),
	prompt: z.string().describe("User prompt to send to the LLM"),
	expectedTools: z.array(z.string()).describe("Tools expected to be called"),
});

export const RunEvalInputSchema = z.object({
	appSlug: z.string().min(1).describe("App slug to evaluate"),
	model: ModelRefSchema.refine(
		(ref) =>
			!!findCatalogEntry(ref) &&
			["cloudflare", "azure-openai", "workers-ai"].includes(
				parseModelRef(ref)?.provider ?? "",
			),
		{
			message:
				"Evaluation requires a catalogued model supported by kernel transport",
		},
	)
		.default(CLOUDFLARE_AUTO_MODEL_REF)
		.describe("Configured model ref; defaults to Cloudflare Auto Router"),
	customTests: z
		.array(EvalTestSchema)
		.optional()
		.describe("Custom test cases (if omitted, auto-generates from tool list)"),
});

const EvalResultSchema = z.object({
	jobId: z.string(),
	status: z.enum(["pending", "running", "completed", "failed"]),
	message: z.string(),
});

// =============================================================================
// CONTRACT
// =============================================================================

export const mcpEvalContract = oc
	.route({ tags: ["mcp-eval", "internal"] })
	.router({
		run: oc
			.route({
				method: "POST",
				path: "/mcp-eval/run",
				summary: "Run MCP eval",
				description:
					"Start an async LLM-powered evaluation of an app's MCP tool routing. Returns a jobId for polling via get_job_status.",
			})
			.input(RunEvalInputSchema)
			.output(EvalResultSchema),
	});

export type McpEvalContract = typeof mcpEvalContract;
