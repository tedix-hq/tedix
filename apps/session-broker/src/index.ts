import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
	assertSessionBrokerIntent,
	buildSessionBrokerAuthorizeUrl,
	buildSessionBrokerCallbackUrl,
	buildSessionBrokerErrorCallbackUrl,
	buildSessionBrokerLoginUrl,
	readSessionBrokerOrigins,
	type CreateSessionBrokerIntentInput,
	type CreateSessionBrokerIntentResult,
	type ExchangeSessionBrokerCodeInput,
	SESSION_BROKER_CALLBACK_PATHS,
	SESSION_BROKER_CODE_TTL_SECONDS,
	SESSION_BROKER_INTENT_TTL_SECONDS,
	SESSION_BROKER_NO_STORE_HEADERS,
	type SessionBrokerExchangeResult,
	type SessionBrokerIntent,
	type SessionBrokerSurface,
} from "@tedix/auth/session-broker";
import { descopeFetch } from "@tedix/auth/descope-fetch";
import { validateToken } from "@tedix/auth/jwt";
import {
	DESCOPE_REFRESH_COOKIE,
	DESCOPE_SESSION_COOKIE,
	logoutDescopeSession,
	resumeDescopeSession,
	selectDescopeTenantSession,
	decodeUnverifiedJwtClaims,
	serializeCookie,
} from "@tedix/auth/web";
import type { BrokerEnv } from "./env";
import type {
	SessionIntentOwner,
	StoreLogoutGrantInput,
	StoreSessionGrantInput,
} from "./intent-owner";
import {
	BROKER_REFRESH_COOKIE,
	appendRotatedRefreshCookie,
	expireRefreshAndSessionCookies,
} from "./session-cookies";
import { sessionExceptionTopology } from "./session-log";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_REFRESH_TOKEN_LENGTH = 16_384;
const AUTH_SESSION_COOKIE = "TEDIX_AUTH_SESSION_ID";
const AUTH_SESSION_MAX_AGE_SECONDS = 28 * 24 * 60 * 60;
const AUTHORIZE_PATH = "/tedix/session/authorize";
const OUTBOUND_CALLBACK_PATH = "/tedix/session/outbound/callback";
const HEALTH_PATH = "/tedix/session/health";

function brokerOrigins(env: BrokerEnv) {
	return readSessionBrokerOrigins(
		env as BrokerEnv & {
			OS_URL?: string;
			SESSION_BROKER_URL?: string;
		},
	);
}

type RotationState = {
	generation: number;
	currentFingerprint: string | null;
	status: "ready" | "reauth_required";
};

export type RotateSessionInput = {
	refreshToken: string;
	tenantId: string;
	traceId: string;
};

type ResumeSessionInput = Omit<RotateSessionInput, "tenantId"> & {
	sessionToken?: string;
};
type LogoutSessionInput = ResumeSessionInput;
type SessionMutationInput = ResumeSessionInput & { tenantId: string | null };

type RotateSessionResult =
	| {
			ok: true;
			generation: number;
			refreshCookieMaxAge?: number;
			refreshToken: string;
			sessionToken: string;
	  }
	| {
			ok: false;
			clearRefreshCookie: boolean;
			reason: "descope_rejected" | "invalid_input" | "refresh_chain_invalid";
	  };

type LogoutSessionResult =
	| {
			ok: true;
			outcome: "revoked" | "already_invalid" | "unconfirmed";
	  }
	| {
			ok: false;
			clearRefreshCookie: true;
			reason: "invalid_input" | "refresh_chain_invalid";
	  };

function isRotateSessionInput(value: unknown): value is RotateSessionInput {
	if (!value || typeof value !== "object") return false;
	const input = value as Record<string, unknown>;
	return (
		typeof input.refreshToken === "string" &&
		input.refreshToken.length > 0 &&
		input.refreshToken.length <= MAX_REFRESH_TOKEN_LENGTH &&
		(input.sessionToken === undefined ||
			(typeof input.sessionToken === "string" &&
				input.sessionToken.length > 0 &&
				input.sessionToken.length <= MAX_REFRESH_TOKEN_LENGTH)) &&
		typeof input.tenantId === "string" &&
		TENANT_ID_PATTERN.test(input.tenantId) &&
		typeof input.traceId === "string" &&
		TRACE_ID_PATTERN.test(input.traceId)
	);
}

function isResumeSessionInput(value: unknown): value is ResumeSessionInput {
	if (!value || typeof value !== "object") return false;
	const input = value as Record<string, unknown>;
	return (
		typeof input.refreshToken === "string" &&
		input.refreshToken.length > 0 &&
		input.refreshToken.length <= MAX_REFRESH_TOKEN_LENGTH &&
		typeof input.traceId === "string" &&
		TRACE_ID_PATTERN.test(input.traceId)
	);
}

