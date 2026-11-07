import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import { buildAppEditTools } from "@/components/app-edit-webmcp-tools";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import { buildWorkspaceWebMcpTools } from "@/components/workspace-webmcp-tools";

const CONTENT_PREVIEW_LIMIT = 16_000;

/** The same workspace reads for the native composer and the embedded chat. */
export function buildWorkspaceChatTools({
	workspaceId,
	conversationId,
	workpiece,
	onProposed = async () => {},
}: {
	workspaceId: string;
	conversationId: string;
	workpiece?: { kind: "gadget" | "output"; id: string };
	onProposed?: () => Promise<unknown>;
}): WebMcpToolDef[] {
	const deepLink = `/workspace/${workspaceId}`;
	const appTools = buildAppEditTools(workspaceId, conversationId, onProposed);
	return [
		...buildWorkspaceWebMcpTools(workspaceId, () =>
			workpiece ? { type: workpiece.kind, id: workpiece.id } : null,
		),
		{
			name: "list_workspace_apps",
			description:
				"Find apps in this workspace by name and id. Use read_app_files for an app's committed revision number and its files; manifest config.version is only a settings format number.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async (_args, options) => {
				try {
					const { osApi } = await import("@/lib/api");
					const result = await osApi.osWorkspaces.gadgets.list(
						{ workspaceId, status: "active", limit: 50 },
						...(options?.signal ? [{ signal: options.signal }] : []),
					);
					return webMcpResult(
						{
							items: result.items.map((app) => ({
								id: app.id,
								name: app.name,
								status: app.status,
								currentRevisionId: app.currentRevisionId,
							})),
							truncated: result.truncated,
						},
						deepLink,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "read_workspace_output",
			description:
				"Read a document, sheet or presentation in this workspace and its committed revision number. Use list_workspace_outputs to find its id. Set includeContent for a bounded preview of the saved body; this does not read unsaved edits.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: {
				type: "object",
				properties: {
					outputId: { type: "string", format: "uuid" },
					includeContent: { type: "boolean" },
				},
				required: ["outputId"],
				additionalProperties: false,
			},
			execute: async (args, options) => {
				try {
					if (typeof args.outputId !== "string" || !args.outputId)
						return webMcpError("outputId is required");
					const { osApi } = await import("@/lib/api");
					const { output, currentRevision } =
						await osApi.osWorkspaces.outputs.get(
							{ outputId: args.outputId },
							...(options?.signal ? [{ signal: options.signal }] : []),
						);
					if (output.workspaceId !== workspaceId)
						return webMcpError("This output is not in the open workspace.");
					const content =
						args.includeContent === true
							? JSON.stringify(currentRevision.content)
							: undefined;
					return webMcpResult(
						{
							id: output.id,
							title: output.title,
							kind: output.kind,
							revision: currentRevision.revision,
							revisionId: currentRevision.id,
							...(content === undefined
								? {}
								: {
										contentPreview: content.slice(0, CONTENT_PREVIEW_LIMIT),
										contentTruncated: content.length > CONTENT_PREVIEW_LIMIT,
									}),
						},
						`${deepLink}?workpiece=output:${output.id}`,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		...appTools.filter(
			(tool) =>
				tool.annotations?.readOnlyHint === true || workpiece?.kind === "gadget",
		),
	];
}
