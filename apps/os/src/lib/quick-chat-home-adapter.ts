import type { EnqueueHomeMessageInput } from "@tedix/api-contract/schemas/kernel-runtime";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import {
	normalizePageToolDescriptors,
	normalizePageToolResult,
} from "@tedix/chat-transport/page-tools";
import { canvasDocFromSearch } from "./canvas-search";
import { optionalUuidSearchParam } from "./os-route-loaders";
import {
	homeConversationId,
	runQuickChatHomeTurn,
	type QuickChatHomeDeps,
} from "./quick-chat-home";

type WorkspaceContext = NonNullable<
	EnqueueHomeMessageInput["workspaceContext"]
>;
type HomeTurnInput = Parameters<typeof runQuickChatHomeTurn>[1];

/** The host route scopes the workspace; sharing the page also selects its item. */
export function quickChatWorkspaceContext(
	pathname: string,
	pageContext: unknown,
): WorkspaceContext | undefined {
	const match = /^\/workspace\/([^/]+)\/?$/.exec(pathname);
	if (!match) return undefined;
	let workspaceId: string | undefined;
	try {
		workspaceId = optionalUuidSearchParam(decodeURIComponent(match[1]!));
	} catch {
		return undefined;
	}
	if (!workspaceId) return undefined;
	const page = pageContext as
		| { pathname?: unknown; entity?: { type?: unknown; id?: unknown } }
		| undefined;
	const selected =
		page?.pathname === pathname &&
		typeof page.entity?.type === "string" &&
		typeof page.entity.id === "string"
			? canvasDocFromSearch(`${page.entity.type}:${page.entity.id}`)
			: null;
	return {
		workspaceId,
		...(selected && selected.type !== "repository"
			? { workpiece: { kind: selected.type, id: selected.id } }
			: {}),
	};
}

/** Offer the same scoped workspace tools as native chat, fixed for this turn. */
export function createQuickChatHomeAdapter(
	deps: QuickChatHomeDeps,
	host: {
		pathname(): string;
		workspaceTools(input: {
			workspaceId: string;
			conversationId: string;
			workpiece?: WorkspaceContext["workpiece"];
		}): WebMcpToolDef[];
	},
) {
	return async (input: HomeTurnInput): Promise<{ text: string }> => {
		const workspaceContext = quickChatWorkspaceContext(
			host.pathname(),
			input.pageContext,
		);
		if (!workspaceContext) return runQuickChatHomeTurn(deps, input);
		const tools = host.workspaceTools({
			...workspaceContext,
			conversationId: homeConversationId(input.conversationId),
		});
		const descriptors = normalizePageToolDescriptors([
			...tools,
			...(input.pageTools ?? []),
		]);
		const offered = new Set(descriptors.map((tool) => tool.name));
		return runQuickChatHomeTurn(deps, {
			...input,
			workspaceContext,
			pageTools: descriptors,
			runPageTool: async (call) => {
				if (!offered.has(call.name))
					return {
						ok: false,
						content: "This tool was not offered for this turn.",
					};
				const tool = tools.find((candidate) => candidate.name === call.name);
				if (!tool) return input.runPageTool?.(call) ?? null;
				if (call.confirm)
					return {
						ok: false,
						content: "This tool requires confirmation in the workspace.",
					};
				try {
					const output = await tool.execute(call.args);
					return normalizePageToolResult({
						ok: !output.isError,
						content: output.content.map((part) => part.text).join("\n"),
					});
				} catch (error) {
					return normalizePageToolResult({
						ok: false,
						content:
							error instanceof Error
								? error.message
								: "The workspace tool failed.",
					});
				}
			},
		});
	};
}