async function fingerprint(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function randomReference(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

async function digestReference(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return `sha256-${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function distinctCookieValues(header: string | null, name: string): string[] {
	if (!header) return [];
	const values = header
		.split(";")
		.map((part) => part.trim().split("="))
		.filter(([candidate]) => candidate === name)
		.map(([, ...rest]) => {
			const encoded = rest.join("=");
			try {
				return decodeURIComponent(encoded);
			} catch {
				return encoded;
			}
		})
		.filter(Boolean);
	return [...new Set(values)];
}

function cookieNames(header: string | null): string[] {
	if (!header) return [];
	return [
		...new Set(
			header
				.split(";")
				.map((part) => part.trim().split("=", 1)[0])
				.filter((name): name is string => Boolean(name)),
		),
	].sort();
}

function decodeJwtClaims(token: string): {
	dct?: string;
	exp?: number;
	iat?: number;
	sub?: string;
} | null {
	return decodeUnverifiedJwtClaims(token);
}

/**
 * Pick the newest-issued token when every candidate belongs to one subject.
 * Descope invalidates an older refresh token the moment its successor is
 * used, so replaying anything but the newest risks family-wide reuse
 * revocation.
 */
function newestSameSubjectRefreshValue(values: string[]): string[] {
	const decoded = values.map((value, index) => ({
		claims: decodeJwtClaims(value),
		index,
		value,
	}));
	const subjects = new Set(decoded.map(({ claims }) => claims?.sub));
	if (subjects.size !== 1 || subjects.has(undefined)) return values;
	decoded.sort(
		(left, right) =>
			(right.claims?.iat ?? 0) - (left.claims?.iat ?? 0) ||
			(right.claims?.exp ?? 0) - (left.claims?.exp ?? 0) ||
			right.index - left.index,
	);
	return decoded[0] ? [decoded[0].value] : values;
}

/**
 * Resolve the authoritative refresh token from both cookie families.
 *
 * `TEDIX_DSR` is the broker's steady-state authority, but the broker also
 * leaves a Descope-readable `DSR` twin so authenticated Descope flows
 * (inbound-app consent, step-up) can hydrate via their own refresh call.
 * When such a flow rotates the family, the browser returns the stale broker
 * value alongside Descope's newer successor; a fresh signed session JWT
 * arbitrates when present, and otherwise a broker-owned candidate set that
 * agrees on one subject resolves to the newest issuance. Anything else
 * fails closed to central login.
 */
function selectAuthoritativeRefreshValue(
	brokerValues: string[],
	descopeValues: string[],
	authenticatedSessionToken: string | undefined,
): string[] {
	const candidates = [...new Set([...brokerValues, ...descopeValues])];
	if (candidates.length <= 1) return candidates;
	if (authenticatedSessionToken) {
		return selectBootstrapRefreshValue(candidates, authenticatedSessionToken);
	}
	if (brokerValues.length > 0) {
		const resolved = newestSameSubjectRefreshValue(candidates);
		if (resolved.length === 1) return resolved;
		// Undecodable or mixed-subject extras: the broker's own HttpOnly cookie
		// outranks ambient `DSR` leftovers, but ambiguity within the broker's
		// own cookie still fails closed.
		return [...new Set(brokerValues)];
	}
	return candidates;
}

function selectBootstrapRefreshValue(
	values: string[],
	authenticatedSessionToken: string | undefined,
): string[] {
	if (values.length <= 1 || !authenticatedSessionToken) return values;
	const authenticatedSubject = decodeJwtClaims(authenticatedSessionToken)?.sub;
	if (!authenticatedSubject) return values;
	const matching = values
		.map((value, index) => ({
			claims: decodeJwtClaims(value),
			index,
			value,
		}))
		.filter(({ claims }) => claims?.sub === authenticatedSubject)
		.sort(
			(left, right) =>
				(right.claims?.iat ?? 0) - (left.claims?.iat ?? 0) ||
				(right.claims?.exp ?? 0) - (left.claims?.exp ?? 0) ||
				right.index - left.index,
		);
	return matching[0] ? [matching[0].value] : values;
}

function noStoreHeaders(init?: HeadersInit): Headers {
	const headers = new Headers(init);
	for (const [name, value] of Object.entries(SESSION_BROKER_NO_STORE_HEADERS)) {
		headers.set(name, value);
	}
	return headers;
}

function unavailableIntentResponse(osOrigin: string): Response {
	return new Response(
		`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Start sign-in again · Tedix</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f7f7f5; color: #111; }
    main { width: min(100%, 480px); padding: 32px; border: 1px solid #d9d9d4; border-radius: 16px; background: #fff; box-shadow: 0 12px 40px rgb(0 0 0 / 8%); }
    .eyebrow { margin: 0 0 12px; color: #62625d; font-size: 12px; font-weight: 700; letter-spacing: .12em; }
    h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.15; }
    p { margin: 0 0 16px; color: #4c4c47; line-height: 1.55; }
    a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; padding: 0 18px; border-radius: 10px; background: #111; color: #fff; font-weight: 650; text-decoration: none; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #f5f5f2; } main { background: #1b1b1a; border-color: #393936; } .eyebrow, p { color: #b8b8b0; } a { background: #f5f5f2; color: #111; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">TEDIX IDENTITY</p>
    <h1>This sign-in request is no longer active</h1>
    <p>For your security, Tedix sign-in links are short-lived and work only once. No access was granted by this request.</p>
    <p>Return to Tedix OS to start a fresh sign-in. If this came from the CLI, return to your terminal and run <code>tedix login</code> again.</p>
    <a href="${osOrigin}/">Return to Tedix OS</a>
  </main>
</body>
</html>`,
		{
			status: 410,
			headers: noStoreHeaders({
				"Content-Security-Policy":
					"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
				"Content-Type": "text/html; charset=utf-8",
			}),
		},
	);
}

function expireAuthSessionCookie(headers: Headers): void {
	headers.append(
		"Set-Cookie",
		serializeCookie(AUTH_SESSION_COOKIE, "", {
			httpOnly: true,
			maxAge: 0,
			path: "/",
			sameSite: "Lax",
			secure: true,
		}),
	);
}

function event(
	eventCode:
		| "session_rotation_failure"
		| "session_rotation_success"
		| "session_logout",
	input: { tenantId?: string | null; traceId: string },
	outcome: string,
	startedAt: number,
): void {
	console.info(
		JSON.stringify({
			eventCode,
			traceId: input.traceId,
			tenantId: input.tenantId ?? null,
			outcome,
			durationMs: Date.now() - startedAt,
		}),
	);
}

/**
 * The single refresh-rotation owner for one opaque browser-session handle.
 *
 * Raw refresh credentials live only in active RPC promises. SQLite stores a
 * one-way fingerprint and monotonic generation so an evicted object can reject
 * a consumed predecessor without retaining a credential. The explicit promise
 * tail is necessary because Durable Objects may interleave requests while an
 * external Descope fetch is pending.
 */
export class SessionRotationOwner extends DurableObject<BrokerEnv> {
	private queueTail: Promise<void> = Promise.resolve();
	private readonly inFlight = new Map<string, Promise<RotateSessionResult>>();
	private readonly logoutInFlight = new Map<
		string,
		Promise<LogoutSessionResult>
	>();
	private activeRefreshToken: string | null = null;
	private readonly activeLineage = new Set<string>();
	private pendingOperations = 0;

	constructor(ctx: DurableObjectState, env: BrokerEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS refresh_rotation_state (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					generation INTEGER NOT NULL,
					current_fingerprint TEXT,
					status TEXT NOT NULL CHECK (status IN ('ready', 'reauth_required')),
					updated_at INTEGER NOT NULL
				)
			`);
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS logout_replay_fingerprints (
					fingerprint TEXT PRIMARY KEY,
					logged_out_at INTEGER NOT NULL
				)
			`);
			return Promise.resolve();
		});
	}

	async rotate(input: RotateSessionInput): Promise<RotateSessionResult> {
		if (!isRotateSessionInput(input)) {
			return {
				ok: false,
				clearRefreshCookie: true,
				reason: "invalid_input",
			};
		}
		return this.enqueueSessionMutation(input);
	}

	async resume(input: ResumeSessionInput): Promise<RotateSessionResult> {
		if (!isResumeSessionInput(input)) {
			return {
				ok: false,
				clearRefreshCookie: true,
				reason: "invalid_input",
			};
		}
		return this.enqueueSessionMutation({ ...input, tenantId: null });
	}

	async logout(input: LogoutSessionInput): Promise<LogoutSessionResult> {
		if (!isResumeSessionInput(input)) {
			return {
				ok: false,
				clearRefreshCookie: true,
				reason: "invalid_input",
			};
		}
		const presentedFingerprint = await fingerprint(input.refreshToken);
		const existing = this.logoutInFlight.get(presentedFingerprint);
		if (existing) return existing;

		this.pendingOperations += 1;
		const operation = this.queueTail.then(() =>
			this.executeLogout(input, presentedFingerprint),
		);
		this.queueTail = operation.then(
			() => undefined,
			() => undefined,
		);
		const tracked = operation.finally(() => {
			this.finishOperation();
			if (this.logoutInFlight.get(presentedFingerprint) === tracked) {
				this.logoutInFlight.delete(presentedFingerprint);
			}
		});
		this.logoutInFlight.set(presentedFingerprint, tracked);
		return tracked;
	}

	private async enqueueSessionMutation(
		input: SessionMutationInput,
	): Promise<RotateSessionResult> {
		const presentedFingerprint = await fingerprint(input.refreshToken);
		const coalescingKey = `${presentedFingerprint}:${input.tenantId ?? "@resume"}`;
		const existing = this.inFlight.get(coalescingKey);
		if (existing) return existing;

		this.pendingOperations += 1;
		const operation = this.queueTail.then(() =>
			this.executeRotation(input, presentedFingerprint),
		);
		this.queueTail = operation.then(
			() => undefined,
			() => undefined,
		);
		const tracked = operation.finally(() => {
			this.finishOperation();
			if (this.inFlight.get(coalescingKey) === tracked) {
				this.inFlight.delete(coalescingKey);
			}
		});
		this.inFlight.set(coalescingKey, tracked);
		return tracked;
	}

	private finishOperation(): void {
		this.pendingOperations -= 1;
		if (this.pendingOperations === 0) {
			this.activeRefreshToken = null;
			this.activeLineage.clear();
		}
	}

	private readState(): RotationState | null {
		const row = this.ctx.storage.sql
			.exec<{
				generation: number;
				current_fingerprint: string | null;
				status: RotationState["status"];
			}>(
				"SELECT generation, current_fingerprint, status FROM refresh_rotation_state WHERE singleton = 1",
			)
			.toArray()[0];
		return row
			? {
					generation: row.generation,
					currentFingerprint: row.current_fingerprint,
					status: row.status,
				}
			: null;
	}

	private commitState(state: RotationState): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO refresh_rotation_state
				(singleton, generation, current_fingerprint, status, updated_at)
			 VALUES (1, ?, ?, ?, ?)
			 ON CONFLICT(singleton) DO UPDATE SET
				generation = excluded.generation,
				current_fingerprint = excluded.current_fingerprint,
				status = excluded.status,
				updated_at = excluded.updated_at`,
			state.generation,
			state.currentFingerprint,
			state.status,
			Date.now(),
		);
	}

	private async executeRotation(
		input: SessionMutationInput,
		presentedFingerprint: string,
	): Promise<RotateSessionResult> {
		const startedAt = Date.now();
		const state = this.readState();
		let refreshToken: string;

		if (this.activeRefreshToken) {
			if (this.activeLineage.has(presentedFingerprint)) {
				refreshToken = this.activeRefreshToken;
			} else {
				// An authenticated Descope flow (inbound-app consent, step-up) may
				// have advanced the family past our active token. Local memory is
				// not authority over Descope's session: revalidate the presented
				// value and adopt only a successful result. A consumed or forged
				// token fails at Descope and lands in reauth — the owner never
				// replays an older known token here, so reuse detection stays
				// untriggered.
				refreshToken = input.refreshToken;
			}
		} else if (!state) {
			refreshToken = input.refreshToken;
			this.activeLineage.add(presentedFingerprint);
		} else if (
			state.status === "ready" &&
			state.currentFingerprint === presentedFingerprint
		) {
			refreshToken = input.refreshToken;
			this.activeLineage.add(presentedFingerprint);
		} else {
			// A previous local failure is not permanent authority over Descope's
			// session. Login and consent may replace the DSR, and an adapter defect
			// may have rejected a token Descope still accepts. Revalidate through
			// Descope and adopt only a successful result; the intent boundary and
			// single-flight owner keep retries bounded.
			refreshToken = input.refreshToken;
		}

		let selected = null;
		if (!input.tenantId && input.sessionToken) {
			try {
				await validateToken(input.sessionToken, {
					baseUrl: this.env.DESCOPE_BASE_URL,
					projectId: this.env.DESCOPE_PROJECT_ID,
				});
				// A freshly authenticated browser already has a signed, unexpired DS.
				// Adopt it without consuming the new DSR merely to reach the picker;
				// tenant selection is the single operation that rotates that family.
				selected = {
					refreshJwt: refreshToken,
					sessionJwt: input.sessionToken,
				};
			} catch (error) {
				console.warn(
					JSON.stringify({
						event: "descope.session_token_validation_failed",
						exception: sessionExceptionTopology(error),
					}),
				);
				// An absent/expired/invalid DS falls through to Descope refresh.
			}
		}
		selected ??= input.tenantId
			? await selectDescopeTenantSession({
					baseUrl: this.env.DESCOPE_BASE_URL,
					fetch,
					projectId: this.env.DESCOPE_PROJECT_ID,
					refreshToken,
					tenantId: input.tenantId,
				})
			: await resumeDescopeSession({
					baseUrl: this.env.DESCOPE_BASE_URL,
					fetch,
					projectId: this.env.DESCOPE_PROJECT_ID,
					refreshToken,
				});
		if (!selected?.refreshJwt) {
			if (
				state?.status === "ready" &&
				state.currentFingerprint !== presentedFingerprint
			) {
				event(
					"session_rotation_failure",
					input,
					"refresh_chain_invalid",
					startedAt,
				);
				return {
					ok: false,
					clearRefreshCookie: false,
					reason: "refresh_chain_invalid",
				};
			}
			const generation = state?.generation ?? 0;
			this.commitState({
				generation,
				currentFingerprint: presentedFingerprint,
				status: "reauth_required",
			});
			this.activeRefreshToken = null;
			this.activeLineage.clear();
			event("session_rotation_failure", input, "descope_rejected", startedAt);
			return {
				ok: false,
				clearRefreshCookie: true,
				reason: "descope_rejected",
			};
		}

		const nextFingerprint = await fingerprint(selected.refreshJwt);
		const generation = (state?.generation ?? 0) + 1;
		this.commitState({
			generation,
			currentFingerprint: nextFingerprint,
			status: "ready",
		});
		this.activeRefreshToken = selected.refreshJwt;
		this.activeLineage.add(presentedFingerprint);
		this.activeLineage.add(nextFingerprint);
		event("session_rotation_success", input, "rotated", startedAt);
		return {
			ok: true,
			generation,
			refreshCookieMaxAge: selected.refreshCookieMaxAge,
			refreshToken: selected.refreshJwt,
			sessionToken: selected.sessionJwt,
		};
	}

	private async executeLogout(
		input: LogoutSessionInput,
		presentedFingerprint: string,
	): Promise<LogoutSessionResult> {
		const startedAt = Date.now();
		const replay = this.ctx.storage.sql
			.exec<{ fingerprint: string }>(
				"SELECT fingerprint FROM logout_replay_fingerprints WHERE fingerprint = ?",
				presentedFingerprint,
			)
			.toArray()[0];
		if (replay) {
			event("session_logout", input, "already_invalid", startedAt);
			return { ok: true, outcome: "already_invalid" };
		}

		const state = this.readState();
		let refreshToken: string;
		if (this.activeRefreshToken) {
			if (!this.activeLineage.has(presentedFingerprint)) {
				event("session_logout", input, "refresh_chain_invalid", startedAt);
				return {
					ok: false,
					clearRefreshCookie: true,
					reason: "refresh_chain_invalid",
				};
			}
			refreshToken = this.activeRefreshToken;
		} else if (!state) {
			refreshToken = input.refreshToken;
			this.activeLineage.add(presentedFingerprint);
		} else if (
			state.status === "ready" &&
			state.currentFingerprint === presentedFingerprint
		) {
			refreshToken = input.refreshToken;
			this.activeLineage.add(presentedFingerprint);
		} else {
			event("session_logout", input, "refresh_chain_invalid", startedAt);
			return {
				ok: false,
				clearRefreshCookie: true,
				reason: "refresh_chain_invalid",
			};
		}

		const activeFingerprint = await fingerprint(refreshToken);
		const outcome = await logoutDescopeSession({
			baseUrl: this.env.DESCOPE_BASE_URL,
			fetch,
			projectId: this.env.DESCOPE_PROJECT_ID,
			refreshToken,
		});
		for (const replayFingerprint of new Set([
			...this.activeLineage,
			presentedFingerprint,
			activeFingerprint,
		])) {
			this.ctx.storage.sql.exec(
				`INSERT INTO logout_replay_fingerprints (fingerprint, logged_out_at)
				 VALUES (?, ?) ON CONFLICT(fingerprint) DO UPDATE SET
				 logged_out_at = excluded.logged_out_at`,
				replayFingerprint,
				Date.now(),
			);
		}
		this.commitState({
			generation: state?.generation ?? 0,
			currentFingerprint: null,
			status: "reauth_required",
		});
		this.activeRefreshToken = null;
		this.activeLineage.clear();
		await this.ctx.storage.setAlarm(
			Date.now() + AUTH_SESSION_MAX_AGE_SECONDS * 1000,
		);
		event("session_logout", input, outcome, startedAt);
		return { ok: true, outcome };
	}

	async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

async function createIntentForSurface(
	env: BrokerEnv,
	surface: SessionBrokerSurface,
	input: CreateSessionBrokerIntentInput,
): Promise<CreateSessionBrokerIntentResult> {
	const issuedAt = Math.floor(Date.now() / 1000);
	const intentId = randomReference();
	const intent = assertSessionBrokerIntent(
		{
			...input,
			callbackPath: SESSION_BROKER_CALLBACK_PATHS[surface],
			expiresAt: issuedAt + SESSION_BROKER_INTENT_TTL_SECONDS,
			intentId,
			issuedAt,
			surface,
			version: 1,
		},
		issuedAt,
		brokerOrigins(env).osOrigin,
	);
	const created =
		await env.SESSION_INTENTS.getByName(intentId).initialize(intent);
	if (!created) throw new Error("Session broker intent collision");
	return {
		authorizeUrl: buildSessionBrokerAuthorizeUrl(
			intentId,
			brokerOrigins(env).brokerOrigin,
		),
		expiresAt: intent.expiresAt,
		intentId,
	};
}

async function exchangeCodeForSurface(
	env: BrokerEnv,
	surface: SessionBrokerSurface,
	input: ExchangeSessionBrokerCodeInput,
): Promise<SessionBrokerExchangeResult> {
	const codeHash = await digestReference(input.code);
	const result = await env.SESSION_INTENTS.getByName(input.intentId).exchange(
		input,
		surface,
		codeHash,
	);
	if (!result) throw new Error("Session broker code rejected");
	return result;
}

abstract class SurfaceSessionBroker extends WorkerEntrypoint<BrokerEnv> {
	protected abstract readonly surface: SessionBrokerSurface;

	createIntent(
		input: CreateSessionBrokerIntentInput,
	): Promise<CreateSessionBrokerIntentResult> {
		return createIntentForSurface(this.env, this.surface, input);
	}

	exchangeCode(
		input: ExchangeSessionBrokerCodeInput,
	): Promise<SessionBrokerExchangeResult> {
		return exchangeCodeForSurface(this.env, this.surface, input);
	}
}

export class OsSessionBroker extends SurfaceSessionBroker {
	protected readonly surface = "os" as const;
}

export class DocsSessionBroker extends SurfaceSessionBroker {
	protected readonly surface = "docs" as const;
}

export class CliSessionBroker extends SurfaceSessionBroker {
	protected readonly surface = "cli" as const;
}

export class CmsSessionBroker extends SurfaceSessionBroker {
	protected readonly surface = "cms" as const;
}

async function authorizeFailure(
	intentOwner: DurableObjectStub<SessionIntentOwner>,
	intent: SessionBrokerIntent,
	error: "invalid_request" | "reauth_required" | "session_unavailable",
	clearRefresh: boolean,
	brokerHostname: string,
	osOrigin?: string,
): Promise<Response> {
	await intentOwner.fail();
	const headers = noStoreHeaders({
		Location: buildSessionBrokerErrorCallbackUrl(
			intent,
			error,
			undefined,
			osOrigin,
		),
	});
	if (clearRefresh) {
		expireRefreshAndSessionCookies(headers, brokerHostname);
		expireAuthSessionCookie(headers);
	}
	return new Response(null, { status: 302, headers });
}

async function authorizeThroughCentralLogin(
	intentOwner: DurableObjectStub<SessionIntentOwner>,
	intent: SessionBrokerIntent,
	clearRefresh: boolean,
	brokerHostname: string,
	osOrigin?: string,
): Promise<Response> {
	if (!(await intentOwner.beginReauthentication())) {
		return authorizeFailure(
			intentOwner,
			intent,
			"reauth_required",
			clearRefresh,
			brokerHostname,
			osOrigin,
		);
	}
	const headers = noStoreHeaders({
		Location: buildSessionBrokerLoginUrl(intent.intentId, {
			skipOrganizationPreparation: intent.operation === "outbound_connect",
			osOrigin,
		}),
	});
	if (clearRefresh) {
		expireRefreshAndSessionCookies(headers, brokerHostname);
		expireAuthSessionCookie(headers);
	}
	return new Response(null, { status: 302, headers });
}

function outboundFailureRedirect(
	intent: SessionBrokerIntent,
	reason = "provider_unavailable",
): Response {
	const target = new URL(intent.redirectPath, intent.targetOrigin);
	target.searchParams.set("connectError", reason);
	return new Response(null, {
		status: 302,
		headers: noStoreHeaders({ Location: target.toString() }),
	});
}

async function startOutboundConnect(
	request: Request,
	env: BrokerEnv,
	intent: SessionBrokerIntent,
	refreshToken: string,
): Promise<Response> {
	// This is a rejection precheck, not authority from unverified claims:
	// Descope authenticates the refresh JWT before creating its OAuth flow.
	// A modified subject fails Descope's signature validation, while a genuine
	// different user's central cookie must never write into this named slot.
	if (
		intent.outboundUserId &&
		decodeUnverifiedJwtClaims(refreshToken)?.sub !== intent.outboundUserId
	)
		return outboundFailureRedirect(intent, "account_mismatch");
	const callback = new URL(OUTBOUND_CALLBACK_PATH, request.url);
	callback.searchParams.set("intent", intent.intentId);
	// Starting a provider flow is not idempotent: descopeFetch bounds each
	// attempt and retries only Descope's pre-execution 429.
	const response = await descopeFetch(
		"https://api.descope.com/v1/outbound/oauth/connect",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.DESCOPE_PROJECT_ID}:${refreshToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				appId: intent.outboundAppId,
				...(intent.tenantId
					? { tenantId: intent.tenantId, tenantLevel: true }
					: {}),
				options: {
					redirectUrl: callback.toString(),
					...(intent.outboundScopes?.length
						? { scopes: intent.outboundScopes }
						: {}),
					...(intent.outboundExternalIdentifier
						? { externalIdentifier: intent.outboundExternalIdentifier }
						: {}),
				},
			}),
		},
		{ idempotent: false },
	).catch(() => null);
	if (!response) return outboundFailureRedirect(intent);
	const body = (await response.json().catch(() => null)) as {
		url?: unknown;
	} | null;
	if (!response.ok || typeof body?.url !== "string") {
		return outboundFailureRedirect(intent);
	}
	try {
		const destination = new URL(body.url);
		if (destination.protocol !== "https:") throw new Error("invalid redirect");
		return new Response(null, {
			status: 302,
			headers: noStoreHeaders({ Location: destination.toString() }),
		});
	} catch {
		return outboundFailureRedirect(intent);
	}
}

