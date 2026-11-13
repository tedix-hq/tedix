/**
 * Collaborators, share links and the custom domain kept for this session.
 */

import type {
	OsShareInvitee,
	OsShareLink,
} from "@tedix/api-contract/contracts/os-shares";
import type { OrganizationDomainSchema } from "@tedix/api-contract/schemas/organization-domains";
import type * as z from "zod";
import { RpcError } from "./core";
import { state } from "./state";

// Workspace collaborators on this local copy: you own every workspace.
type LocalCollaborator = {
	userId: string;
	email: string;
	name: string | null;
	role: "use" | "build";
	addedBy: string[];
	canRemove: boolean;
	canChangeRole: boolean;
	lastOpenedAt: string | null;
};
type LocalCollaboratorLink = {
	id: string;
	role: "use" | "build";
	label: string | null;
	createdBy: { userId: string; email: string | null; name: string | null };
	createdAt: string;
	canRevoke: boolean;
	canEdit: boolean;
};
export const localCollaborators = new Map<string, LocalCollaborator[]>();
export const localCollaboratorLinks = new Map<
	string,
	LocalCollaboratorLink[]
>();
/** Share links per resource; the token is returned once and never kept. */
export const localShareLinks = new Map<string, OsShareLink[]>();
export let localCustomDomain: z.infer<typeof OrganizationDomainSchema> | null =
	null;

export function setLocalCustomDomain(value: typeof localCustomDomain): void {
	localCustomDomain = value;
}

export function findLocalShareLink(shareId: string): OsShareLink {
	for (const links of localShareLinks.values()) {
		const link = links.find((candidate) => candidate.id === shareId);
		if (link) return link;
	}
	throw new RpcError("NOT_FOUND", "Share link not found");
}

/** The shared resource's title or name, for the readable address suffix. */
export function localShareTitle(input: {
	resourceType: OsShareLink["resourceType"];
	resourceId: string;
}): string | null {
	if (input.resourceType === "output") {
		return (
			state.outputs.find((row) => row.id === input.resourceId)?.title ?? null
		);
	}
	if (input.resourceType === "gadget") {
		return (
			state.gadgets.find((row) => row.id === input.resourceId)?.name ?? null
		);
	}
	return (
		state.workspaces.find((row) => row.id === input.resourceId)?.name ?? null
	);
}

/** Who each `invited` link admits, by share id. */
export const localShareInvitees = new Map<string, OsShareInvitee[]>();

export function localShareKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Local people have one direct grant each, so only the target is affected. */
export function localRemovalImpact(input: {
	workspaceId: string;
	target: { kind: "user"; userId: string } | { kind: "link"; linkId: string };
}) {
	const { target } = input;
	if (target.kind === "link") return [];
	return (localCollaborators.get(input.workspaceId) ?? [])
		.filter((person) => person.userId === target.userId)
		.map((person) => ({
			userId: person.userId,
			email: person.email,
			name: person.name,
			oldRole: person.role,
			newRole: null,
		}));
}
