import { createDbQueryClient } from "@tedix/db/query-client";
import { getOsWorkspaceForCollaboration } from "@tedix/db/queries/os-collaborators";
import { getOsCollaborationProposal } from "@tedix/db/queries/os-workspaces/collaboration";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import { z } from "zod";
import { readWorkspaceSessionRole } from "./os-workspace-collaborators";

const inputSchema = z
	.object({
		workspaceId: z.string().min(1),
		userIds: z.array(z.string().min(1)).min(1).max(32),
		appDraft: z
			.object({
				gadgetId: z.uuid(),
				proposalId: z.uuid(),
				baseRevisionId: z.uuid(),
			})
			.strict()
			.optional(),
	})
	.strict();

/** Only InternalEntrypoint routes here; public HTTP cannot assert a socket identity. */
export async function workspaceSessionAccess(
	request: Request,
	env: Pick<CloudflareEnv, "DB">,
) {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const parsed = inputSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return new Response(null, { status: 400 });
	const database = createDbQueryClient(env.DB);
	if (parsed.data.appDraft) {
		const { gadgetId, proposalId, baseRevisionId } = parsed.data.appDraft;
		const workspace = await getOsWorkspaceForCollaboration(database, {
			workspaceId: parsed.data.workspaceId,
		});
		if (!workspace || workspace.status !== "active")
			return Response.json({ roles: {} });
		const [proposal, gadget] = await Promise.all([
			getOsCollaborationProposal(database, {
				organizationId: workspace.organizationId,
				proposalId,
			}),
			getOsGadget(database, {
				organizationId: workspace.organizationId,
				gadgetId,
			}),
		]);
		if (
			!proposal ||
			proposal.workspaceId !== workspace.id ||
			proposal.documentType !== "gadget" ||
			proposal.documentId !== gadgetId ||
			proposal.status !== "open" ||
			proposal.baseRevisionId !== baseRevisionId ||
			!gadget ||
			gadget.workspaceId !== workspace.id ||
			gadget.status !== "active"
		)
			return Response.json({ roles: {} });
	}
	const roles = await Promise.all(
		[...new Set(parsed.data.userIds)].map(
			async (userId) =>
				[
					userId,
					await readWorkspaceSessionRole(
						database,
						parsed.data.workspaceId,
						userId,
					),
				] as const,
		),
	);
	return Response.json({ roles: Object.fromEntries(roles) });
}
