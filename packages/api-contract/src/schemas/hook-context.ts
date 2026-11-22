import type { InferContractRouterOutputs } from "@orpc/contract";
import type { osWorkspacesContract } from "../contracts/os-workspaces";
import type { workItemsContract } from "../contracts/work-items";
import type { workAgentSessionsContract } from "../contracts/work-agent-sessions";
import type { agentTurnTriageContract } from "../contracts/agent-turn-triage";
import type { projectsContract } from "../contracts/projects";
import type { tediObjectivesContract } from "../contracts/tedi-objectives";

import { z } from "zod";
import { GetAgentSessionLessonsInputSchema } from "./agent-session-lessons";

const id = z.string().uuid();
export const HookWorkBoundaryInputSchema = z
	.object({ workItemId: id })
	.strict();
export const HookTurnContextInputSchema = z
	.object({
		osWorkspaceId: id.nullish(),
		contextOutputId: id.nullish(),
		workItemId: id.nullish(),
		preferencesWorkspaceId: id.nullish(),
		preferencesOutputId: id.nullish(),
		lessons: GetAgentSessionLessonsInputSchema.optional(),
		delegations: z.array(id).max(8).optional(),
		requests: z
			.object({
				session: id,
				harness: z.string().max(50).optional(),
				projectId: id.optional(),
			})
			.strict()
			.optional(),
		nextWork: z
			.object({
				projectId: id,
				harness: z.enum(["codex", "claude-code", "devin"]),
				selected: id.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type HookTurnContextInput = z.infer<typeof HookTurnContextInputSchema>;

type Work = InferContractRouterOutputs<typeof workItemsContract>;
type Os = InferContractRouterOutputs<typeof osWorkspacesContract>;
export interface HookContextSources {
	"os.get_os_workspace": Os["workspaces"]["get"];
	"os.get_os_output": Os["outputs"]["get"];
	"work.get_work_items_by_id": Work["getById"];
	"work.list_work_items": Work["list"];
	"work.list_work_item_cli_rows": Work["listCliProjection"];
	"work.list_agent_session_requests": InferContractRouterOutputs<
		typeof workAgentSessionsContract
	>["listRequests"];
	"agent.get_agent_session_lessons": InferContractRouterOutputs<
		typeof agentTurnTriageContract
	>["getSessionLessons"];
	"projects.get_project": InferContractRouterOutputs<
		typeof projectsContract
	>["get"];
	"tedis.get_tedi_objectives_by_id": InferContractRouterOutputs<
		typeof tediObjectivesContract
	>["getById"];
}
