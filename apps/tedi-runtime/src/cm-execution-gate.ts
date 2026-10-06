/**
 * Session-scoped pre-authorization and exact-replay gate for Code Mode
 * `execute`.
 *
 * The execute tool runs arbitrary model JS against the live DO-SQLite workspace
 * — always HIGH risk. Policy-tier auto-approve (writeTier.trustedTools) cannot
 * carry a HIGH-risk write; only an explicit session pre-authorization may.
 *
 * Explicit pre-authorization is stored in the DO's durable KV as a JSON array of
 * session grants under `cm_session_allowlist`. Each grant is `{ sessionKey,
 * expiresAt }`: a session_key the operator pre-authorized for execute access,
 * plus a wall-clock expiry. A code-execution grant MUST NOT live forever — it
 * auto-expires after `DEFAULT_SESSION_TTL_MS` unless re-authorized. The
 * session_key is the same `sessionKey` / `session_id` already tracked on the DO
 * (`currentTurn.sessionKey`).
 *
 * Approval-drain replay uses a narrower one-shot grant under
 * `cm_execution_replay_grants`. A replay grant is keyed by session + code hash
 * and is consumed before the approved code runs. This keeps human approval tied
 * to the exact parked code while preserving the broader explicit preauth route.
 *
 * The gate is fail-closed: any read error, malformed entry, or expired grant →
 * unauthorized. Legacy pre-TTL bare-string entries (no expiry) are treated as
 * already expired — a perpetual grant is exactly what the TTL exists to prevent.
 */

const ALLOWLIST_KEY = "cm_session_allowlist";
const REPLAY_GRANTS_KEY = "cm_execution_replay_grants";

/**
 * Default coding-session authorization lifetime (1h). An execute grant
 * auto-expires after this unless re-authorized via `authorizeSession`.
 */
export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_REPLAY_TTL_MS = 15 * 60 * 1000;

interface SessionGrant {
	sessionKey: string;
	/** Epoch ms; the grant is invalid at/after this instant. */
	expiresAt: number;
	authorizedBy?: string;
}

interface ReplayGrant {
	sessionKey: string;
	codeHash: string;
	sourceExecutionId: string;
	expiresAt: number;
	authorizedBy?: string;
}

export interface CmSessionGateStorage {
	get(key: string): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
}

export class CmSessionGate {
	private readonly storage: CmSessionGateStorage;
	private readonly now: () => number;

	constructor(storage: CmSessionGateStorage, now: () => number = Date.now) {
		this.storage = storage;
		this.now = now;
	}

	/**
	 * True iff `sessionKey` has a grant that has NOT expired. Fail-closed: a
	 * missing, malformed, legacy (no-expiry), or expired grant → false.
	 */
	async isSessionAuthorized(sessionKey: string): Promise<boolean> {
		if (!sessionKey) return false;
		const grant = (await this.readGrants()).find(
			(g) => g.sessionKey === sessionKey,
		);
		return grant !== undefined && grant.expiresAt > this.now();
	}

	/**
	 * Authorize `sessionKey` for `ttlMs` (default 1h). Replaces any prior grant
	 * for the same key and prunes expired grants on write.
	 */
	async authorizeSession(
		sessionKey: string,
		authorizedBy: string,
		ttlMs: number = DEFAULT_SESSION_TTL_MS,
	): Promise<void> {
		if (!sessionKey) return;
		const ttl =
			Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_SESSION_TTL_MS;
		const now = this.now();
		const grants = (await this.readGrants()).filter(
			(g) => g.sessionKey !== sessionKey && g.expiresAt > now,
		);
		grants.push({
			sessionKey,
			expiresAt: now + ttl,
			...(authorizedBy ? { authorizedBy } : {}),
		});
		await this.storage.put(ALLOWLIST_KEY, JSON.stringify(grants));
	}

