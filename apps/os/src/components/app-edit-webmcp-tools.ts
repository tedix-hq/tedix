import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { osAppRuntimeContract } from "@tedix/api-contract/contracts/os-app-runtime";
import { webMcpResult } from "@tedix/webmcp-core/model-context";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import {
	contractInputSchema,
	deriveToolSchema,
} from "@/lib/webmcp/derive-schema";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";
import { registerPageChatTools } from "@/lib/page-chat-tools";
import { toWebMcpFailure } from "@/components/webmcp-execute";

export function buildAppEditTools(
	workspaceId: string,
	conversationId: string,
	onProposed: () => Promise<unknown>,
): WebMcpToolDef[] {
	const deepLink = `/workspace/${workspaceId}`;
	return [
		{
			name: "read_app_files",
			description:
				"Read the current app manifest and source files before proposing an edit. Use an app id from get_workspace_overview.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: {
				type: "object",
				properties: {
					gadgetId: {
						type: "string",
						description: "The runtime app id in this workspace.",
					},
				},
				required: ["gadgetId"],
				additionalProperties: false,
			},
			execute: async (args) => {
				try {
					const { osApi } = await import("@/lib/api");
					const scope = { workspaceId, gadgetId: String(args.gadgetId) };
					const { gadget, currentRevision } =
						await osApi.osWorkspaces.gadgets.get(scope);
					if (!currentRevision) throw new Error("App has no revision");
					const { code } = await osApi.osWorkspaces.gadgets.getCode({
						...scope,
						revisionId: currentRevision.id,
					});
					return webMcpResult(
						{
							gadgetId: gadget.id,
							revisionId: currentRevision.id,
							manifest: currentRevision.manifest,
							files: code?.files ?? null,
						},
						deepLink,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "propose_app_edit",
			description:
				"Propose exact text replacements in the current app files. Read files first. Saves a draft for Preview and Accept; the live app keeps running.",
			annotations: { readOnlyHint: false },
			inputSchema: deriveToolSchema(
				contractInputSchema(osAppRuntimeContract.proposeEdit),
				{ pick: ["gadgetId", "expectedRevisionId", "edits"] },
			),
			execute: async (args) => {
				try {
					const { osApi } = await import("@/lib/api");
					const result = await osApi.osAppRuntime.proposeEdit({
						workspaceId,
						conversationId,
						gadgetId: String(args.gadgetId),
						expectedRevisionId: String(args.expectedRevisionId),
						edits: args.edits as Array<{
							path: string;
							before: string;
							after: string;
						}>,
					});
					await onProposed();
					return webMcpResult(
						{
							proposalId: result.proposal.id,
							status: result.proposal.status,
							next: "Open the app Drafts tab to preview and accept or reject.",
						},
						deepLink,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
	];
}

export function useAppEditTools(
	workspaceId: string | null,
	conversationId: string | null,
) {
	const queryClient = useQueryClient();
	const build = () =>
		workspaceId && conversationId
			? buildAppEditTools(workspaceId, conversationId, async () => {
					const { osQueryKeys } = await import("@/lib/os-query-options");
					await queryClient.invalidateQueries({
						queryKey: osQueryKeys.collaborationProposals(),
					});
				})
			: [];
	useWebMcpTools("app-edit", build, [workspaceId, conversationId, queryClient]);
	useEffect(
		() => registerPageChatTools("app-edit", build()),
		[workspaceId, conversationId, queryClient],
	);
}
