import { tool, type ToolSet } from "ai";
import * as z from "zod";
import { codeModeToolModelOutput } from "./codemode-model-output";

interface DurableCodemodeToolDependencies {
	run(input: { code: string }): Promise<unknown>;
	search(query: string): Promise<unknown>;
	describe(target: string): Promise<unknown>;
	getExecution(executionId: string): Promise<unknown>;
	listExecutions(limit: number): Promise<unknown>;
}

export function createDurableCodemodeTools(
	deps: DurableCodemodeToolDependencies,
): ToolSet {
	return {
		run_durable_code: tool({
			description:
				"Run a generated multi-tool program on your durable Code Mode runtime. Use this for 3+ calls, side effects, or work that may pause for approval; use a direct tool for one known call, stateless Code Mode for a bounded read-only batch, and a Workflow for known long-running orchestration.",
			inputSchema: z.object({ code: z.string().min(1).max(1_000_000) }),
			execute: (input) => deps.run(input),
			toModelOutput: codeModeToolModelOutput,
		}),
		search_durable_code: tool({
			description:
				"Search durable Code Mode connector methods and saved snippets. Results identify methods that require approval.",
			inputSchema: z.object({ query: z.string().min(1).max(500) }),
			execute: ({ query }) => deps.search(query),
		}),
		describe_durable_code: tool({
			description:
				"Get TypeScript documentation for one durable Code Mode connector method or saved snippet.",
			inputSchema: z.object({ target: z.string().min(1).max(500) }),
			execute: ({ target }) => deps.describe(target),
		}),
		get_code_execution: tool({
			description: "Read one durable Code Mode execution and replay log.",
			inputSchema: z.object({ execution_id: z.string().min(1) }),
			execute: ({ execution_id }) => deps.getExecution(execution_id),
		}),
		list_code_executions: tool({
			description: "List your durable Code Mode execution history.",
			inputSchema: z.object({
				limit: z.number().int().positive().max(100).optional(),
			}),
			execute: async ({ limit }) => ({
				executions: await deps.listExecutions(limit ?? 20),
			}),
		}),
	};
}
