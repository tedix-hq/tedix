/**
 * What a change to a share link does to who can open what it shares, worked
 * out before the change is made so the Share dialog can say it in plain
 * words. Pure: the caller loads the link, its invite list and where each
 * invited person stands.
 */
import type {
	OsShareAccess,
	OsShareAudience,
} from "@tedix/api-contract/contracts/os-shares";

/** Who a link reaches at one moment: nobody while it is off, stopped or expired. */
export type ShareLinkReach = { open: boolean; access: OsShareAccess };

/** One invited person, and the other ways they already reach the file. */
export type ShareInviteeStanding = {
	id: string;
	/** An active member of the link's organization. */
	inOrganization: boolean;
	/** Opens the file through the workspace, whatever the link says. */
	inWorkspace: boolean;
};

export type ShareAccessChange = {
	loses: OsShareAudience;
	gains: OsShareAudience;
	/** Who the link reaches once the change is made. */
	remaining: OsShareAudience;
	/** Invited people the link drops who still open the file through the workspace. */
	keepThroughWorkspace: number;
};

const NOBODY: OsShareAudience = {
	people: 0,
	organization: false,
	anyoneWithLink: false,
};

/** The ids of the invited people a link reaches by name. */
function invitedReach(
	reach: ShareLinkReach,
	invitees: readonly ShareInviteeStanding[],
): Set<string> {
	return new Set(
		reach.open && reach.access === "invited"
			? invitees.map((invitee) => invitee.id)
			: [],
	);
}

/** Whether a link reaches this invited person, by name or as part of a group. */
function reaches(
	reach: ShareLinkReach,
	invitee: ShareInviteeStanding,
	invited: ReadonlySet<string>,
): boolean {
	if (!reach.open) return false;
	if (reach.access === "anyone_with_link") return true;
	if (reach.access === "organization") return invitee.inOrganization;
	return invited.has(invitee.id);
}

function audience(
	reach: ShareLinkReach,
	invited: ReadonlySet<string>,
): OsShareAudience {
	if (!reach.open) return NOBODY;
	return {
		people: reach.access === "invited" ? invited.size : 0,
		organization: reach.access === "organization",
		anyoneWithLink: reach.access === "anyone_with_link",
	};
}

/**
 * Compare who the link reaches before and after. A group (the organization,
 * or anyone with the link) is lost when the link stops reaching it as a
 * group; invited people are counted one by one, and someone who still opens
 * the file through the workspace is reported apart, never as losing access.
 */
export function shareAccessChange(input: {
	before: ShareLinkReach;
	after: ShareLinkReach;
	/** The invite list before the change. */
	invitees: readonly ShareInviteeStanding[];
	/** The invited person this change removes, if it removes one. */
	removedInviteeId?: string;
}): ShareAccessChange {
	const { before, after, invitees } = input;
	const invitedBefore = invitedReach(before, invitees);
	const invitedAfter = invitedReach(
		after,
		invitees.filter((invitee) => invitee.id !== input.removedInviteeId),
	);
	const was = audience(before, invitedBefore);
	const now = audience(after, invitedAfter);
	let lost = 0;
	let keepThroughWorkspace = 0;
	let gained = 0;
	for (const invitee of invitees) {
		const reachedBefore = reaches(before, invitee, invitedBefore);
		const reachedAfter = reaches(after, invitee, invitedAfter);
		// Only people the link names count one by one; the rest are a group.
		if (invitedBefore.has(invitee.id) && !reachedAfter) {
			if (invitee.inWorkspace) keepThroughWorkspace++;
			else lost++;
		}
		if (invitedAfter.has(invitee.id) && !reachedBefore && !invitee.inWorkspace)
			gained++;
	}
	return {
		loses: {
			people: lost,
			organization:
				was.organization && !now.organization && !now.anyoneWithLink,
			anyoneWithLink: was.anyoneWithLink && !now.anyoneWithLink,
		},
		gains: {
			people: gained,
			organization:
				now.organization && !was.organization && !was.anyoneWithLink,
			anyoneWithLink: now.anyoneWithLink && !was.anyoneWithLink,
		},
		remaining: now,
		keepThroughWorkspace,
	};
}