async function authorize(request: Request, env: BrokerEnv): Promise<Response> {
	const url = new URL(request.url);
	const brokerHostname = url.hostname;
	const { osOrigin, brokerOrigin } = brokerOrigins(env);
	if (request.method !== "GET" && request.method !== "POST") {
		return new Response("Method Not Allowed\n", {
			status: 405,
			headers: noStoreHeaders({ Allow: "GET, POST" }),
		});
	}
	let authenticatedSessionToken: string | undefined;
	if (request.method === "POST") {
		const origin = request.headers.get("Origin");
		const redirectedSameSitePost =
			origin === "null" &&
			request.headers.get("Sec-Fetch-Site") === "same-site";
		if (
			origin !== (osOrigin ?? "https://os.tedix.dev") &&
			!redirectedSameSitePost
		) {
			return new Response("Invalid authorization origin\n", {
				status: 403,
				headers: noStoreHeaders(),
			});
		}
		const form = await request.formData();
		const submittedSessions = form.getAll("session_token");
		const submitted = submittedSessions[0];
		if (
			submittedSessions.length !== 1 ||
			typeof submitted !== "string" ||
			submitted.length === 0 ||
			submitted.length > MAX_REFRESH_TOKEN_LENGTH
		) {
			return new Response("Invalid authenticated session\n", {
				status: 400,
				headers: noStoreHeaders(),
			});
		}
		authenticatedSessionToken = submitted;
	}
	if (request.headers.get("Sec-Fetch-Dest") !== "document") {
		return new Response("Top-level navigation required\n", {
			status: 400,
			headers: noStoreHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
		});
	}
	const intentId = url.searchParams.get("intent") ?? "";
	try {
		buildSessionBrokerAuthorizeUrl(intentId, brokerOrigin);
	} catch {
		return new Response("Invalid session request\n", {
			status: 400,
			headers: noStoreHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
		});
	}
	const intentOwner = env.SESSION_INTENTS.getByName(intentId);
	const intent = await intentOwner.readPending();
	if (!intent) {
		return unavailableIntentResponse(osOrigin ?? "https://os.tedix.dev");
	}
	const brokerRefreshValues = distinctCookieValues(
		request.headers.get("Cookie"),
		BROKER_REFRESH_COOKIE,
	);
	const descopeRefreshValues = distinctCookieValues(
		request.headers.get("Cookie"),
		DESCOPE_REFRESH_COOKIE,
	);
	// The broker deliberately writes both names on every rotation: `TEDIX_DSR`
	// as its steady-state authority and a Descope-identity `DSR` twin so
	// authenticated Descope flows (consent, step-up) can hydrate. A flow-side
	// rotation replaces the twin in place, so the two families can legitimately
	// diverge by exactly one issuance; selection resolves that by newest
	// same-subject issuance rather than preferring either name blindly.
	const refreshValues = selectAuthoritativeRefreshValue(
		brokerRefreshValues,
		descopeRefreshValues,
		authenticatedSessionToken,
	);
	if (intent.operation !== "logout" && refreshValues.length !== 1) {
		console.info(
			JSON.stringify({
				eventCode: "session_refresh_cookie_unavailable",
				operation: intent.operation,
				refreshCookieCount: refreshValues.length,
				brokerRefreshCookieCount: brokerRefreshValues.length,
				descopeRefreshCookieCount: descopeRefreshValues.length,
				cookieNames: cookieNames(request.headers.get("Cookie")),
			}),
		);
		return authorizeThroughCentralLogin(
			intentOwner,
			intent,
			refreshValues.length > 1,
			brokerHostname,
			osOrigin,
		);
	}
	if (intent.operation === "outbound_connect") {
		return startOutboundConnect(request, env, intent, refreshValues[0]!);
	}
	const sessionValues = distinctCookieValues(
		request.headers.get("Cookie"),
		AUTH_SESSION_COOKIE,
	);
	if (
		intent.operation !== "logout" &&
		!authenticatedSessionToken &&
		sessionValues.length > 1
	) {
		return authorizeFailure(
			intentOwner,
			intent,
			"invalid_request",
			false,
			brokerHostname,
			osOrigin,
		);
	}
	const descopeSessionValues = distinctCookieValues(
		request.headers.get("Cookie"),
		DESCOPE_SESSION_COOKIE,
	);
	if (
		intent.operation !== "logout" &&
		!authenticatedSessionToken &&
		descopeSessionValues.length > 1
	) {
		return authorizeFailure(
			intentOwner,
			intent,
			"invalid_request",
			true,
			brokerHostname,
			osOrigin,
		);
	}
	const traceId = randomReference();
	if (intent.operation === "logout") {
		if (refreshValues.length === 1 && sessionValues.length <= 1) {
			const logoutSessionId =
				sessionValues[0] && SESSION_ID_PATTERN.test(sessionValues[0])
					? sessionValues[0]
					: randomReference();
			await env.SESSION_ROTATION.getByName(logoutSessionId).logout({
				refreshToken: refreshValues[0]!,
				traceId,
			});
		}
		const code = randomReference();
		const codeExpiresAt =
			Math.floor(Date.now() / 1000) + SESSION_BROKER_CODE_TTL_SECONDS;
		const grant: StoreLogoutGrantInput = {
			codeExpiresAt,
			codeHash: await digestReference(code),
		};
		if (!(await intentOwner.storeLogoutGrant(grant))) {
			return authorizeFailure(
				intentOwner,
				intent,
				"session_unavailable",
				true,
				brokerHostname,
				osOrigin,
			);
		}
		const headers = noStoreHeaders({
			Location: buildSessionBrokerCallbackUrl(
				intent,
				code,
				undefined,
				osOrigin,
			),
		});
		expireRefreshAndSessionCookies(headers, brokerHostname);
		expireAuthSessionCookie(headers);
		return new Response(null, { status: 302, headers });
	}
	// First login carries no TEDIX_AUTH_SESSION_ID yet. A random per-request
	// fallback would route concurrent authorize requests that share one DS
	// refresh cookie to different SessionRotationOwner objects, so the
	// per-object single-flight never engages and each object presents the same
	// DSR to Descope's rotation endpoint — tripping refresh-token-family replay
	// protection (E064006). Derive a stable id from the presented refresh cookie
	// instead: every concurrent rotation of one DSR converges on a single owner
	// that serializes and coalesces them. Uses the same one-way SHA-256 digest as
	// correlation/state, so the raw token never appears in the id, and the digest
	// satisfies SESSION_ID_PATTERN so the id round-trips through the cookie.
	const browserSessionId =
		!authenticatedSessionToken &&
		sessionValues[0] &&
		SESSION_ID_PATTERN.test(sessionValues[0])
			? sessionValues[0]
			: await digestReference(refreshValues[0]!);
	const rotationOwner = env.SESSION_ROTATION.getByName(browserSessionId);
	const rotated =
		intent.operation === "issue_session"
			? await rotationOwner.rotate({
					refreshToken: refreshValues[0]!,
					tenantId: intent.tenantId!,
					traceId,
				})
			: await rotationOwner.resume({
					refreshToken: refreshValues[0]!,
					sessionToken: authenticatedSessionToken ?? descopeSessionValues[0],
					traceId,
				});
	if (!rotated.ok) {
		return authorizeThroughCentralLogin(
			intentOwner,
			intent,
			rotated.clearRefreshCookie,
			brokerHostname,
			osOrigin,
		);
	}
	const claims = decodeJwtClaims(rotated.sessionToken);
	const grantedTenantId =
		intent.operation === "issue_session"
			? intent.tenantId
			: typeof claims?.dct === "string"
				? claims.dct
				: null;
	if (
		!claims?.sub ||
		(grantedTenantId !== null &&
			(!TENANT_ID_PATTERN.test(grantedTenantId) ||
				claims.dct !== grantedTenantId)) ||
		(intent.operation === "issue_session" && grantedTenantId === null) ||
		!Number.isInteger(claims.exp) ||
		(claims.exp ?? 0) <= Math.floor(Date.now() / 1000)
	) {
		console.warn(
			JSON.stringify({
				event: "session_authorize_failed",
				reason: "invalid_session_claims",
				traceId,
			}),
		);
		return authorizeFailure(
			intentOwner,
			intent,
			"session_unavailable",
			true,
			brokerHostname,
			osOrigin,
		);
	}
	const code = randomReference();
	const codeExpiresAt =
		Math.floor(Date.now() / 1000) + SESSION_BROKER_CODE_TTL_SECONDS;
	const grant: StoreSessionGrantInput = {
		codeExpiresAt,
		codeHash: await digestReference(code),
		sessionExpiresAt: claims.exp!,
		sessionJwt: rotated.sessionToken,
		subject: claims.sub,
		tenantId: grantedTenantId,
	};
	if (!(await intentOwner.storeSessionGrant(grant))) {
		console.warn(
			JSON.stringify({
				event: "session_authorize_failed",
				reason: "grant_not_stored",
				traceId,
			}),
		);
		return authorizeFailure(
			intentOwner,
			intent,
			"session_unavailable",
			false,
			brokerHostname,
			osOrigin,
		);
	}

	const headers = noStoreHeaders({
		Location: buildSessionBrokerCallbackUrl(intent, code, undefined, osOrigin),
	});
	headers.append(
		"Set-Cookie",
		serializeCookie(AUTH_SESSION_COOKIE, browserSessionId, {
			httpOnly: true,
			maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
			path: "/",
			sameSite: "Lax",
			secure: true,
		}),
	);
	appendRotatedRefreshCookie(headers, rotated, brokerHostname);
	return new Response(null, { status: 302, headers });
}

