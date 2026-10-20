import { tool, type ToolSet } from "ai";
import * as z from "zod";
import type { PlatformClient } from "./brain/platform-client";

/** No public MCP mount and no ambient Work write credential. The API rechecks
 * the persisted Home tuple, requesting owner, project, policy, and settled SHA. */
export function delegatedWorkTools(input: {
	getPlatform: () => Promise<PlatformClient | null>;
	homeRunId: string;
	runId: string;
	linkedWorkItemId: string;
}) {
	return {
		close_completed_work_item: tool({
			description:
				"Complete one accepted coding Work item and add a one-line closing SHA comment, only in the project explicitly requested by Home. First inspect its latest settled successful Attempt and verify the full SHA is on origin/main. Failed/partial work, active Attempts, other projects and this delegation's own Work are forbidden. Home manages this delegation's lifecycle.",
			inputSchema: z.object({
				id: z.string().uuid(),
				sha: z.string().regex(/^[a-f\d]{40}$/i),
			}),
			needsApproval: true,
			execute: async ({ id, sha }) => {
				const platform = await input.getPlatform();
				if (!platform) throw new Error("Tedi platform identity is unavailable");
				return platform.closeoutDelegatedWorkItem({
					id,
					sha,
					homeRunId: input.homeRunId,
					runId: input.runId,
					linkedWorkItemId: input.linkedWorkItemId,
				});
			},
		}),
	} satisfies ToolSet;
}
