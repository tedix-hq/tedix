/** Local fixture handlers: Share link and collaborator procedures. */

import type {
	OsShareInvitee,
	OsShareLink,
} from "@tedix/api-contract/contracts/os-shares";
import { osShareTitleSlug } from "@tedix/api-contract/utils/share-slug";
import { now, ORG_ID, RpcError } from "./core";
import { findWorkspace } from "./lookups";
import {
	findLocalShareLink,
	localCollaboratorLinks,
	localCollaborators,
	localRemovalImpact,
	localShareInvitees,
	localShareKey,
	localShareLinks,
	localShareTitle,
} from "./sharing";

export const sharingHandlers: Record<string, (input: never) => unknown> = {
	"osCollaborators/access": (input: { workspaceId: string }) => {
		findWorkspace(input.workspaceId);
		return { role: "build" };
	},
	"osCollaborators/presence": (input: { workspaceId: string }) => ({
		workspaceId: findWorkspace(input.workspaceId).id,
		userId: "local-you",
		displayName: "You",
		role: "owner",
	}),
	"osCollaborators/list": (input: { workspaceId: string }) => {
		findWorkspace(input.workspaceId);
		return {
			role: "build",
			isOwner: true,
			ownerName: "You",
			collaborators: localCollaborators.get(input.workspaceId) ?? [],
			links: localCollaboratorLinks.get(input.workspaceId) ?? [],
		};
	},
	"osCollaborators/add": (input: {
		workspaceId: string;
		email: string;
		role: "use" | "build";
	}) => {
		findWorkspace(input.workspaceId);
		const collaborator = {
			userId: `local-${input.email.toLowerCase()}`,
			email: input.email.toLowerCase(),
			name: null,
			role: input.role,
			addedBy: ["You"],
			canRemove: true,
			canChangeRole: true,
			lastOpenedAt: null,
		};
		const people = (localCollaborators.get(input.workspaceId) ?? []).filter(
			(person) => person.userId !== collaborator.userId,
		);
		localCollaborators.set(input.workspaceId, [...people, collaborator]);
		return { collaborator };
	},
	"osCollaborators/createLink": (input: {
		workspaceId: string;
		role: "use" | "build";
		label?: string;
	}) => {
		findWorkspace(input.workspaceId);
		const link = {
			id: crypto.randomUUID(),
			role: input.role,
			label: input.label ?? null,
			createdBy: { userId: "local-you", email: null, name: "You" },
			createdAt: now(),
			canRevoke: true,
			canEdit: true,
		};
		localCollaboratorLinks.set(input.workspaceId, [
			link,
			...(localCollaboratorLinks.get(input.workspaceId) ?? []),
		]);
		return { link, key: localShareKey() };
	},
	"osCollaborators/setRole": (input: {
		workspaceId: string;
		userId: string;
		role: "use" | "build";
	}) => {
		const person = (localCollaborators.get(input.workspaceId) ?? []).find(
			(candidate) => candidate.userId === input.userId,
		);
		if (!person) throw new RpcError("NOT_FOUND", "That person has no access");
		const oldRole = person.role;
		person.role = input.role;
		person.addedBy = ["You"];
		return {
			affected:
				oldRole === "build" && input.role === "use"
					? [
							{
								userId: person.userId,
								email: person.email,
								name: person.name,
								oldRole,
								newRole: input.role,
							},
						]
					: [],
		};
	},
	"osCollaborators/updateLink": (input: {
		workspaceId: string;
		linkId: string;
		role?: "use" | "build";
		label?: string | null;
	}) => {
		const link = (localCollaboratorLinks.get(input.workspaceId) ?? []).find(
			(candidate) => candidate.id === input.linkId,
		);
		if (!link) throw new RpcError("NOT_FOUND", "Share link not found");
		if (input.role) link.role = input.role;
		if (input.label !== undefined) link.label = input.label?.trim() || null;
		return { link, affected: [] };
	},
	"osCollaborators/copyLink": () => ({ key: localShareKey() }),
	"osCollaborators/previewRemove": (input: {
		workspaceId: string;
		target: { kind: "user"; userId: string } | { kind: "link"; linkId: string };
	}) => ({ affected: localRemovalImpact(input) }),
	"osCollaborators/remove": (input: {
		workspaceId: string;
		target: { kind: "user"; userId: string } | { kind: "link"; linkId: string };
	}) => {
		const affected = localRemovalImpact(input);
		const { target } = input;
		if (target.kind === "user")
			localCollaborators.set(
				input.workspaceId,
				(localCollaborators.get(input.workspaceId) ?? []).filter(
					(person) => person.userId !== target.userId,
				),
			);
		else
			localCollaboratorLinks.set(
				input.workspaceId,
				(localCollaboratorLinks.get(input.workspaceId) ?? []).filter(
					(link) => link.id !== target.linkId,
				),
			);
		return { affected };
	},
	"osCollaborators/open": (input: { workspaceId: string; appId?: string }) => {
		const workspace = findWorkspace(input.workspaceId);
		return {
			workspace: { id: workspace.id, title: workspace.name, ownerName: "You" },
			role: "build",
			isOwner: true,
			capability: {
				workspaceId: workspace.id,
				appId: input.appId ?? null,
				role: "build",
				operations: [],
				actingUserId: "local-you",
				openedAt: now(),
			},
			apps: [],
		};
	},
	"osCollaborators/listShared": () => ({ items: [] }),
	"osCollaborators/dismissShared": () => ({ dismissed: true }),
	"osShares/shares/list": (input: {
		resourceType: OsShareLink["resourceType"];
		resourceId: string;
	}) => ({
		items:
			localShareLinks.get(`${input.resourceType}:${input.resourceId}`) ?? [],
	}),
	"osShares/shares/create": (input: {
		resourceType: OsShareLink["resourceType"];
		resourceId: string;
		role?: OsShareLink["role"];
		access?: OsShareLink["access"];
		revisionMode?: OsShareLink["revisionMode"];
		pinnedRevisionId?: string;
		note?: string;
		expiresAt?: string;
	}) => {
		const publicId = crypto.randomUUID().replaceAll("-", "").slice(0, 22);
		const slug = osShareTitleSlug(localShareTitle(input));
		const share: OsShareLink = {
			id: crypto.randomUUID(),
			publicId,
			url: `${globalThis.location?.origin ?? "http://localhost:5173"}/s/${publicId}${slug ? `/${slug}` : ""}`,
			organizationId: ORG_ID,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			access: input.access ?? "anyone_with_link",
			role: input.role ?? "viewer",
			revisionMode: input.revisionMode ?? "living",
			pinnedRevisionId: input.pinnedRevisionId ?? null,
			note: input.note ?? null,
			policyMaxRole: null,
			policyReason: null,
			policyRestrictedAt: null,
			createdByKind: "user",
			createdById: "local-you",
			createdAt: now(),
			expiresAt: input.expiresAt ?? null,
			revokedAt: null,
			disabledAt: null,
		};
		const key = `${input.resourceType}:${input.resourceId}`;
		localShareLinks.set(key, [share, ...(localShareLinks.get(key) ?? [])]);
		return { share, token: localShareKey() };
	},
	"osShares/shares/invitees/list": (input: { shareId: string }) => ({
		items: localShareInvitees.get(input.shareId) ?? [],
	}),
	"osShares/shares/invitees/add": (input: {
		shareId: string;
		email: string;
	}) => {
		findLocalShareLink(input.shareId);
		const email = input.email.trim().toLowerCase();
		const existing = (localShareInvitees.get(input.shareId) ?? []).find(
			(invitee) => invitee.email === email,
		);
		if (existing) return { invitee: existing };
		const invitee: OsShareInvitee = {
			id: crypto.randomUUID(),
			shareLinkId: input.shareId,
			email,
			userId: null,
			name: null,
			addedByKind: "user",
			addedById: "local-you",
			addedAt: now(),
		};
		localShareInvitees.set(input.shareId, [
			...(localShareInvitees.get(input.shareId) ?? []),
			invitee,
		]);
		return { invitee };
	},
	"osShares/shares/invitees/remove": (input: {
		shareId: string;
		inviteeId: string;
	}) => {
		const before = localShareInvitees.get(input.shareId) ?? [];
		const after = before.filter((invitee) => invitee.id !== input.inviteeId);
		localShareInvitees.set(input.shareId, after);
		return { removed: after.length !== before.length };
	},
	"osShares/shares/update": (input: {
		shareId: string;
		access?: OsShareLink["access"];
		role?: OsShareLink["role"];
		note?: string | null;
		expiresAt?: string | null;
	}) => {
		const share = findLocalShareLink(input.shareId);
		if (share.revokedAt)
			throw new RpcError(
				"BAD_REQUEST",
				"This link is turned off. Make a new link instead.",
			);
		if (input.access) share.access = input.access;
		if (input.role) share.role = input.role;
		if (input.note !== undefined) share.note = input.note?.trim() || null;
		if (input.expiresAt !== undefined) share.expiresAt = input.expiresAt;
		return { share, revokedSessionCount: 0 };
	},
	"osShares/shares/previewChange": (input: {
		shareId: string;
		change:
			| { kind: "access"; access: OsShareLink["access"] }
			| { kind: "off" | "on" }
			| { kind: "removeInvitee"; inviteeId: string };
	}) => {
		const share = findLocalShareLink(input.shareId);
		const invited = localShareInvitees.get(input.shareId)?.length ?? 0;
		const reach = (open: boolean, access: OsShareLink["access"]) => ({
			people: open && access === "invited" ? invited : 0,
			organization: open && access === "organization",
			anyoneWithLink: open && access === "anyone_with_link",
		});
		const open = !share.revokedAt && !share.disabledAt;
		const was = reach(open, share.access);
		const now =
			input.change.kind === "off"
				? reach(false, share.access)
				: input.change.kind === "on"
					? reach(!share.revokedAt, share.access)
					: input.change.kind === "access"
						? reach(open, input.change.access)
						: {
								...was,
								people: Math.max(0, was.people - 1),
							};
		return {
			loses: {
				people: Math.max(0, was.people - now.people),
				organization:
					was.organization && !now.organization && !now.anyoneWithLink,
				anyoneWithLink: was.anyoneWithLink && !now.anyoneWithLink,
			},
			gains: {
				people: Math.max(0, now.people - was.people),
				organization:
					now.organization && !was.organization && !was.anyoneWithLink,
				anyoneWithLink: now.anyoneWithLink && !was.anyoneWithLink,
			},
			remaining: now,
			keepThroughWorkspace: 0,
			openNow: 0,
		};
	},
	"osShares/shares/previewRevoke": (input: { shareId: string }) => ({
		share: findLocalShareLink(input.shareId),
		activeSessionCount: 0,
	}),
	"osShares/shares/revoke": (input: { shareId: string }) => {
		const share = findLocalShareLink(input.shareId);
		share.revokedAt ??= now();
		return { share, revokedSessionCount: 0 };
	},
	"osShares/shares/setDisabled": (input: {
		shareId: string;
		disabled: boolean;
	}) => {
		const share = findLocalShareLink(input.shareId);
		if (share.revokedAt)
			throw new RpcError(
				"BAD_REQUEST",
				"This link was deleted. Make a new link instead.",
			);
		share.disabledAt = input.disabled ? (share.disabledAt ?? now()) : null;
		return { share, revokedSessionCount: 0 };
	},
	"osShares/shares/delete": (input: { shareId: string }) => {
		const share = findLocalShareLink(input.shareId);
		share.revokedAt ??= now();
		for (const [key, links] of localShareLinks) {
			const kept = links.filter((link) => link.id !== share.id);
			if (kept.length !== links.length) localShareLinks.set(key, kept);
		}
		return { deleted: true };
	},
};
