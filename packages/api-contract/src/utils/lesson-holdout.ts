/** The same stable measurement arm in the server and local lesson selector. */
export const HOLDOUT_PERCENT = 10;
export async function isHoldoutSession(sessionId: string): Promise<boolean> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`tedix.lesson-holdout.v1:${sessionId.trim().toLowerCase()}`,
		),
	);
	return new DataView(digest).getUint32(0) % 100 < HOLDOUT_PERCENT;
}
