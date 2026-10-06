import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	SESSION_BROKER_CALLBACK_PATHS,
	type SessionBrokerIntent,
} from "@tedix/auth/session-broker";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BrokerEnv } from "./env";
import brokerWorker from "./index";
import type {
	RotateSessionInput,
	SessionIntentOwner,
	SessionRotationOwner,
} from "./index";

function sessionStub(label: string) {
	return env.SESSION_ROTATION.getByName(
		`${label}_${crypto.randomUUID().replaceAll("-", "")}`,
	);
}

function rotationInput(
	tenantId: string,
	refreshToken = "refresh-old",
): RotateSessionInput {
	return {
		refreshToken,
		tenantId,
		traceId: `trace-${tenantId}`,
	};
}

function selectedSession(sessionToken: string, refreshToken: string): Response {
	return Response.json({ sessionJwt: sessionToken, refreshJwt: refreshToken });
}

function jwt(claims: Record<string, unknown>): string {
	const encode = (value: object) =>
		btoa(JSON.stringify(value))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.signature`;
}

function brokerIntent(
	intentId: string,
	overrides: Partial<SessionBrokerIntent> = {},
): SessionBrokerIntent {
	const now = Math.floor(Date.now() / 1000);
	return {
		callbackPath: SESSION_BROKER_CALLBACK_PATHS.os,
		expiresAt: now + 60,
		intentId,
		issuedAt: now,
		operation: "issue_session",
		redirectPath: "/organizations/tedix",
		stateHash: `sha256-${"a".repeat(43)}`,
		surface: "os",
		targetOrigin: "https://tedix.os.tedix.dev",
		tenantId: "org_tedix",
		version: 1,
		...overrides,
	};
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	let binary = "";
	for (const byte of new Uint8Array(digest))
		binary += String.fromCharCode(byte);
	return `sha256-${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function authorizationHeader(call: unknown[]): string | undefined {
	const init = call[1] as RequestInit | undefined;
	return new Headers(init?.headers).get("Authorization") ?? undefined;
}

function cookieHeader(call: unknown[]): string | undefined {
	const init = call[1] as RequestInit | undefined;
	return new Headers(init?.headers).get("Cookie") ?? undefined;
}

function authSessionCookie(response: Response): string {
	const cookie = response.headers
		.getSetCookie()
		.find((entry) => entry.startsWith("TEDIX_AUTH_SESSION_ID="));
	if (!cookie) return "";
	const value = cookie.slice("TEDIX_AUTH_SESSION_ID=".length).split(";")[0]!;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("worker health", () => {
	it("routes only its exact installation auth host", async () => {
		const customEnv = {
			...env,
			OS_URL: "https://os.acme.example",
			SESSION_BROKER_URL: "https://auth.acme.example",
			DESCOPE_BASE_URL: "https://auth.acme.example",
		} as BrokerEnv;
		const own = await brokerWorker.fetch(
			new Request("https://auth.acme.example/tedix/session/health"),
			customEnv,
		);
		expect(own.status).toBe(200);
		for (const host of ["auth.tedix.dev", "auth.acme.example.evil.test"]) {
			const response = await brokerWorker.fetch(
				new Request(`https://${host}/tedix/session/health`),
				customEnv,
			);
			expect(response.status).toBe(404);
		}
		const split = await brokerWorker.fetch(
			new Request("https://auth.acme.example/tedix/session/health"),
			{ ...customEnv, DESCOPE_BASE_URL: "https://api.descope.com" },
		);
		expect(split.status).toBe(503);
	});
	it("accepts only the configured OS origin for an authentication POST", async () => {
		const customEnv = {
			...env,
			OS_URL: "https://os.acme.example",
			SESSION_BROKER_URL: "https://auth.acme.example",
			DESCOPE_BASE_URL: "https://auth.acme.example",
		} as BrokerEnv;
		const request = (origin: string) =>
			new Request(
				`https://auth.acme.example/tedix/session/authorize?intent=${"a".repeat(43)}`,
				{
					method: "POST",
					headers: {
						Origin: origin,
						"Sec-Fetch-Dest": "document",
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: "session_token=dummy",
				},
			);
		const rejected = await brokerWorker.fetch(
			request("https://os.tedix.dev"),
			customEnv,
		);
		expect(rejected.status).toBe(403);
		const accepted = await brokerWorker.fetch(
			request("https://os.acme.example"),
			customEnv,
		);
		expect(accepted.status).toBe(410); // The synthetic intent does not exist.
	});
	it("reports the deployed release SHA", async () => {
		const response = await SELF.fetch(
			"https://auth.tedix.dev/tedix/session/health",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			deployedSha: "test-release-sha",
		});
	});
});

describe("SessionRotationOwner", () => {
	it("coalesces identical requests so one old refresh token reaches Descope once", async () => {
		let releaseFetch: (() => void) | undefined;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		const fetchMock = vi.fn(async () => {
			await fetchGate;
			return selectedSession("session-one", "refresh-one");
		});
		vi.stubGlobal("fetch", fetchMock);
		const stub = sessionStub("coalesce");
		const input = rotationInput("tenant-one");

		const first = stub.rotate(input);
		const second = stub.rotate(input);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		releaseFetch?.();

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult).toEqual(secondResult);
		expect(firstResult).toMatchObject({
			ok: true,
			generation: 1,
			refreshToken: "refresh-one",
			sessionToken: "session-one",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("serializes different tenants onto the newest rotated refresh token", async () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				await firstGate;
				return selectedSession("session-one", "refresh-one");
			})
			.mockImplementationOnce(async () =>
				selectedSession("session-two", "refresh-two"),
			);
		vi.stubGlobal("fetch", fetchMock);
		const stub = sessionStub("tenants");

		const first = stub.rotate(rotationInput("tenant-one"));
		const second = stub.rotate(rotationInput("tenant-two"));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		releaseFirst?.();

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult).toMatchObject({
			ok: true,
			generation: 1,
			refreshToken: "refresh-one",
		});
		expect(secondResult).toMatchObject({
			ok: true,
			generation: 2,
			refreshToken: "refresh-two",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(authorizationHeader(fetchMock.mock.calls[0] ?? [])).toBe(
			`Bearer ${env.DESCOPE_PROJECT_ID}`,
		);
		expect(cookieHeader(fetchMock.mock.calls[0] ?? [])).toBe("DSR=refresh-old");
		expect(cookieHeader(fetchMock.mock.calls[1] ?? [])).toBe("DSR=refresh-one");

		const stored = await runInDurableObject(
			stub,
			(_instance: SessionRotationOwner, state) =>
				state.storage.sql
					.exec(
						"SELECT generation, current_fingerprint, status FROM refresh_rotation_state",
					)
					.toArray(),
		);
		const persisted = JSON.stringify(stored);
		expect(persisted).toContain('"generation":2');
		expect(persisted).not.toContain("refresh-old");
		expect(persisted).not.toContain("refresh-one");
		expect(persisted).not.toContain("refresh-two");
		expect(persisted).not.toContain("session-one");
		expect(persisted).not.toContain("session-two");

		const logs = JSON.stringify(log.mock.calls);
		expect(logs).not.toContain("refresh-old");
		expect(logs).not.toContain("refresh-one");
		expect(logs).not.toContain("refresh-two");
		expect(logs).not.toContain("session-one");
		expect(logs).not.toContain("session-two");
	});

	it("adopts a Descope-validated refresh successor advanced by consent", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () =>
				selectedSession("session-one", "refresh-one"),
			)
			.mockImplementationOnce(async () =>
				selectedSession("session-two", "refresh-two"),
			)
			.mockImplementationOnce(async () => new Response(null, { status: 401 }))
			.mockImplementationOnce(async () =>
				selectedSession("session-three", "refresh-three"),
			);
		vi.stubGlobal("fetch", fetchMock);
		const stub = sessionStub("consent-successor");

		await expect(
			stub.rotate(rotationInput("tenant-one")),
		).resolves.toMatchObject({
			generation: 1,
			ok: true,
			refreshToken: "refresh-one",
		});
		await expect(
			stub.rotate(rotationInput("tenant-one", "refresh-from-consent")),
		).resolves.toMatchObject({
			generation: 2,
			ok: true,
			refreshToken: "refresh-two",
		});
		expect(cookieHeader(fetchMock.mock.calls[1] ?? [])).toBe(
			"DSR=refresh-from-consent",
		);

		await expect(
			stub.rotate(rotationInput("tenant-one", "stale-refresh")),
		).resolves.toEqual({
			ok: false,
			clearRefreshCookie: false,
			reason: "refresh_chain_invalid",
		});
		await expect(
			stub.rotate(rotationInput("tenant-one", "refresh-two")),
		).resolves.toMatchObject({
			generation: 3,
			ok: true,
			refreshToken: "refresh-three",
		});
	});

	it("resumes the current tenant without caller tenant authority, then selects from the rotated successor", async () => {
		let releaseResume: (() => void) | undefined;
		const resumeGate = new Promise<void>((resolve) => {
			releaseResume = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				await resumeGate;
				return selectedSession("resumed-session", "refresh-resumed");
			})
			.mockImplementationOnce(async () =>
				selectedSession("selected-session", "refresh-selected"),
			);
		vi.stubGlobal("fetch", fetchMock);
		const stub = sessionStub("resume-select");

		const resumed = stub.resume({
			refreshToken: "refresh-old",
			traceId: "trace-resume",
		});
		const selected = stub.rotate(rotationInput("tenant-two"));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		releaseResume?.();

		await expect(resumed).resolves.toMatchObject({
			generation: 1,
			ok: true,
			refreshToken: "refresh-resumed",
		});
		await expect(selected).resolves.toMatchObject({
			generation: 2,
			ok: true,
			refreshToken: "refresh-selected",
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://auth.tedix.dev/v1/auth/refresh",
		);
		expect(cookieHeader(fetchMock.mock.calls[1] ?? [])).toBe(
			"DSR=refresh-resumed",
		);
	});

	it("logs a content-free validation failure and falls through to Descope refresh", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const fetchMock = vi.fn(async () =>
			selectedSession("refreshed-session", "refresh-next"),
		);
		vi.stubGlobal("fetch", fetchMock);
		const stub = sessionStub("invalid-session-token");

		await expect(
			stub.resume({
				refreshToken: "refresh-old",
				sessionToken: "DS=secret-session-token",
				traceId: "trace-invalid-session",
			}),
		).resolves.toMatchObject({
			ok: true,
			refreshToken: "refresh-next",
			sessionToken: "refreshed-session",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const records = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(records).toContainEqual({
			event: "descope.session_token_validation_failed",
			exception: expect.objectContaining({ type: expect.any(String) }),
		});
		expect(JSON.stringify(records)).not.toContain("secret-session-token");
	});

	it("logs out the newest refresh successor exactly once across retries", async () => {
		let releaseLogout: (() => void) | undefined;
		const logoutGate = new Promise<void>((resolve) => {
			releaseLogout = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () =>
				selectedSession("resumed-session", "refresh-new"),
			)
			.mockImplementationOnce(async () => {
				await logoutGate;
				return new Response(null, { status: 204 });
			});
		vi.stubGlobal("fetch", fetchMock);
		const stub = sessionStub("logout-once");
		await stub.resume({
			refreshToken: "refresh-old",
			traceId: "trace-resume",
		});

		const logoutInput = {
			refreshToken: "refresh-new",
			traceId: "trace-logout",
		};
		const firstLogout = stub.logout(logoutInput);
		const concurrentLogout = stub.logout(logoutInput);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		releaseLogout?.();
		await expect(firstLogout).resolves.toEqual({
			ok: true,
			outcome: "revoked",
		});
		await expect(concurrentLogout).resolves.toEqual({
			ok: true,
			outcome: "revoked",
		});
		await expect(stub.logout(logoutInput)).resolves.toEqual({
			ok: true,
			outcome: "already_invalid",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
			"https://auth.tedix.dev/v1/auth/logout",
		);
		expect(cookieHeader(fetchMock.mock.calls[1] ?? [])).toBe("DSR=refresh-new");
	});

	it("fails closed without persisting or logging credentials", async () => {
		const refreshToken = "refresh-must-never-leak";
		const sessionToken = "session-must-never-leak";
		const fetchMock = vi.fn(async () =>
			Response.json({ sessionJwt: sessionToken }, { status: 401 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const stub = sessionStub("failure");
		const input = rotationInput("tenant-one", refreshToken);

		await expect(stub.rotate(input)).resolves.toEqual({
			ok: false,
			clearRefreshCookie: true,
			reason: "descope_rejected",
		});
		await expect(stub.rotate(input)).resolves.toEqual({
			ok: false,
			clearRefreshCookie: true,
			reason: "descope_rejected",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const stored = await runInDurableObject(
			stub,
			(_instance: SessionRotationOwner, state) =>
				state.storage.sql
					.exec(
						"SELECT generation, current_fingerprint, status FROM refresh_rotation_state",
					)
					.toArray(),
		);
		const persisted = JSON.stringify(stored);
		expect(persisted).toContain("reauth_required");
		expect(persisted).not.toContain(refreshToken);
		expect(persisted).not.toContain(sessionToken);

		const logs = JSON.stringify(log.mock.calls);
		expect(logs).toContain("session_rotation_failure");
		expect(logs).not.toContain(refreshToken);
		expect(logs).not.toContain(sessionToken);
	});

	it("recovers a failed browser lineage after Descope validates a new login", async () => {
		const stub = sessionStub("reauth-recovery");
		const rejected = rotationInput("tenant-one", "refresh-rejected");
		const recovered = rotationInput("tenant-one", "refresh-after-login");
		const sessionToken = jwt({
			dct: "tenant-one",
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-after-login",
		});
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
			new Headers(init?.headers).get("Cookie") === "DSR=refresh-after-login"
				? selectedSession(sessionToken, "refresh-after-login-rotated")
				: Response.json({}, { status: 401 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(stub.rotate(rejected)).resolves.toMatchObject({
			ok: false,
			reason: "descope_rejected",
		});
		await expect(stub.rotate(rejected)).resolves.toMatchObject({
			ok: false,
			reason: "descope_rejected",
		});
		await expect(stub.rotate(recovered)).resolves.toMatchObject({
			ok: true,
			refreshToken: "refresh-after-login-rotated",
			sessionToken,
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(cookieHeader(fetchMock.mock.calls[2] ?? [])).toBe(
			"DSR=refresh-after-login",
		);
	});
});

describe("public Worker isolation", () => {
	it("does not expose rotation through public fetch", async () => {
		const response = await SELF.fetch("https://session-broker.invalid/rotate", {
			method: "POST",
			body: JSON.stringify(rotationInput("tenant-one")),
		});

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("rejects non-GET authorize probes before any rotation", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const response = await SELF.fetch(
			"https://auth.tedix.dev/tedix/session/authorize?intent=request_1234567890abcdefghij",
			{
				headers: { "Sec-Fetch-Dest": "document" },
				method: "HEAD",
				redirect: "manual",
			},
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, POST");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("turns an unavailable single-use intent into a branded recovery page", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "x");
		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: { "Sec-Fetch-Dest": "document" },
				redirect: "manual",
			},
		);

		expect(response.status).toBe(410);
		expect(response.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Content-Security-Policy")).toContain(
			"default-src 'none'",
		);
		const body = await response.text();
		expect(body).toContain("This sign-in request is no longer active");
		expect(body).toContain("No access was granted by this request.");
		expect(body).toContain('href="https://os.tedix.dev/"');
		expect(body).toContain("tedix login");
		expect(body).not.toContain(intentId);
	});

	it("starts an outbound connection only from auth.tedix.dev and consumes its return once", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "o");
		const intent = brokerIntent(intentId, {
			operation: "outbound_connect",
			outboundAppId: "acme-api-staging-oauth",
			redirectPath: "/oauth/callback",
			tenantId: null,
		});
		await env.SESSION_INTENTS.getByName(intentId).initialize(intent);
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://api.descope.com/v1/outbound/oauth/connect",
				);
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer test-project:refresh-outbound",
				);
				expect(JSON.parse(String(init?.body))).toEqual({
					appId: "acme-api-staging-oauth",
					options: {
						redirectUrl: `https://auth.tedix.dev/tedix/session/outbound/callback?intent=${intentId}`,
					},
				});
				return Response.json({ url: "https://provider.example/authorize" });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const started = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: {
					Cookie: "DSR=refresh-outbound",
					"Sec-Fetch-Dest": "document",
				},
				redirect: "manual",
			},
		);
		expect(started.status).toBe(302);
		expect(started.headers.get("Location")).toBe(
			"https://provider.example/authorize",
		);

		const finished = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/outbound/callback?intent=${intentId}`,
			{ redirect: "manual" },
		);
		expect(finished.status).toBe(302);
		expect(finished.headers.get("Location")).toBe(
			"https://tedix.os.tedix.dev/oauth/callback",
		);
		const replay = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/outbound/callback?intent=${intentId}`,
			{ redirect: "manual" },
		);
		expect(replay.status).toBe(410);
	});

	it("rejects another central user's cookie before initiating a named account grant", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "n");
		await env.SESSION_INTENTS.getByName(intentId).initialize(
			brokerIntent(intentId, {
				operation: "outbound_connect",
				outboundAppId: "microsoft",
				tenantId: null,
				outboundUserId: "alice",
				outboundExternalIdentifier:
					"tedix_11111111-1111-4111-8111-111111111111",
				redirectPath: "/oauth/callback",
			}),
		);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: {
					Cookie: `DSR=${jwt({ sub: "bob" })}`,
					"Sec-Fetch-Dest": "document",
				},
				redirect: "manual",
			},
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("account_mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([null, "org_tedix"])(
		"forwards the persisted named selector with tenant %s",
		async (tenantId) => {
			const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "s");
			const externalIdentifier = "tedix_11111111-1111-4111-8111-111111111111";
			await env.SESSION_INTENTS.getByName(intentId).initialize(
				brokerIntent(intentId, {
					operation: "outbound_connect",
					outboundAppId: "microsoft",
					tenantId,
					outboundUserId: "alice",
					outboundExternalIdentifier: externalIdentifier,
					outboundScopes: ["Mail.Read"],
					redirectPath: "/oauth/callback",
				}),
			);
			const fetchMock = vi.fn(async () =>
				Response.json({ url: "https://provider.example/authorize" }),
			);
			vi.stubGlobal("fetch", fetchMock);
			const response = await SELF.fetch(
				`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
				{
					headers: {
						Cookie: `DSR=${jwt({ sub: "alice" })}`,
						"Sec-Fetch-Dest": "document",
					},
					redirect: "manual",
				},
			);
			expect(response.headers.get("Location")).toBe(
				"https://provider.example/authorize",
			);
			expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
				appId: "microsoft",
				...(tenantId ? { tenantId, tenantLevel: true } : {}),
				options: {
					redirectUrl: `https://auth.tedix.dev/tedix/session/outbound/callback?intent=${intentId}`,
					externalIdentifier,
					scopes: ["Mail.Read"],
				},
			});
		},
	);

	it("sends a refresh-less outbound intent to the login page without workspace preparation", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "q");
		await env.SESSION_INTENTS.getByName(intentId).initialize(
			brokerIntent(intentId, {
				operation: "outbound_connect",
				outboundAppId: "acme-api-staging-oauth",
				redirectPath: "/oauth/callback",
				tenantId: null,
			}),
		);
		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{ headers: { "Sec-Fetch-Dest": "document" }, redirect: "manual" },
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			`https://os.tedix.dev/login?intent=${intentId}&outbound=1`,
		);
	});

	it("authorizes one exact intent, writes the rotated cookie host-only, and consumes the code once", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "a");
		const intent = brokerIntent(intentId);
		const owner = env.SESSION_INTENTS.getByName(intentId);
		await expect(owner.initialize(intent)).resolves.toBe(true);
		const sessionToken = jwt({
			dct: intent.tenantId,
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-one",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => selectedSession(sessionToken, "refresh-rotated")),
		);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				// Distinct DSR per authorize test: the first-login rotation owner is
				// keyed off the presented refresh cookie, so a shared literal would
				// route unrelated tests to one owner (this suite already gives every
				// DO a unique name via sessionStub for the same reason).
				headers: { Cookie: "DSR=refresh-first", "Sec-Fetch-Dest": "document" },
				redirect: "manual",
			},
		);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location")!);
		expect(location.origin).toBe(intent.targetOrigin);
		expect(location.pathname).toBe(intent.callbackPath);
		expect(location.searchParams.get("intent")).toBe(intentId);
		const code = location.searchParams.get("code")!;
		expect(code).toHaveLength(43);
		const cookies = response.headers.getSetCookie();
		expect(cookies).toEqual(
			expect.arrayContaining([
				expect.stringContaining("TEDIX_AUTH_SESSION_ID="),
				expect.stringMatching(/^TEDIX_DSR=refresh-rotated;.*Path=\//),
				expect.stringContaining(`DS=${sessionToken}`),
			]),
		);
		const refreshCookies = cookies.filter((cookie) =>
			cookie.startsWith("DSR="),
		);
		// Three expired legacy scopes plus the live Descope-readable twin that
		// lets authenticated Descope flows (consent, step-up) hydrate.
		expect(refreshCookies).toHaveLength(4);
		expect(
			refreshCookies.filter((cookie) => cookie.includes("Max-Age=0")),
		).toHaveLength(3);
		// The twin must share Descope's exact cookie identity
		// (Domain=auth.tedix.dev, Path=/) so a flow-side rotation REPLACES it;
		// a host-only twin lingers stale and trips E064006 at
		// ThirdPartyAppFinish.
		expect(refreshCookies).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/^DSR=refresh-rotated;.*Domain=auth\.tedix\.dev.*Path=\//,
				),
			]),
		);
		const brokerRefreshCookies = cookies.filter((cookie) =>
			cookie.startsWith("TEDIX_DSR="),
		);
		expect(brokerRefreshCookies).toHaveLength(4);
		expect(
			brokerRefreshCookies.filter((cookie) => cookie.includes("Max-Age=0")),
		).toHaveLength(3);

		const input = {
			code,
			intentId,
			stateHash: intent.stateHash,
			targetOrigin: intent.targetOrigin,
			tenantId: intent.tenantId,
		};
		await expect(
			owner.exchange(input, "os", await sha256(code)),
		).resolves.toMatchObject({
			kind: "session",
			sessionJwt: sessionToken,
			subject: "user-one",
			tenantId: intent.tenantId,
		});
		await expect(
			owner.exchange(input, "os", await sha256(code)),
		).resolves.toBeNull();

		const stored = await runInDurableObject(
			owner,
			(_instance: SessionIntentOwner, state) =>
				state.storage.sql.exec("SELECT * FROM session_intent").toArray(),
		);
		expect(JSON.stringify(stored)).not.toContain(sessionToken);
		expect(JSON.stringify(stored)).not.toContain(code);
	});

	it("derives the first-login rotation owner from the refresh cookie, not a random id", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "s");
		const intent = brokerIntent(intentId);
		await env.SESSION_INTENTS.getByName(intentId).initialize(intent);
		const sessionToken = jwt({
			dct: intent.tenantId,
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-stable",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => selectedSession(sessionToken, "refresh-rotated")),
		);

		// No TEDIX_AUTH_SESSION_ID cookie: the first-login path must key the
		// rotation owner off the presented DS refresh cookie so that concurrent
		// authorize requests for one DSR converge on a single owner instead of
		// scattering to per-request random owners.
		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: { Cookie: "DSR=refresh-derive", "Sec-Fetch-Dest": "document" },
				redirect: "manual",
			},
		);

		expect(response.status).toBe(302);
		// The emitted session id is the deterministic one-way digest of the DSR,
		// not a random reference — the raw token never appears in it.
		expect(authSessionCookie(response)).toBe(await sha256("refresh-derive"));
	});

	it("coalesces concurrent first-login rotations of one DSR into a single Descope rotation", async () => {
		const sessionToken = jwt({
			dct: "org_tedix",
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-concurrent",
		});
		let releaseFetch: (() => void) | undefined;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		const fetchMock = vi.fn(async () => {
			await fetchGate;
			return selectedSession(sessionToken, "refresh-rotated");
		});
		vi.stubGlobal("fetch", fetchMock);

		const intentIds = await Promise.all(
			["y", "z"].map(async (suffix) => {
				const intentId = crypto
					.randomUUID()
					.replaceAll("-", "")
					.padEnd(43, suffix);
				await env.SESSION_INTENTS.getByName(intentId).initialize(
					brokerIntent(intentId),
				);
				return intentId;
			}),
		);

		// Two concurrent first-login authorize requests, each carrying the same DS
		// refresh cookie and NO session cookie. Before the fix each landed on a
		// distinct random rotation owner and independently presented the DSR
		// to Descope, so the family-replay guard invalidated the token family
		// (E064006). The stable derivation converges them onto one owner that
		// single-flights the rotation.
		const pending = intentIds.map((intentId) =>
			SELF.fetch(
				`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
				{
					headers: {
						Cookie: "DSR=refresh-coalesce",
						"Sec-Fetch-Dest": "document",
					},
					redirect: "manual",
				},
			),
		);

		// Hold the first rotation open. With N random owners a second, independent
		// rotation would also reach Descope; assert it never does.
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		releaseFetch?.();

		const [first, second] = await Promise.all(pending);
		expect(first.status).toBe(302);
		expect(second.status).toBe(302);
		// Exactly one DSR rotation reached Descope for both concurrent logins.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// Both requests routed to the same rotation owner (the DSR digest).
		const ownerId = await sha256("refresh-coalesce");
		expect(authSessionCookie(first)).toBe(ownerId);
		expect(authSessionCookie(second)).toBe(ownerId);
		// Both callbacks still carry a usable single-use authorization code.
		for (const response of [first, second]) {
			const location = new URL(response.headers.get("Location")!);
			expect(location.origin).toBe("https://tedix.os.tedix.dev");
			expect(location.searchParams.get("code")).toHaveLength(43);
		}
	});

	it("resumes the selected tenant without accepting tenant authority from the caller", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "r");
		const intent = brokerIntent(intentId, {
			operation: "resume_session",
			redirectPath: "/",
			tenantId: null,
		});
		const owner = env.SESSION_INTENTS.getByName(intentId);
		await owner.initialize(intent);
		const sessionToken = jwt({
			dct: "org_from_descope",
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-resumed",
		});
		const fetchMock = vi.fn(async () =>
			selectedSession(sessionToken, "refresh-resumed"),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: {
					Cookie: "DSR=refresh-resume-input",
					"Sec-Fetch-Dest": "document",
				},
				redirect: "manual",
			},
		);
		expect(response.status).toBe(302);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://auth.tedix.dev/v1/auth/refresh",
		);
		const location = new URL(response.headers.get("Location")!);
		const code = location.searchParams.get("code")!;
		await expect(
			owner.exchange(
				{
					code,
					intentId,
					stateHash: intent.stateHash,
					targetOrigin: intent.targetOrigin,
					tenantId: null,
				},
				"os",
				await sha256(code),
			),
		).resolves.toMatchObject({
			kind: "session",
			sessionJwt: sessionToken,
			tenantId: "org_from_descope",
		});
	});

	it("grants a tenantless project session so OS can show the organization picker", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "p");
		const intent = brokerIntent(intentId, {
			operation: "resume_session",
			redirectPath: "/organizations",
			tenantId: null,
		});
		const owner = env.SESSION_INTENTS.getByName(intentId);
		await owner.initialize(intent);
		const sessionToken = jwt({
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-project-session",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => selectedSession(sessionToken, "refresh-project")),
		);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: {
					Cookie: "DSR=refresh-picker-input",
					"Sec-Fetch-Dest": "document",
				},
				redirect: "manual",
			},
		);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location")!);
		const code = location.searchParams.get("code")!;
		await expect(
			owner.exchange(
				{
					code,
					intentId,
					stateHash: intent.stateHash,
					targetOrigin: intent.targetOrigin,
					tenantId: null,
				},
				"os",
				await sha256(code),
			),
		).resolves.toMatchObject({
			kind: "session",
			sessionJwt: sessionToken,
			subject: "user-project-session",
			tenantId: null,
		});
	});

	it("revokes logout once, clears every auth cookie scope, and grants idempotent retries", async () => {
		const browserSessionId = "browser_session_1234567890";
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		for (const suffix of ["l", "m"] as const) {
			const intentId = crypto
				.randomUUID()
				.replaceAll("-", "")
				.padEnd(43, suffix);
			const intent = brokerIntent(intentId, {
				operation: "logout",
				redirectPath: "/signed-out",
				tenantId: null,
			});
			const owner = env.SESSION_INTENTS.getByName(intentId);
			await owner.initialize(intent);
			const response = await SELF.fetch(
				`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
				{
					headers: {
						Cookie: `DSR=logout-refresh; TEDIX_AUTH_SESSION_ID=${browserSessionId}`,
						"Sec-Fetch-Dest": "document",
					},
					redirect: "manual",
				},
			);
			expect(response.status).toBe(302);
			const cookies = response.headers.getSetCookie();
			expect(
				cookies.filter((cookie) => cookie.startsWith("DSR=")),
			).toHaveLength(3);
			expect(
				cookies.some(
					(cookie) =>
						cookie.startsWith("TEDIX_AUTH_SESSION_ID=") &&
						cookie.includes("Max-Age=0"),
				),
			).toBe(true);
			const location = new URL(response.headers.get("Location")!);
			const code = location.searchParams.get("code")!;
			await expect(
				owner.exchange(
					{
						code,
						intentId,
						stateHash: intent.stateHash,
						targetOrigin: intent.targetOrigin,
						tenantId: null,
					},
					"os",
					await sha256(code),
				),
			).resolves.toEqual({ kind: "logout" });
		}
		const noCookieIntentId = crypto
			.randomUUID()
			.replaceAll("-", "")
			.padEnd(43, "n");
		const noCookieIntent = brokerIntent(noCookieIntentId, {
			operation: "logout",
			redirectPath: "/signed-out",
			tenantId: null,
		});
		await env.SESSION_INTENTS.getByName(noCookieIntentId).initialize(
			noCookieIntent,
		);
		const noCookieResponse = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${noCookieIntentId}`,
			{
				headers: { "Sec-Fetch-Dest": "document" },
				redirect: "manual",
			},
		);
		expect(noCookieResponse.status).toBe(302);
		expect(
			new URL(noCookieResponse.headers.get("Location")!).searchParams.has(
				"code",
			),
		).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends one refresh recovery to central login, expires ambiguous cookies, and then fails closed", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "b");
		const intent = brokerIntent(intentId);
		await env.SESSION_INTENTS.getByName(intentId).initialize(intent);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: {
					Cookie: "DSR=host; DSR=parent",
					"Sec-Fetch-Dest": "document",
				},
				redirect: "manual",
			},
		);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("Location")!);
		expect(location.toString()).toBe(
			`https://os.tedix.dev/login?intent=${intentId}`,
		);
		const cookies = response.headers.getSetCookie();
		expect(cookies.filter((cookie) => cookie.startsWith("DSR="))).toHaveLength(
			3,
		);
		expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);

		const repeated = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: { "Sec-Fetch-Dest": "document" },
				redirect: "manual",
			},
		);
		const repeatedLocation = new URL(repeated.headers.get("Location")!);
		expect(repeatedLocation.origin).toBe(intent.targetOrigin);
		expect(repeatedLocation.searchParams.get("error")).toBe("reauth_required");
	});

	it("uses the broker-owned refresh cookie when Descope DSR scopes are ambiguous", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "q");
		const intent = brokerIntent(intentId);
		await env.SESSION_INTENTS.getByName(intentId).initialize(intent);
		const sessionToken = jwt({
			dct: intent.tenantId,
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-canonical-refresh",
		});
		const fetchMock = vi.fn(async () =>
			selectedSession(sessionToken, "refresh-canonical-next"),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: {
					Cookie:
						"TEDIX_DSR=refresh-canonical; DSR=refresh-host; DSR=refresh-domain",
					"Sec-Fetch-Dest": "document",
				},
				redirect: "manual",
			},
		);

		expect(response.status).toBe(302);
		expect(cookieHeader(fetchMock.mock.calls[0] ?? [])).toBe(
			"DSR=refresh-canonical",
		);
		expect(
			response.headers
				.getSetCookie()
				.some((cookie) =>
					cookie.startsWith("TEDIX_DSR=refresh-canonical-next"),
				),
		).toBe(true);
	});

	it("adopts a consent-advanced successor over the stale broker cookie", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "s");
		const intent = brokerIntent(intentId);
		await env.SESSION_INTENTS.getByName(intentId).initialize(intent);
		const now = Math.floor(Date.now() / 1000);
		// The broker's own TEDIX_DSR twin was consumed by the inbound-app
		// consent flow's refresh; Descope set the newer successor under DSR.
		const staleBroker = jwt({ iat: now - 600, sub: "user-advance" });
		const consentSuccessor = jwt({ iat: now - 30, sub: "user-advance" });
		const sessionToken = jwt({
			dct: intent.tenantId,
			exp: now + 300,
			sub: "user-advance",
		});
		const fetchMock = vi.fn(async () =>
			selectedSession(sessionToken, "refresh-advanced-next"),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: {
					Cookie: `TEDIX_DSR=${staleBroker}; DSR=${consentSuccessor}`,
					"Sec-Fetch-Dest": "document",
				},
				redirect: "manual",
			},
		);

		expect(response.status).toBe(302);
		expect(
			new URL(response.headers.get("Location")!).searchParams.get("error"),
		).toBeNull();
		// The newest same-subject issuance is presented — never the stale value
		// whose replay would trip Descope reuse detection.
		expect(cookieHeader(fetchMock.mock.calls[0] ?? [])).toBe(
			`DSR=${consentSuccessor}`,
		);
	});

	it("adopts the newest same-subject DSR after a fresh authenticated handoff", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "r");
		const intent = brokerIntent(intentId);
		await env.SESSION_INTENTS.getByName(intentId).initialize(intent);
		const now = Math.floor(Date.now() / 1000);
		const sessionToken = jwt({
			dct: intent.tenantId,
			exp: now + 300,
			iat: now,
			sub: "user-fresh-handoff",
		});
		const oldRefresh = jwt({
			exp: now + 2_400,
			iat: now - 10,
			sub: "user-fresh-handoff",
		});
		const currentRefresh = jwt({
			exp: now + 2_400,
			iat: now,
			sub: "user-fresh-handoff",
		});
		const selectedToken = jwt({
			dct: intent.tenantId,
			exp: now + 300,
			sub: "user-fresh-handoff",
		});
		const fetchMock = vi.fn(async () =>
			selectedSession(selectedToken, "refresh-adopted-next"),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				body: new URLSearchParams({ session_token: sessionToken }),
				headers: {
					Cookie: `DSR=${oldRefresh}; DSR=${currentRefresh}; DS=session-old; DS=session-current; TEDIX_AUTH_SESSION_ID=browser_session_old_123; TEDIX_AUTH_SESSION_ID=browser_session_other_456`,
					Origin: "https://os.tedix.dev",
					"Sec-Fetch-Dest": "document",
				},
				method: "POST",
				redirect: "manual",
			},
		);

		expect(response.status).toBe(302);
		expect(cookieHeader(fetchMock.mock.calls[0] ?? [])).toBe(
			`DSR=${currentRefresh}`,
		);
	});

	it("keeps a missing-refresh intent pending for one central human login", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "h");
		const intent = brokerIntent(intentId);
		const owner = env.SESSION_INTENTS.getByName(intentId);
		await owner.initialize(intent);

		const response = await SELF.fetch(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${intentId}`,
			{
				headers: { "Sec-Fetch-Dest": "document" },
				redirect: "manual",
			},
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			`https://os.tedix.dev/login?intent=${intentId}`,
		);
		expect(await owner.readPending()).toMatchObject({ intentId });
	});

	it("physically clears an unexchanged session grant when its alarm fires", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "c");
		const intent = brokerIntent(intentId);
		const owner = env.SESSION_INTENTS.getByName(intentId);
		await owner.initialize(intent);
		const sessionToken = jwt({
			dct: intent.tenantId,
			exp: Math.floor(Date.now() / 1000) + 300,
			sub: "user-alarm",
		});
		await owner.storeSessionGrant({
			codeExpiresAt: Math.floor(Date.now() / 1000) + 30,
			codeHash: `sha256-${"d".repeat(43)}`,
			sessionExpiresAt: Math.floor(Date.now() / 1000) + 300,
			sessionJwt: sessionToken,
			subject: "user-alarm",
			tenantId: intent.tenantId!,
		});

		await runInDurableObject(owner, async (instance: SessionIntentOwner) => {
			await instance.alarm();
		});
		const stored = await runInDurableObject(
			owner,
			(_instance: SessionIntentOwner, state) =>
				state.storage.sql.exec("SELECT * FROM session_intent").toArray(),
		);
		expect(JSON.stringify(stored)).not.toContain(sessionToken);
		expect(JSON.stringify(stored)).toContain('"status":"failed"');
	});

	it("physically clears an unexchanged logout grant when its alarm fires", async () => {
		const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "o");
		const intent = brokerIntent(intentId, {
			operation: "logout",
			tenantId: null,
		});
		const owner = env.SESSION_INTENTS.getByName(intentId);
		await owner.initialize(intent);
		await owner.storeLogoutGrant({
			codeExpiresAt: Math.floor(Date.now() / 1000) + 30,
			codeHash: `sha256-${"e".repeat(43)}`,
		});

		await runInDurableObject(owner, async (instance: SessionIntentOwner) => {
			await instance.alarm();
		});
		const stored = await runInDurableObject(
			owner,
			(_instance: SessionIntentOwner, state) =>
				state.storage.sql.exec("SELECT * FROM session_intent").toArray(),
		);
		expect(JSON.stringify(stored)).not.toContain(`sha256-${"e".repeat(43)}`);
		expect(JSON.stringify(stored)).toContain('"status":"failed"');
	});
});