	/**
	 * Authorize one replay of the exact parked code hash. Unlike
	 * authorizeSession(), this does not create broad session execute access.
	 */
	async authorizeReplay(input: {
		sessionKey: string;
		codeHash: string;
		sourceExecutionId: string;
		authorizedBy: string;
		ttlMs?: number;
	}): Promise<void> {
		if (!input.sessionKey || !input.codeHash || !input.sourceExecutionId)
			return;
		const ttl =
			Number.isFinite(input.ttlMs) && (input.ttlMs ?? 0) > 0
				? (input.ttlMs as number)
				: DEFAULT_REPLAY_TTL_MS;
		const now = this.now();
		const grants = (await this.readReplayGrants()).filter(
			(g) =>
				g.expiresAt > now &&
				!(
					g.sessionKey === input.sessionKey &&
					g.codeHash === input.codeHash &&
					g.sourceExecutionId === input.sourceExecutionId
				),
		);
		grants.push({
			sessionKey: input.sessionKey,
			codeHash: input.codeHash,
			sourceExecutionId: input.sourceExecutionId,
			expiresAt: now + ttl,
			...(input.authorizedBy ? { authorizedBy: input.authorizedBy } : {}),
		});
		await this.storage.put(REPLAY_GRANTS_KEY, JSON.stringify(grants));
	}

	/**
	 * Consume a one-shot replay grant for this session + code hash. The grant is
	 * removed before returning so a failed/partial execute cannot be replayed
	 * indefinitely.
	 */
	async consumeReplayGrant(
		sessionKey: string,
		codeHash: string,
	): Promise<{
		sourceExecutionId: string;
		authorizedBy?: string;
	} | null> {
		if (!sessionKey || !codeHash) return null;
		const now = this.now();
		const grants = await this.readReplayGrants();
		let matched: ReplayGrant | null = null;
		const next: ReplayGrant[] = [];
		for (const grant of grants) {
			if (grant.expiresAt <= now) continue;
			if (
				matched === null &&
				grant.sessionKey === sessionKey &&
				grant.codeHash === codeHash
			) {
				matched = grant;
				continue;
			}
			next.push(grant);
		}
		await this.storage.put(REPLAY_GRANTS_KEY, JSON.stringify(next));
		return matched
			? {
					sourceExecutionId: matched.sourceExecutionId,
					...(matched.authorizedBy
						? { authorizedBy: matched.authorizedBy }
						: {}),
				}
			: null;
	}

	/** Remove `sessionKey`'s grant (and prune expired grants on write). */
	async revokeSession(sessionKey: string): Promise<void> {
		if (!sessionKey) return;
		const now = this.now();
		const next = (await this.readGrants()).filter(
			(g) => g.sessionKey !== sessionKey && g.expiresAt > now,
		);
		await this.storage.put(ALLOWLIST_KEY, JSON.stringify(next));
	}

	private async readGrants(): Promise<SessionGrant[]> {
		try {
			const raw = await this.storage.get(ALLOWLIST_KEY);
			if (typeof raw !== "string") return [];
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			const grants: SessionGrant[] = [];
			for (const entry of parsed) {
				// New format: { sessionKey, expiresAt, authorizedBy? }.
				if (entry && typeof entry === "object") {
					const e = entry as Record<string, unknown>;
					if (
						typeof e.sessionKey === "string" &&
						typeof e.expiresAt === "number"
					) {
						grants.push({
							sessionKey: e.sessionKey,
							expiresAt: e.expiresAt,
							...(typeof e.authorizedBy === "string"
								? { authorizedBy: e.authorizedBy }
								: {}),
						});
					}
				}
				// Legacy bare-string entries (pre-TTL) are intentionally dropped —
				// fail-closed; a perpetual grant is what the TTL prevents.
			}
			return grants;
		} catch {
			return [];
		}
	}

	private async readReplayGrants(): Promise<ReplayGrant[]> {
		try {
			const raw = await this.storage.get(REPLAY_GRANTS_KEY);
			if (typeof raw !== "string") return [];
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			const grants: ReplayGrant[] = [];
			for (const entry of parsed) {
				if (!entry || typeof entry !== "object") continue;
				const e = entry as Record<string, unknown>;
				if (
					typeof e.sessionKey === "string" &&
					typeof e.codeHash === "string" &&
					typeof e.sourceExecutionId === "string" &&
					typeof e.expiresAt === "number"
				) {
					grants.push({
						sessionKey: e.sessionKey,
						codeHash: e.codeHash,
						sourceExecutionId: e.sourceExecutionId,
						expiresAt: e.expiresAt,
						...(typeof e.authorizedBy === "string"
							? { authorizedBy: e.authorizedBy }
							: {}),
					});
				}
			}
			return grants;
		} catch {
			return [];
		}
	}
}
