import { WorkApprovalCursorSchema } from "@tedix/api-contract/schemas/work-approvals";
import type { PlatformClient } from "./brain/platform-client";
import { type ToolSet, tool } from "ai";
import * as z from "zod";

/**
 * Native inference-only Work authority for one first-class tedi.
 *
 * This ToolSet is deliberately not passed to the public per-tedi MCP mount.
 * The platform API derives the tedi again from trusted service-binding headers
 * and enforces exact designation, active membership, version/expiry, and
 * requester separation.
 *
 * It carries no assigned-work lifecycle tools: Home starts, renews, and
 * settles a delegated run's Work Attempt below the model, so no facet turn
 * builds those tools.
 */
export function createWorkApprovalAiTools(
	getPlatform: () => Promise<PlatformClient | null>,
): ToolSet {
	const platform = async () => {
		const resolved = await getPlatform();
		if (!resolved) throw new Error("Tedi platform identity is unavailable");
		return resolved;
	};
	return {
		list_work_approval_inbox: tool({
			description:
				"List Work admission proposals designated to your exact tedi identity. Includes each current Work specification and admission resources/budget; compare its version with proposal.workItemVersion before deciding. This is not the organization audit ledger.",
			inputSchema: z.object({
				proposalId: z.string().uuid().optional(),
				workItemId: z.string().uuid().optional(),
				limit: z.number().int().min(1).max(50).optional(),
				cursor: WorkApprovalCursorSchema.optional(),
			}),
			execute: async (input) => (await platform()).listWorkApprovalInbox(input),
		}),
		decide_work_approval: tool({
			description:
				"Approve or reject one exact-version Work admission proposal designated to your tedi identity. Provide an independent rationale; requester self-approval is forbidden server-side.",
			inputSchema: z.object({
				proposalId: z.string().uuid(),
				expectedProposalVersion: z.number().int().positive(),
				decision: z.enum(["approved", "rejected"]),
				rationale: z.string().min(1).max(10_000),
			}),
			execute: async (input) => (await platform()).decideWorkApproval(input),
		}),
	};
}
