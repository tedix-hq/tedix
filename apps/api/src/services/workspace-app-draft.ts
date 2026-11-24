import { call } from "@orpc/server";
import { isTenantGrantablePermission } from "@tedix/auth/rbac";
import { WorkspacePublishAppDraftSchema } from "@tedix/api-contract/schemas/workspace-app-draft";
import { workspaceHighestApprovalMode } from "@tedix/api-contract/schemas/workspace-agent-access";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOsCollaborationProposal } from "@tedix/db/queries/os-workspaces/collaboration";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { createContext } from "../rpc/context";

/** Dedicated service capability: sender/turn assertions come only from the store. */
export async function publishWorkspaceAppDraft(
	env: CloudflareEnv,
	input: unknown,
) {
	const request = WorkspacePublishAppDraftSchema.parse(input);
	const context = createContext(
		new Request("https://api.internal/workspace-app-draft"),
		env,
	);
	const [member, workspace, proposal, app] = await Promise.all([
		getMemberByUserId(context.db, request.organizationId, request.userId),
		getOsWorkspace(context.db, request),
		getOsCollaborationProposal(context.db, request),
		getOsGadget(context.db, {
			organizationId: request.organizationId,
			gadgetId: request.appId,
		}),
	]);
	if (
		member?.status !== "active" ||
		member.kind === "external_agent" ||
		member.kind === "browser_agent"
	)
		throw new Error(
			"An active person must send the turn to publish automatically",
		);
	if (
		!workspace ||
		workspace.status !== "active" ||
		workspaceHighestApprovalMode(workspace) !== "auto"
	)
		throw new Error("Accept and publish this draft on its chat card.");
	if (
		!proposal ||
		proposal.workspaceId !== request.workspaceId ||
		proposal.documentId !== request.appId ||
		proposal.sourceKind !== "chat" ||
		proposal.sourceId !== request.conversationId ||
		proposal.sourceAttestationVersion !== 1 ||
		proposal.sequence !== request.expectedSequence
	)
		throw new Error("Draft changed or was not staged by this conversation");
	if (!app) throw new Error("App not found in this workspace");
	// A trusted, live-checked sender assertion, not a token or browser click.
	// The existing author procedures still derive and enforce their build access.
	context.organizationId = request.organizationId;
	context.authType = "user";
	context.user = {
		sub: request.userId,
		iss: "workspace-store",
		aud: "api.internal",
		iat: 0,
		exp: 0,
	};
	context.userRole = member.role;
	context.userPermissionOverrides = (member.customPermissions ?? []).filter(
		isTenantGrantablePermission,
	);
	context.workspaceAgentTurnId = request.turnId;
	const { createOsAppRuntimeRouter } =
		await import("../rpc/routers/os-app-runtime");
	const result = await call(
		createOsAppRuntimeRouter().acceptEdit,
		{
			workspaceId: request.workspaceId,
			gadgetId: request.appId,
			proposalId: request.proposalId,
			expectedSequence: request.expectedSequence,
			rationale: request.rationale,
		},
		{ context },
	);
	return {
		id: app.id,
		name: app.name,
		revision: result.revision.revision,
		revisionId: result.revision.id,
	};
}
