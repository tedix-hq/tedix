/** Shared by voice token issuance, upgrades and already-open voice sockets. */
export async function hasActiveVoiceMembership(
	env: Pick<CloudflareEnv, "DB">,
	organizationId: string,
	descopeUserId: string,
): Promise<boolean> {
	try {
		// Voice DOs are eagerly exported; keep the database graph off startup.
		const [
			{ createDbClient },
			{ getMemberByUserId, getMemberByCanonicalUserId },
		] = await Promise.all([
			import("@tedix/db/client"),
			import("@tedix/db/queries/organization-members"),
		]);
		const db = createDbClient(env.DB);
		const member = await getMemberByUserId(db, organizationId, descopeUserId);
		if (!member || member.status !== "active") return false;
		if (member.kind !== "browser_agent") return true;
		if (
			!member.userId ||
			!member.representedUserId ||
			member.userId === member.representedUserId ||
			(member.role !== "member" && member.role !== "viewer")
		)
			return false;
		const owner = await getMemberByCanonicalUserId(
			db,
			organizationId,
			member.representedUserId,
		);
		return owner?.status === "active" && owner.kind === "human";
	} catch {
		return false;
	}
}

export const VOICE_MEMBERSHIP_CHECK_MS = 5_000;

/** Stop idle sockets too; frames alone cannot drive a suspension check. */
export async function watchVoiceMembership(
	connection: { close(code: number, reason: string): void },
	request: Request,
	env: Pick<CloudflareEnv, "DB">,
): Promise<(() => void) | null> {
	const organizationId = request.headers.get("X-Kernel-Organization-Id");
	const userId = request.headers.get("X-Kernel-Descope-User-Id");
	const active = () =>
		organizationId && userId
			? hasActiveVoiceMembership(env, organizationId, userId)
			: Promise.resolve(false);
	if (!(await active())) {
		connection.close(4003, "Organization access changed; reconnect.");
		return null;
	}
	let stopped = false;
	let checking = false;
	const stop = () => {
		stopped = true;
		clearInterval(timer);
	};
	const timer = setInterval(async () => {
		if (stopped || checking) return;
		checking = true;
		try {
			if (!(await active()) && !stopped) {
				stop();
				connection.close(4003, "Organization access changed; reconnect.");
			}
		} finally {
			checking = false;
		}
	}, VOICE_MEMBERSHIP_CHECK_MS);
	return stop;
}
