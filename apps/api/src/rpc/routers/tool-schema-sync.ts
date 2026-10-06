/**
 * Tool schema sync router.
 *
 * This is the API/MCP-callable control plane for regenerating app_tools schemas
 * from source contracts. The old CLI remains a thin wrapper around this path.
 */

import { implement } from "@orpc/server";
import {
	type ToolSchemaSyncInput,
	toolSchemaSyncContract,
} from "@tedix/api-contract/contracts/tool-schema-sync";
import {
	AUTHZ,
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

type WorkflowBinding = {
	create(input: { params: ToolSchemaSyncInput }): Promise<{ id: string }>;
};

const toolSchemaSyncOs = implement(
	toolSchemaSyncContract,
).$context<BaseContext>();
const authed = toolSchemaSyncOs.use(withAuth).use(withFleetAuthority);

export const toolSchemaSyncContractRouter = toolSchemaSyncOs.router({
	preview: authed.preview
		.use(withAuthorization("apps:update", "tools:read"))
		.handler(async ({ input, context }) => {
			// Contract projection traverses the complete contract registry. Keep
			// that work off the startup path for ordinary API isolates.
			const { runToolSchemaSync } =
				await import("../../services/tool-schema-sync");
			return runToolSchemaSync(context.db, { ...input, apply: false });
		}),

	check: authed.check
		.use(withAuthorization("apps:update", "tools:read"))
		.handler(async ({ input, context }) => {
			const { runToolSchemaSync } =
				await import("../../services/tool-schema-sync");
			const result = await runToolSchemaSync(context.db, {
				...input,
				apply: false,
			});
			const blocking = result.items.filter((item) => item.status !== "inSync");
			const passed = blocking.length === 0;
			return {
				passed,
				message: passed
					? `All ${result.inSync} ${result.source} tool schemas are in sync.`
					: `${blocking.length} ${result.source} tool schema issue(s) found.`,
				result,
			};
		}),

	run: authed.run.use(AUTHZ.toolsWrite).handler(async ({ input, context }) => {
		const workflow = (
			context.env as CloudflareEnv & {
				TOOL_SCHEMA_SYNC_WORKFLOW?: WorkflowBinding;
			}
		).TOOL_SCHEMA_SYNC_WORKFLOW;

		if (!workflow) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"TOOL_SCHEMA_SYNC_WORKFLOW not configured",
			);
		}

		const params: ToolSchemaSyncInput = {
			...input,
			apply: input.apply ?? true,
		};
		const instance = await workflow.create({ params });
		return {
			workflowId: instance.id,
			status: "queued" as const,
			message: `Tool schema sync queued for app ${params.appId ?? "tedix"}`,
		};
	}),
});
