/**
 * AI-Powered Tool Evaluator
 *
 * Uses Cloudflare Workers AI to:
 * - Generate realistic test inputs for MCP tools
 * - Evaluate tool selection accuracy (measures "tool ergonomics")
 * - Score tool description clarity
 */

import { safeErrorMetadata, safeTextMetadata } from "./safe-log-metadata";

// JSON Schema type (simplified for MCP tools)
export interface JSONSchema {
	type?: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	items?: JSONSchema;
	description?: string;
	enum?: unknown[];
	default?: unknown;
	[key: string]: unknown;
}

// Cloudflare Workers AI binding type (compatible with CloudflareEnv.AI)
type Ai = {
	run(
		model: string,
		input: {
			messages: Array<{ role: string; content: string }>;
			max_tokens?: number;
			temperature?: number;
		},
		requestOptions?: {
			gateway?: { id: string; metadata?: Record<string, string> };
		},
	): Promise<{ response?: string } & Record<string, unknown>>;
};

export interface ToolEvaluatorAiContext {
	gatewayId?: string;
}

// Generative model for smart test-input construction; semantic scoring uses Jev.
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default timeout for AI calls (30 seconds)
const AI_TIMEOUT_MS = 30_000;

// Approximate token estimation (rough: ~4 chars per token)
function estimateTokens(text: string | undefined | null): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Helper to run AI with timeout and error handling
 */
async function runAiWithTimeout(
	ai: Ai,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
	context?: ToolEvaluatorAiContext,
): Promise<{ response: string | null; tokensUsed: number }> {
	const inputTokens = estimateTokens(
		messages.map((m) => m.content || "").join("\n"),
	);

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			ai.run(
				AI_MODEL,
				{ messages, max_tokens: maxTokens },
				context?.gatewayId
					? {
							gateway: {
								id: context.gatewayId,
								metadata: { surface: "tool-evaluator" },
							},
						}
					: undefined,
			),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error("AI timeout")),
					AI_TIMEOUT_MS,
				);
			}),
		]);

		const response = result?.response ?? null;
		const outputTokens = response ? estimateTokens(response) : 0;
		const usage = result.usage as
			| {
					prompt_tokens?: number;
					completion_tokens?: number;
					total_tokens?: number;
			  }
			| undefined;
		const reportedTotal =
			usage?.total_tokens ??
			(typeof usage?.prompt_tokens === "number" &&
			typeof usage?.completion_tokens === "number"
				? usage.prompt_tokens + usage.completion_tokens
				: undefined);

		return {
			response,
			tokensUsed:
				typeof reportedTotal === "number" &&
				Number.isFinite(reportedTotal) &&
				reportedTotal >= 0
					? reportedTotal
					: inputTokens + outputTokens,
		};
	} catch (error) {
		const prompt = messages.map((message) => message.content || "").join("\n");
		console.error("[ToolEvaluator] AI call failed", {
			model: AI_MODEL,
			messageCount: messages.length,
			prompt: await safeTextMetadata(prompt),
			maxTokens,
			error: await safeErrorMetadata(error),
		});
		return { response: null, tokensUsed: inputTokens };
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Parse JSON from AI response, handling markdown code blocks
 */
function parseJsonResponse<T>(response: string | null): T | null {
	if (!response) return null;

	try {
		// Try direct parse first
		return JSON.parse(response) as T;
	} catch {
		// Try extracting from markdown code block
		const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (codeBlockMatch?.[1]) {
			try {
				return JSON.parse(codeBlockMatch[1].trim()) as T;
			} catch {
				// Fall through
			}
		}

		// Try finding JSON object/array in the response
		const jsonMatch = response.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
		if (jsonMatch?.[1]) {
			try {
				return JSON.parse(jsonMatch[1]) as T;
			} catch {
				// Fall through
			}
		}
	}

	return null;
}

// =============================================================================
// 1. SMART TEST INPUT GENERATOR
// =============================================================================

export interface GenerateSmartTestInputResult {
	input: Record<string, unknown>;
	prompt: string;
	tokensUsed: number;
}

/**
 * Generate realistic test inputs for an MCP tool using AI
 *
 * @param ai - Cloudflare Workers AI binding
 * @param tool - Tool definition with name, description, and input schema
 * @returns Generated test input, the prompt used, and token usage
 */
export async function generateSmartTestInput(
	ai: Ai,
	tool: {
		name: string;
		description?: string;
		inputSchema?: JSONSchema;
	},
	context?: ToolEvaluatorAiContext,
): Promise<GenerateSmartTestInputResult> {
	const systemPrompt =
		"Generate a realistic test input for an MCP tool. Return ONLY valid JSON that matches the schema. Use realistic values that a real user might provide. Do not include any explanation or markdown - just the JSON object.";

	const userPrompt = `Tool: ${tool.name}
Description: ${tool.description || "No description provided"}
Schema: ${JSON.stringify(tool.inputSchema || { type: "object", properties: {} }, null, 2)}

Generate a realistic test input:`;

	const { response, tokensUsed } = await runAiWithTimeout(
		ai,
		[
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
		500,
		context,
	);

	const input = parseJsonResponse<Record<string, unknown>>(response);

	return {
		input: input ?? generateFallbackInput(tool.inputSchema),
		prompt: userPrompt,
		tokensUsed,
	};
}

/**
 * Generate fallback input based on schema when AI fails
 */
function generateFallbackInput(schema?: JSONSchema): Record<string, unknown> {
	if (!schema?.properties) return {};

	const result: Record<string, unknown> = {};

	for (const [key, propSchema] of Object.entries(schema.properties)) {
		if (propSchema.default !== undefined) {
			result[key] = propSchema.default;
		} else if (propSchema.enum && propSchema.enum.length > 0) {
			result[key] = propSchema.enum[0];
		} else {
			switch (propSchema.type) {
				case "string":
					result[key] = `test_${key}`;
					break;
				case "number":
				case "integer":
					result[key] = 1;
					break;
				case "boolean":
					result[key] = true;
					break;
				case "array":
					result[key] = [];
					break;
				case "object":
					result[key] = {};
					break;
				default:
					result[key] = null;
			}
		}
	}

	return result;
}
