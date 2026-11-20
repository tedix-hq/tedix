import { workspaceOnlyOpenableBy } from "@tedix/api-contract/utils/os-collaborator-graph";

/**
 * Whether a guest tedi may bring its private context (core memory and its
 * per-turn memory recall) into a workspace conversation. A personal tedi's
 * memory belongs to its owner, so it comes only into a workspace nobody but
 * that owner can open: private, owned by them, with no one else added and
 * no open share link. Elsewhere it answers with its persona alone. An
 * organization tedi's memory is the organization's, so it keeps it.
 */
export function guestMayUseMemory(input: {
	tedi: { id: string; scope: string | null; ownerUserId: string | null };
	workspace: { visibility: string; ownerUserId: string | null };
	edges: ReadonlyArray<{ targetUserId: string }>;
	links: ReadonlyArray<{ revokedAt: string | null }>;
}): boolean {
	const { tedi } = input;
	if (tedi.scope === "organization") return true;
	return (
		!!tedi.ownerUserId &&
		workspaceOnlyOpenableBy({
			...input,
			userId: tedi.ownerUserId,
			alsoAllowed: [tedi.id],
		})
	);
}
