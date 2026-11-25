import { implement } from "@orpc/server";
import { osCollaboratorsContract } from "@tedix/api-contract/contracts/os-collaborators";
import { coreQueryDb } from "@tedix/db/core-store/scope";
import {
	dismissOsSharedWorkspace,
	searchOrganizationPeople,
} from "@tedix/db/queries/os-collaborators";
import {
	getLatestOsWorkspaceEventCursor,
	listOsWorkspaceEventsAfter,
} from "@tedix/db/queries/os-workspace-events";
import { readWorkspaceSessionRole } from "@tedix/db/queries/os-workspace-access";

import { operationAllowed } from "@tedix/api-contract/schemas/os-collaborators";
import {
	addWorkspaceCollaborator,
	copyWorkspaceShareLink,
	createWorkspaceShareLink,
	getWorkspacePresenceIdentity,
	leaveWorkspace,
	listSharedWorkspaces,
	listWorkspaceSharing,
	openWorkspaceAsCollaborator,
	previewWorkspaceRemoval,
	removeWorkspaceAccess,
	requireCollaboratorIdentity,
	requireWorkspaceCollaboratorAccess,
	setWorkspaceCollaboratorRole,
	updateWorkspaceShareLink,
	workspaceLeaveStatus,
} from "../../services/os-workspace-collaborators";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

const os = implement(osCollaboratorsContract).$context<BaseContext>();

/**
 * Collaborators act across organizations as themselves, so authority is the
 * workspace's permission graph, checked inside each handler, not the caller's
 * organization role. Machine principals are refused by
 * `requireCollaboratorIdentity`.
 */
const collaborator = os.use(withAuth);
const access = collaborator.access
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a signed-in human and rechecks their workspace permission graph.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const access = await requireWorkspaceCollaboratorAccess(
			context,
			input.workspaceId,
			"metadata.read",
		);
		return { role: access.role!, leave: workspaceLeaveStatus(access) };
	});
/** How often a held request looks for a newer event. */
const EVENT_POLL_MS = 1_500;
const EVENT_PAGE_LIMIT = 50;

const events = collaborator.events
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a signed-in human and rechecks their workspace permission graph on every poll, so revoked access ends the stream.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const db = coreQueryDb(context.env);
		const full = () =>
			requireWorkspaceCollaboratorAccess(
				context,
				input.workspaceId,
				"metadata.read",
			);
		const { callerId } = await full();
		// Rechecks every 1.5 s read the fenced role cache: one fence read per
		// poll, and a revoke advances the fence, so the next poll ends the stream.
		const check = async () => {
			if (context.authType !== "user") return void (await full());
			const role = await readWorkspaceSessionRole(
				db,
				input.workspaceId,
				callerId,
			);
			if (!operationAllowed(role, "metadata.read"))
				throw createError(
					ErrorCodes.FORBIDDEN,
					"You don't have access to this workspace",
				);
		};
		if (input.after === undefined) {
			return {
				cursor: await getLatestOsWorkspaceEventCursor(db, input.workspaceId),
				kinds: [],
			};
		}
		const deadline = Date.now() + (input.waitMs ?? 20_000);
		for (;;) {
			const found = await listOsWorkspaceEventsAfter(db, {
				workspaceId: input.workspaceId,
				after: input.after,
				limit: EVENT_PAGE_LIMIT,
			});
			const last = found.at(-1);
			if (last) {
				return {
					cursor: last.cursor,
					kinds: [...new Set(found.map((event) => event.kind))],
				};
			}
			if (Date.now() + EVENT_POLL_MS > deadline) {
				return { cursor: input.after, kinds: [] };
			}
			await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_MS));
			await check();
		}
	});

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

const presence = collaborator.presence
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires presence.read and returns only an allowlisted roster identity.",
			},
			"apps:read",
		),
	)
	.handler(({ input, context }) =>
		getWorkspacePresenceIdentity(context, input.workspaceId),
	);

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

/**
 * Suggestions for inviting by name. It reads the caller's own organization
 * only, which the request cannot name, and needs the permission the Team page
 * needs to list the same people.
 */
const suggestPeople = collaborator.suggestPeople
	.use(withAuthorization("team:read", "team:read"))
	.handler(async ({ input, context }) => {
		const userId = requireCollaboratorIdentity(context);
		return {
			people: await searchOrganizationPeople(coreQueryDb(context.env), {
				organizationId: requireOrgId(context, "people suggestions"),
				query: input.query,
				excludeUserId: userId,
				limit: input.limit,
			}),
		};
	});

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

const setRole = collaborator.setRole
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human who is the workspace owner or an owner or admin of its organization, and never grants above the caller's role.",
			},
			"apps:write",
		),
	)
	.handler(async ({ input, context }) => ({
		affected: await setWorkspaceCollaboratorRole(context, input),
	}));

const updateLink = collaborator.updateLink
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human who is the workspace owner or an owner or admin of its organization, and never grants above the caller's role.",
			},
			"apps:write",
		),
	)
	.handler(({ input, context }) => updateWorkspaceShareLink(context, input));

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

const leave = collaborator.leave
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Access is the workspace permission graph: the handler requires a signed-in human who can open the workspace and removes only that person's own access.",
			},
			"apps:write",
		),
	)
	.handler(async ({ input, context }) => {
		await leaveWorkspace(context, input);
		return { left: true as const };
	});

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
	.handler(({ context }) => listSharedWorkspaces(context));

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
		await dismissOsSharedWorkspace(coreQueryDb(context.env), {
			workspaceId: input.workspaceId,
			userId,
			now: new Date().toISOString(),
		});
		return { dismissed: true as const };
	});

export const osCollaboratorsContractRouter = os.router({
	access,
	events,
	open,
	presence,
	list,
	suggestPeople,
	add,
	createLink,
	setRole,
	updateLink,
	copyLink,
	previewRemove,
	remove,
	leave,
	listShared,
	dismissShared,
});
