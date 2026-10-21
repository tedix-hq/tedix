import * as z from "zod";
import {
	type PromptCallback,
	wrapPromptGetTelemetry,
} from "./middleware/prompts-telemetry";
import type { ServerContext } from "./server-context";
import { jsonSchemaToToolInputSchema } from "./utils/schema";

/**
 * Register app prompts from D1 app_tools rows with toolTypeId="prompt".
 *
 * Each prompt tool defines:
 *   - toolId: prompt name
 *   - title / description: shown in the host's prompt picker
 *   - inputSchema: prompt arguments (always rendered as strings per MCP spec)
 *   - config.template: template string with {{argName}} substitution placeholders
 */
export async function registerAppPrompts(agent: ServerContext): Promise<void> {
	const promptTools = Array.from(agent.loadedTools.values()).filter(
		(t) => t.toolTypeId === "prompt",
	);

	if (promptTools.length === 0) return;

	console.log(`[MCP] Registering ${promptTools.length} prompt(s)`);

	for (const tool of promptTools) {
		const config = (tool.config ?? {}) as Record<string, unknown>;
		const template = config.template;
		if (typeof template !== "string") {
			console.warn(
				`[registerAppPrompts] Skipping "${tool.toolId}": missing template string in config`,
			);
			continue;
		}

		// Build argsSchema — MCP prompt args are always strings
		const argsSchema: Record<string, z.ZodString> = {};
		const inputMap = jsonSchemaToToolInputSchema(tool.inputSchema);
		if (inputMap) {
			for (const [key, field] of Object.entries(inputMap)) {
				argsSchema[key] = z.string().describe(field.description ?? key);
			}
		}

		const promptCb: PromptCallback = (args) => {
			let text = template;
			for (const [key, value] of Object.entries(
				args as Record<string, string>,
			)) {
				text = text.replaceAll(`{{${key}}}`, value);
			}

			return {
				messages: [
					{
						role: "user" as const,
						content: { type: "text" as const, text },
					},
				],
			};
		};

		const registered = agent.server.registerPrompt(
			tool.toolId,
			{
				title: tool.title,
				description: tool.description ?? tool.title,
				argsSchema: z.object(argsSchema),
				// SEP-973: surface prompt icons when the D1 row carries them.
				...(tool.icons ? { icons: tool.icons } : {}),
			},
			wrapPromptGetTelemetry(
				tool.toolId,
				agent,
				promptCb,
			) as unknown as Parameters<typeof agent.server.registerPrompt>[2],
		);

		agent.registeredPrompts.set(tool.toolId, registered);
	}
}