export default {
	async fetch(request: Request, env: BrokerEnv): Promise<Response> {
		const url = new URL(request.url);
		let brokerOrigin: string;
		try {
			brokerOrigin = brokerOrigins(env).brokerOrigin;
		} catch {
			return new Response("Session broker misconfigured\n", { status: 503 });
		}
		if (url.origin !== brokerOrigin) {
			return new Response("Not Found\n", {
				status: 404,
				headers: noStoreHeaders(),
			});
		}
		// authz: public — release health contains only status and the source commit SHA.
		if (url.pathname === HEALTH_PATH) {
			return Response.json({
				status: "ok",
				deployedSha: String(env.GIT_SHA || "unknown"),
			});
		}
		// authz: public — central-login authorize endpoint: the auth flow itself. It verifies the signed intent reference and rotates the Descope refresh cookie before granting anything.
		if (url.pathname === AUTHORIZE_PATH) {
			return authorize(request, env);
		}
		if (url.pathname === OUTBOUND_CALLBACK_PATH && request.method === "GET") {
			const intentId = url.searchParams.get("intent") ?? "";
			try {
				buildSessionBrokerAuthorizeUrl(intentId, brokerOrigin);
			} catch {
				return new Response("Invalid outbound callback\n", { status: 400 });
			}
			const intent =
				await env.SESSION_INTENTS.getByName(intentId).consumeOutbound();
			if (!intent)
				return new Response("Outbound request expired\n", { status: 410 });
			return new Response(null, {
				status: 302,
				headers: noStoreHeaders({
					Location: new URL(
						intent.redirectPath,
						intent.targetOrigin,
					).toString(),
				}),
			});
		}
		return new Response("Not Found\n", {
			status: 404,
			headers: {
				"Cache-Control": "no-store",
				"Content-Type": "text/plain; charset=utf-8",
				"X-Content-Type-Options": "nosniff",
			},
		});
	},
} satisfies ExportedHandler<BrokerEnv>;

export { SessionIntentOwner } from "./intent-owner";
