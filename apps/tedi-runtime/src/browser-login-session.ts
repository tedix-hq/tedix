import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";

export const BROWSER_LOGIN_SESSION_KEY = "browser:login:session";

/** How long a human login from an approved takeover stays usable. */
export const BROWSER_LOGIN_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * A sign-in a person completed in Live View for one tedi. `sessionId` is the
 * Browser Run id: host-side only, never returned to the model or the ledger.
 */
export interface BrowserLoginSession {
	approvalRequestId: string;
	sessionId: string;
	tediId: string;
	orgId: string;
	/** The user who approved the takeover. */
	principal: string | null;
	reason: string | null;
	siteHosts: string[];
	approvedAt: string;
	expiresAt: string;
}

export type BrowserLoginEndReason =
	| "expired"
	| "session_lost"
	| "owner_mismatch"
	| "tedi_request"
	| "operator_end";

export type BrowserLoginEvent =
	| { kind: "recorded"; login: BrowserLoginSession }
	| {
			kind: "ended";
			login: BrowserLoginSession;
			reason: BrowserLoginEndReason;
	  };

function siteHost(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.hostname
			: null;
	} catch {
		return null;
	}
}

/** The login an approved takeover leaves behind in its Browser Run session. */
export function browserLoginFromApproval(input: {
	approvalRequestId: string;
	sessionId: string;
	tediId: string;
	orgId: string;
	row: {
		payload: string;
		resolvedAt?: string | null;
		resolvedBy?: string | null;
	};
	pageUrls: readonly (string | null | undefined)[];
	now?: number;
}): BrowserLoginSession {
	let payload: { reason?: unknown; targets?: unknown } = {};
	try {
		payload = JSON.parse(input.row.payload) as typeof payload;
	} catch {}
	const requested = Array.isArray(payload.targets)
		? payload.targets.map((target) =>
				typeof (target as { pageUrl?: unknown })?.pageUrl === "string"
					? (target as { pageUrl: string }).pageUrl
					: null,
			)
		: [];
	const current = input.pageUrls.map(siteHost).filter((h) => h !== null);
	const hosts = current.length > 0 ? current : requested.map(siteHost);
	const now = input.now ?? Date.now();
	const resolvedAt = Date.parse(input.row.resolvedAt ?? "");
	return {
		approvalRequestId: input.approvalRequestId,
		sessionId: input.sessionId,
		tediId: input.tediId,
		orgId: input.orgId,
		principal: input.row.resolvedBy ?? null,
		reason: typeof payload.reason === "string" ? payload.reason : null,
		siteHosts: [...new Set(hosts.filter((h) => h !== null))].sort(),
		approvedAt: new Date(
			Number.isFinite(resolvedAt) ? resolvedAt : now,
		).toISOString(),
		expiresAt: new Date(now + BROWSER_LOGIN_TTL_MS).toISOString(),
	};
}

/**
 * Whether a later browser call may reuse a recorded login: only the same
 * tedi and organization, before expiry, in the same Browser Run session.
 */
export function checkBrowserLogin(
	login: BrowserLoginSession,
	current: {
		tediId: string | undefined;
		orgId: string | undefined;
		sessionId: string | undefined;
		now?: number;
	},
): { action: "reuse" } | { action: "end"; reason: BrowserLoginEndReason } {
	if (login.tediId !== current.tediId || login.orgId !== current.orgId)
		return { action: "end", reason: "owner_mismatch" };
	const expiresAt = Date.parse(login.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= (current.now ?? Date.now()))
		return { action: "end", reason: "expired" };
	if (!current.sessionId || current.sessionId !== login.sessionId)
		return { action: "end", reason: "session_lost" };
	return { action: "reuse" };
}

/** What people and the tedi may see about a login; no Browser Run id. */
export function browserLoginView(login: BrowserLoginSession) {
	return {
		approvalRequestId: login.approvalRequestId,
		tediId: login.tediId,
		orgId: login.orgId,
		principal: login.principal,
		reason: login.reason,
		siteHosts: login.siteHosts,
		approvedAt: login.approvedAt,
		expiresAt: login.expiresAt,
	};
}

