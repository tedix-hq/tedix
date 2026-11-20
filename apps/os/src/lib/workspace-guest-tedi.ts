/**
 * Whether this person may pick the tedi to answer in a workspace chat. The
 * workspace accepts the organization's tedis and the person's own personal
 * ones; `userId` is the person's sign-in id, the id a personal tedi's
 * `ownerUserId` holds (the workspace presence read, or the owner of their
 * private workspace), never the account profile's id.
 */
export function mayPickWorkspaceTedi(
	tedi: {
		status?: string | null;
		scope?: string | null;
		ownerUserId?: string | null;
	},
	userId: string | undefined,
): boolean {
	return (
		tedi.status === "active" &&
		(tedi.scope === "organization" ||
			(userId !== undefined && tedi.ownerUserId === userId))
	);
}