describe("explicit persisted session grant fields", () => {
	for (const missingField of ["grant_kind", "granted_tenant_id"] as const) {
		it(`rejects missing ${missingField} without consuming the grant`, async () => {
			const intentId = crypto.randomUUID().replaceAll("-", "").padEnd(43, "g");
			const intent = brokerIntent(intentId);
			const owner = env.SESSION_INTENTS.getByName(intentId);
			await owner.initialize(intent);
			const now = Math.floor(Date.now() / 1000);
			const code = "g".repeat(43);
			const codeHash = await sha256(code);
			expect(
				await owner.storeSessionGrant({
					codeHash,
					codeExpiresAt: now + 30,
					sessionExpiresAt: now + 300,
					sessionJwt: "synthetic-session",
					subject: "user-one",
					tenantId: intent.tenantId,
				}),
			).toBe(true);
			await runInDurableObject(
				owner,
				(_instance: SessionIntentOwner, state) => {
					state.storage.sql.exec(
						missingField === "grant_kind"
							? "UPDATE session_intent SET grant_kind = NULL"
							: "UPDATE session_intent SET granted_tenant_id = NULL",
					);
				},
			);
			await expect(
				owner.exchange(
					{
						code,
						intentId,
						stateHash: intent.stateHash,
						targetOrigin: intent.targetOrigin,
						tenantId: intent.tenantId,
					},
					"os",
					codeHash,
				),
			).resolves.toBeNull();
			const status = await runInDurableObject(
				owner,
				(_instance: SessionIntentOwner, state) =>
					state.storage.sql
						.exec<{ status: string }>("SELECT status FROM session_intent")
						.one().status,
			);
			expect(status).toBe("granted");
		});
	}
});
