import { implement } from "@orpc/server";
import { osCollaboratorsContract } from "@tedix/api-contract/contracts/os-collaborators";
import {
	dismissOsSharedWorkspace,
	listOsSharedWorkspacesForUser,
} from "@tedix/db/queries/os-collaborators";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	addWorkspaceCollaborator,
	copyWorkspaceShareLink,
	createWorkspaceShareLink,
	listWorkspaceSharing,
	openWorkspaceAsCollaborator,
	previewWorkspaceRemoval,
	removeWorkspaceAccess,
	requireCollaboratorIdentity,
} from "../../services/os-workspace-collaborators";
import { type BaseContext, withAuth, withAuthorization } from "../orpc";

const os = implement(osCollaboratorsContract).$context<BaseContext>();

/**
 * Collaborators act across organizations as themselves, so authority is the
 * workspace's permission graph, checked inside each handler, not the caller's
 * organization role. Machine principals are refused by
 * `requireCollaboratorIdentity`.
 */
const collaborator = os.use(withAuth);
const open = collaborator.open
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human and computes their role from stored edges before reading.",
			},
			"apps:read",
		),
	)
	.handler(({ input, context }) => openWorkspaceAsCollaborator(context, input));

const list = collaborator.list
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human and computes their role from stored edges before reading.",
			},
			"apps:read",
		),
	)
	.handler(({ input, context }) =>
		listWorkspaceSharing(context, input.workspaceId),
	);

const add = collaborator.add
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human with the build role (or the owner) and never grants above the caller's role.",
			},
			"apps:write",
		),
	)
	.handler(async ({ input, context }) => ({
		collaborator: await addWorkspaceCollaborator(context, input),
	}));

const createLink = collaborator.createLink
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human with the build role (or the owner) and never grants above the caller's role.",
			},
			"apps:write",
		),
	)
	.handler(({ input, context }) => createWorkspaceShareLink(context, input));

const copyLink = collaborator.copyLink
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human with the build role (or the owner) and never grants above the caller's role.",
			},
			"apps:write",
		),
	)
	.handler(({ input, context }) => copyWorkspaceShareLink(context, input));

const previewRemove = collaborator.previewRemove
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human and computes their role from stored edges before reading.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => ({
		affected: await previewWorkspaceRemoval(context, input),
	}));

const remove = collaborator.remove
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human with the build role (or the owner) and never grants above the caller's role.",
			},
			"apps:write",
		),
	)
	.handler(async ({ input, context }) => ({
		affected: await removeWorkspaceAccess(context, input),
	}));

const listShared = collaborator.listShared
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human and computes their role from stored edges before reading.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context }) => {
		const userId = requireCollaboratorIdentity(context);
		const rows = await listOsSharedWorkspacesForUser(
			createDbQueryClient(context.env.DB),
			{ userId, limit: 100 },
		);
		return {
			items: rows.map((row) => ({
				workspaceId: row.workspaceId,
				title: row.cachedTitle ?? "Shared workspace",
				ownerName: row.cachedOwnerName,
				firstOpenedAt: row.firstOpenedAt ?? row.createdAt,
				lastOpenedAt: row.lastOpenedAt ?? row.createdAt,
			})),
		};
	});

const dismissShared = collaborator.dismissShared
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human with the build role (or the owner) and never grants above the caller's role.",
			},
			"apps:write",
		),
	)
	.handler(async ({ input, context }) => {
		const userId = requireCollaboratorIdentity(context);
		await dismissOsSharedWorkspace(createDbQueryClient(context.env.DB), {
			workspaceId: input.workspaceId,
			userId,
			now: new Date().toISOString(),
		});
		return { dismissed: true as const };
	});

export const osCollaboratorsContractRouter = os.router({
	open,
	list,
	add,
	createLink,
	copyLink,
	previewRemove,
	remove,
	listShared,
	dismissShared,
});
