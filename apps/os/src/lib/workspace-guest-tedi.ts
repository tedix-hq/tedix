/**
 * Whether this person may pick the tedi to answer in a workspace chat. The
 * workspace accepts the organization's tedis and the person's own personal
 * ones; `userId` is the person's id from the workspace presence read.
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
