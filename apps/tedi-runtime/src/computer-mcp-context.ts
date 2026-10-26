import type { ComputerWorkspaceScope } from "./computer-workspace-scope";
import type { WorkstationTurnContext } from "./workstation-turn-context";
import { skillWorkflowRunId } from "./mcp-authorization";

/** The authenticated MCP proxy carries correlation in metadata, never in tool arguments. */
export async function computerMcpContext(
	request: Request,
	operatorScope: ComputerWorkspaceScope,
): Promise<{
	scope: ComputerWorkspaceScope;
	turnContext: WorkstationTurnContext | null;
}> {
	const body =
		request.method === "POST"
			? await request
					.clone()
					.json()
					.catch(() => null)
			: null;
	const meta =
		body && typeof body === "object" && "params" in body
			? (body as { params?: { _meta?: Record<string, unknown> } }).params?._meta
			: undefined;
	const field = (key: string) =>
		typeof meta?.[key] === "string" && meta[key].trim()
			? meta[key].slice(0, 512)
			: undefined;
	// Home turns carry kernel correlation in metadata; skill workflows carry
	// their run identity in gateway-authenticated headers.
	const runId = field("io.tedix/kernelRunId") || skillWorkflowRunId(request);
	const workItemId = field("io.tedix/workItemId");
	if (workItemId && !runId)
		throw new Error("Computer Work metadata requires its run ID");
	if (!runId) return { scope: operatorScope, turnContext: null };
	return {
		scope: workItemId
			? { kind: "delegated-run", key: workItemId }
			: { kind: "conversation", key: `mcp-run:${runId}` },
		turnContext: {
			runId,
			conversationId: `mcp-run:${runId}`,
			...(workItemId ? { workItemId } : {}),
		},
	};
}