/** The run-ledger row for a login being recorded or ended. */
export function browserLoginRuntimeEvent(
	event: BrowserLoginEvent,
	turn: { tediId: string; runId: string; conversationId: string },
	now: Date = new Date(),
): TediRuntimeEvent {
	return {
		id: `${turn.runId}:browser-login:${event.kind}:${event.login.approvalRequestId}`,
		tediId: turn.tediId,
		kind: `browser.login.${event.kind}`,
		conversationId: turn.conversationId,
		runId: turn.runId,
		payload: {
			...browserLoginView(event.login),
			...(event.kind === "ended" ? { endReason: event.reason } : {}),
		},
		runtime: { backend: "cloudflare-agents" },
		createdAt: now.toISOString(),
	};
}

export interface BrowserLoginStorage {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<boolean>;
}

/**
 * The tedi's recorded human login, kept in its own Durable Object storage so
 * it can never be read by another tedi or organization.
 */
export function browserLoginSessions(deps: {
	storage: BrowserLoginStorage;
	owner(): { tediId: string | undefined; orgId: string | undefined };
	currentSessionId(): Promise<string | undefined>;
	/** Discard the browser and its cookies. */
	closeBrowser(reason: "login_ended" | "operator_end"): Promise<unknown>;
	emit(event: BrowserLoginEvent): Promise<void>;
	now?: () => number;
}) {
	const now = () => (deps.now ?? Date.now)();
	const forget = async (reason: BrowserLoginEndReason) => {
		const login = await deps.storage.get<BrowserLoginSession>(
			BROWSER_LOGIN_SESSION_KEY,
		);
		if (!login) return null;
		await deps.storage.delete(BROWSER_LOGIN_SESSION_KEY);
		await deps.emit({ kind: "ended", login, reason });
		return login;
	};
	return {
		async record(login: BrowserLoginSession): Promise<void> {
			await deps.storage.put(BROWSER_LOGIN_SESSION_KEY, login);
			await deps.emit({ kind: "recorded", login });
		},
		/**
		 * Before browser_execute: reuse a valid login, or end it and tell the
		 * tedi to ask for a new takeover instead of failing silently.
		 */
		async ensure(): Promise<void> {
			const login = await deps.storage.get<BrowserLoginSession>(
				BROWSER_LOGIN_SESSION_KEY,
			);
			if (!login) return;
			const decision = checkBrowserLogin(login, {
				...deps.owner(),
				sessionId: await deps.currentSessionId(),
				now: now(),
			});
			if (decision.action === "reuse") return;
			if (decision.reason !== "session_lost")
				await deps.closeBrowser("login_ended");
			await forget(decision.reason);
			throw new Error(
				`The human sign-in for ${login.siteHosts.join(", ") || "this site"} ended (${decision.reason}). If the page needs it, call request_browser_takeover({ reason: "login", note }) again.`,
			);
		},
		/** The current login, if one is active; an expired one is ended here. */
		async status() {
			const login = await deps.storage.get<BrowserLoginSession>(
				BROWSER_LOGIN_SESSION_KEY,
			);
			if (!login) return null;
			const decision = checkBrowserLogin(login, {
				...deps.owner(),
				sessionId: await deps.currentSessionId(),
				now: now(),
			});
			if (decision.action === "reuse") return browserLoginView(login);
			if (decision.reason !== "session_lost")
				await deps.closeBrowser("login_ended");
			await forget(decision.reason);
			return null;
		},
		/** Forget the login after its browser was already closed. */
		forget,
		/** Operator end: close the Browser Run session and forget the login. */
		async end(): Promise<{
			ended: ReturnType<typeof browserLoginView> | null;
		}> {
			await deps.closeBrowser("operator_end");
			const login = await forget("operator_end");
			return { ended: login ? browserLoginView(login) : null };
		},
	};
}
