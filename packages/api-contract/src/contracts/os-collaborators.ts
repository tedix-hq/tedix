import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	OsAffectedCollaboratorSchema,
	OsCollaboratorLinkSchema,
	OsCollaboratorRoleSchema,
	OsCollaboratorSchema,
	OsCollaboratorTargetSchema,
	OsSharedWorkspaceSchema,
	OsWorkspaceCapabilitySchema,
} from "../schemas/os-collaborators";

/**
 * Workspace collaborators: people with their own Tedix sign-in who were
 * added by email or joined through a share link. Access comes from a
 * permission graph recomputed on every open; nothing stores a role. Signed-in
 * humans only. RPC-only.
 */

const workspaceId = z.string().uuid().describe("Workspace to share");
const shareKey = z
	.string()
	.regex(/^[A-Za-z0-9_-]{22}$/)
	.describe("Share-link key from the link's #share= fragment");

const OpenedAppSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable(),
	entry: z
		.string()
		.nullable()
		.describe("The deployed view the app renders; null before a revision"),
});

export const osCollaboratorsContract = oc
	.route({ tags: ["os-collaborators"], prefix: "/os-collaborators" })
	.errors(baseErrors)
	.router({
		open: oc
			.route({
				method: "POST",
				path: "/workspaces/{workspaceId}/open",
				summary: "Open a workspace as yourself",
				description:
					"Redeems an optional share key and opens the workspace in one call. Your role is recomputed from the permission graph and returned with the operations it allows. A workspace you cannot reach returns FORBIDDEN with no detail about it.",
			})
			.input(
				z
					.object({
						workspaceId,
						appId: z.string().uuid().optional(),
						shareKey: shareKey.optional(),
					})
					.strict(),
			)
			.output(
				z.object({
					workspace: z.object({
						id: z.string().uuid(),
						title: z.string(),
						ownerName: z.string().nullable(),
					}),
					role: OsCollaboratorRoleSchema,
					isOwner: z.boolean(),
					capability: OsWorkspaceCapabilitySchema,
					apps: z.array(OpenedAppSchema),
				}),
			),
		list: oc
			.route({
				method: "GET",
				path: "/workspaces/{workspaceId}/collaborators",
				summary: "List who has access and the active share links",
			})
			.input(z.object({ workspaceId }).strict())
			.output(
				z.object({
					role: OsCollaboratorRoleSchema,
					isOwner: z.boolean(),
					ownerName: z
						.string()
						.nullable()
						.describe("The owner, or the organization for a shared workspace"),
					collaborators: z.array(OsCollaboratorSchema),
					links: z.array(OsCollaboratorLinkSchema),
				}),
			),
		add: oc
			.route({
				method: "POST",
				path: "/workspaces/{workspaceId}/collaborators",
				summary: "Add a Tedix user by email",
				description:
					"Grants an existing Tedix user access at a role no higher than your own. No notification is sent.",
			})
			.input(
				z
					.object({
						workspaceId,
						email: z.string().trim().email().max(320),
						role: OsCollaboratorRoleSchema,
					})
					.strict(),
			)
			.output(z.object({ collaborator: OsCollaboratorSchema })),
		createLink: oc
			.route({
				method: "POST",
				path: "/workspaces/{workspaceId}/links",
				summary: "Create a share link",
				description:
					"Returns the link and its first key. The key is shown once; only its hash is stored.",
			})
			.input(
				z
					.object({
						workspaceId,
						role: OsCollaboratorRoleSchema,
						label: z.string().trim().max(120).optional(),
					})
					.strict(),
			)
			.output(z.object({ link: OsCollaboratorLinkSchema, key: z.string() })),
		copyLink: oc
			.route({
				method: "POST",
				path: "/workspaces/{workspaceId}/links/{linkId}/keys",
				summary: "Mint another key for a share link",
				description:
					"Old keys cannot be shown again, so copying a link mints a new key for it.",
			})
			.input(z.object({ workspaceId, linkId: z.string().uuid() }).strict())
			.output(z.object({ key: z.string() })),
		previewRemove: oc
			.route({
				method: "GET",
				path: "/workspaces/{workspaceId}/removal-impact",
				summary: "Preview who loses or narrows access",
			})
			.input(
				z.object({ workspaceId, target: OsCollaboratorTargetSchema }).strict(),
			)
			.output(z.object({ affected: z.array(OsAffectedCollaboratorSchema) })),
		remove: oc
			.route({
				method: "POST",
				path: "/workspaces/{workspaceId}/removals",
				summary: "Remove a person or revoke a share link",
				description:
					"The owner removes every grant to a person; anyone else removes only their own. Revoking a link flags it. keepUserIds re-adds listed dependents from you at their previous role.",
			})
			.input(
				z
					.object({
						workspaceId,
						target: OsCollaboratorTargetSchema,
						keepUserIds: z
							.array(z.string().min(1).max(200))
							.max(50)
							.default([]),
					})
					.strict(),
			)
			.output(z.object({ affected: z.array(OsAffectedCollaboratorSchema) })),
		listShared: oc
			.route({
				method: "GET",
				path: "/shared-workspaces",
				summary: "Workspaces shared with you that you have opened",
			})
			.input(z.object({}).strict())
			.output(z.object({ items: z.array(OsSharedWorkspaceSchema) })),
		dismissShared: oc
			.route({
				method: "POST",
				path: "/shared-workspaces/{workspaceId}/dismiss",
				summary: "Hide a shared workspace from your list",
				description: "Does not change your access.",
			})
			.input(z.object({ workspaceId }).strict())
			.output(z.object({ dismissed: z.literal(true) })),
	});
