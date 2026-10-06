import { describe, expect, it } from "vite-plus/test";
import type {
	CreateSessionBrokerIntentInput,
	ExchangeSessionBrokerCodeInput,
	SessionBrokerRpc,
} from "./session-broker";
import {
	canonicalizeProductSessionCookieHeader,
	continueProductSessionBroker,
	finishProductSessionBroker,
	resolveProductSession,
	startProductSessionBroker,
} from "./product-session-broker";

const PRODUCT_COOKIE = "__Host-tedix-os-session" as const;
const CORRELATION_COOKIE = "__Host-tedix-os-broker" as const;
const INTENT = "intent_123456789012345678901234";
const CODE = "code_12345678901234567890123456";

function broker(overrides: Partial<SessionBrokerRpc> = {}): SessionBrokerRpc {
	return {
		async createIntent(_input: CreateSessionBrokerIntentInput) {
			return {
				authorizeUrl: `https://auth.tedix.dev/tedix/session/authorize?intent=${INTENT}`,
				expiresAt: Math.floor(Date.now() / 1000) + 60,
				intentId: INTENT,
			};
		},
		async exchangeCode(_input: ExchangeSessionBrokerCodeInput) {
			return {
				expiresAt: Math.floor(Date.now() / 1000) + 600,
				kind: "session" as const,
				sessionJwt: "broker-session-jwt",
				subject: "user-1",
				tenantId: "tenant-1",
			};
		},
		...overrides,
	};
}

async function start(operation: "issue_session" | "resume_session" | "logout") {
	return startProductSessionBroker({
		broker: broker(),
		correlationCookie: CORRELATION_COOKIE,
		operation,
		productCookie: PRODUCT_COOKIE,
		requireSameOriginStart: true,
		redirectPath: "/organizations",
		request: new Request(
			"https://tedix.os.tedix.dev/auth/session-broker/start",
			{
				headers: { "Sec-Fetch-Site": "same-origin" },
			},
		),
		surface: "os",
		tenantId: operation === "issue_session" ? "tenant-1" : null,
	});
}

describe("product session broker handoff", () => {
	it("accepts exactly one product session and ignores generic Descope cookies", () => {
		expect(resolveProductSession("DS=legacy", PRODUCT_COOKIE)).toBeNull();
		expect(
			resolveProductSession(
				`DS=legacy; ${PRODUCT_COOKIE}=broker`,
				PRODUCT_COOKIE,
			),
		).toBe("broker");
		expect(
			resolveProductSession(
				`${PRODUCT_COOKIE}=one; ${PRODUCT_COOKIE}=two; DS=legacy`,
				PRODUCT_COOKIE,
			),
		).toBeNull();
	});

	it("rejects repeated copies of the same product cookie", () => {
		expect(
			resolveProductSession(
				`${PRODUCT_COOKIE}=same; ${PRODUCT_COOKIE}=same`,
				PRODUCT_COOKIE,
			),
		).toBeNull();
	});

	it("does not fall back to legacy DS when an empty product cookie is present", () => {
		expect(
			resolveProductSession(`${PRODUCT_COOKIE}=; DS=legacy`, PRODUCT_COOKIE),
		).toBeNull();
	});

	it("canonicalizes the chosen session only inside a forwarded request", () => {
		expect(
			canonicalizeProductSessionCookieHeader(
				`keep=value; DS=legacy; ${PRODUCT_COOKIE}=broker`,
				PRODUCT_COOKIE,
			),
		).toBe("keep=value; DS=broker");
		expect(
			canonicalizeProductSessionCookieHeader(
				`${PRODUCT_COOKIE}=one; ${PRODUCT_COOKIE}=two`,
				PRODUCT_COOKIE,
			),
		).toBeNull();
	});

	it("creates a server-only correlation and redirects with only the intent", async () => {
		const response = await start("issue_session");
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${INTENT}`,
		);
		const cookie = response.headers.getSetCookie()[0]!;
		expect(cookie).toContain(`${CORRELATION_COOKIE}=`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).not.toContain("tenant-1");
	});

	it("rejects a cross-site start before creating an intent", async () => {
		let created = false;
		const response = await startProductSessionBroker({
			broker: broker({
				async createIntent() {
					created = true;
					throw new Error("must not run");
				},
			}),
			correlationCookie: CORRELATION_COOKIE,
			operation: "resume_session",
			productCookie: PRODUCT_COOKIE,
			requireSameOriginStart: true,
			redirectPath: "/organizations",
			request: new Request(
				"https://tedix.os.tedix.dev/auth/session-broker/start",
				{
					headers: { "Sec-Fetch-Site": "cross-site" },
				},
			),
			surface: "os",
			tenantId: null,
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(created).toBe(false);
	});

	it("bounces a cross-site document navigation into a same-origin start", () => {
		const response = continueProductSessionBroker({
			redirectPath: "/work?tab=mine",
			request: new Request(
				"https://tedix.os.tedix.dev/auth/session-broker/continue?redirect_to=%2Fwork%3Ftab%3Dmine",
				{
					headers: {
						Referer: "https://app.slack.com/",
						"Sec-Fetch-Dest": "document",
						"Sec-Fetch-Mode": "navigate",
						"Sec-Fetch-Site": "cross-site",
					},
				},
			),
			startPath: "/auth/session-broker/start",
			surface: "os",
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("same-origin");
	});

	it("bounce relays only a validated relative redirect, never an operation", async () => {
		const body = await continueProductSessionBroker({
			redirectPath: "/work?tab=mine",
			request: new Request(
				"https://tedix.os.tedix.dev/auth/session-broker/continue?operation=logout&redirect_to=%2Fwork%3Ftab%3Dmine",
				{ headers: { "Sec-Fetch-Site": "cross-site" } },
			),
			startPath: "/auth/session-broker/start",
			surface: "os",
		}).text();
		const href = "/auth/session-broker/start?redirect_to=%2Fwork%3Ftab%3Dmine";
		expect(body).toContain(`content="0; url=${href}"`);
		expect(body).toContain(`href="${href}"`);
		expect(body).not.toContain("operation");
		expect(body).not.toContain("<script");
		expect(() =>
			continueProductSessionBroker({
				redirectPath: "https://attacker.example/",
				request: new Request(
					"https://tedix.os.tedix.dev/auth/session-broker/continue",
				),
				startPath: "/auth/session-broker/start",
				surface: "os",
			}),
		).toThrow();
	});

	it("bounce refuses state-changing methods", () => {
		const response = continueProductSessionBroker({
			redirectPath: "/",
			request: new Request(
				"https://tedix.os.tedix.dev/auth/session-broker/continue",
				{ method: "POST" },
			),
			startPath: "/auth/session-broker/start",
			surface: "os",
		});
		expect(response.status).toBe(405);
	});

	it("allows an explicit user navigation to start the broker", async () => {
		const response = await startProductSessionBroker({
			broker: broker(),
			correlationCookie: CORRELATION_COOKIE,
			operation: "resume_session",
			productCookie: PRODUCT_COOKIE,
			requireSameOriginStart: true,
			redirectPath: "/organizations",
			request: new Request(
				"https://tedix.os.tedix.dev/auth/session-broker/start",
				{
					headers: { "Sec-Fetch-Site": "none" },
				},
			),
			surface: "os",
			tenantId: null,
		});
		expect(response.status).toBe(302);
	});

	it("preserves an authenticated same-origin POST only into the broker", async () => {
		const response = await startProductSessionBroker({
			broker: broker(),
			correlationCookie: CORRELATION_COOKIE,
			operation: "resume_session",
			productCookie: PRODUCT_COOKIE,
			requireSameOriginStart: true,
			redirectPath: "/organizations",
			request: new Request(
				"https://tedix.os.tedix.dev/auth/session-broker/start",
				{
					body: new URLSearchParams({
						refresh_token: "fresh-refresh",
						session_token: "fresh-session",
					}),
					headers: { Origin: "https://tedix.os.tedix.dev" },
					method: "POST",
				},
			),
			surface: "os",
			tenantId: null,
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			`https://auth.tedix.dev/tedix/session/authorize?intent=${INTENT}`,
		);
	});

	it("exchanges the callback over RPC and writes only a host-only HttpOnly product cookie", async () => {
		const started = await start("issue_session");
		const correlation = started.headers.getSetCookie()[0]!.split(";")[0]!;
		let exchange: ExchangeSessionBrokerCodeInput | null = null;
		const response = await finishProductSessionBroker({
			broker: broker({
				async exchangeCode(input) {
					exchange = input;
					return {
						expiresAt: Math.floor(Date.now() / 1000) + 600,
						kind: "session",
						sessionJwt: "broker-session-jwt",
						subject: "user-1",
						tenantId: "tenant-1",
					};
				},
			}),
			correlationCookie: CORRELATION_COOKIE,
			productCookie: PRODUCT_COOKIE,
			request: new Request(
				`https://tedix.os.tedix.dev/auth/session-broker/callback?intent=${INTENT}&code=${CODE}`,
				{ headers: { Cookie: correlation } },
			),
			surface: "os",
		});
		expect(exchange).toMatchObject({
			code: CODE,
			intentId: INTENT,
			targetOrigin: "https://tedix.os.tedix.dev",
			tenantId: "tenant-1",
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/organizations");
		const cookies = response.headers.getSetCookie().join("\n");
		expect(cookies).toContain(`${PRODUCT_COOKIE}=broker-session-jwt`);
		expect(cookies).toContain("HttpOnly");
		const productCookie = response.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith(`${PRODUCT_COOKIE}=`));
		expect(productCookie).not.toContain("Domain=");
		expect(cookies).not.toContain("DS=");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("accepts a tenantless resumed session before organization selection", async () => {
		const started = await start("resume_session");
		const correlation = started.headers.getSetCookie()[0]!.split(";")[0]!;
		const response = await finishProductSessionBroker({
			broker: broker({
				async exchangeCode() {
					return {
						expiresAt: Math.floor(Date.now() / 1000) + 600,
						kind: "session",
						sessionJwt: "project-session-jwt",
						subject: "user-1",
						tenantId: null,
					};
				},
			}),
			correlationCookie: CORRELATION_COOKIE,
			productCookie: PRODUCT_COOKIE,
			request: new Request(
				`https://tedix.os.tedix.dev/auth/session-broker/callback?intent=${INTENT}&code=${CODE}`,
				{ headers: { Cookie: correlation } },
			),
			surface: "os",
		});

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/organizations");
		expect(response.headers.getSetCookie().join("\n")).toContain(
			`${PRODUCT_COOKIE}=project-session-jwt`,
		);
	});

	it("rejects a callback without the matching correlation before RPC", async () => {
		let exchanged = false;
		const response = await finishProductSessionBroker({
			broker: broker({
				async exchangeCode() {
					exchanged = true;
					return { kind: "logout" };
				},
			}),
			correlationCookie: CORRELATION_COOKIE,
			productCookie: PRODUCT_COOKIE,
			request: new Request(
				`https://tedix.os.tedix.dev/auth/session-broker/callback?intent=${INTENT}&code=${CODE}`,
			),
			surface: "os",
		});
		expect(exchanged).toBe(false);
		expect(response.headers.get("location")).toBe(
			"/login?error=invalid_request",
		);
		expect(
			response.headers
				.getSetCookie()
				.some((cookie) => cookie.startsWith(`${PRODUCT_COOKIE}=;`)),
		).toBe(true);
	});

	it("clears a stale product session when exchange fails", async () => {
		const started = await start("issue_session");
		const correlation = started.headers.getSetCookie()[0]!.split(";")[0]!;
		const response = await finishProductSessionBroker({
			broker: broker({
				async exchangeCode() {
					throw new Error("broker unavailable");
				},
			}),
			correlationCookie: CORRELATION_COOKIE,
			productCookie: PRODUCT_COOKIE,
			request: new Request(
				`https://tedix.os.tedix.dev/auth/session-broker/callback?intent=${INTENT}&code=${CODE}`,
				{ headers: { Cookie: correlation } },
			),
			surface: "os",
		});
		expect(response.headers.get("location")).toBe(
			"/login?error=session_unavailable",
		);
		expect(
			response.headers
				.getSetCookie()
				.some((cookie) => cookie.startsWith(`${PRODUCT_COOKIE}=;`)),
		).toBe(true);
	});

	it("returns broker failures to login and clears only product state", async () => {
		const started = await start("resume_session");
		const correlation = started.headers.getSetCookie()[0]!.split(";")[0]!;
		const response = await finishProductSessionBroker({
			broker: broker(),
			correlationCookie: CORRELATION_COOKIE,
			failureRedirectPath: "/login",
			productCookie: PRODUCT_COOKIE,
			request: new Request(
				`https://tedix.os.tedix.dev/auth/session-broker/callback?intent=${INTENT}&error=reauth_required`,
				{ headers: { Cookie: correlation } },
			),
			surface: "os",
		});

		expect(response.headers.get("location")).toBe(
			"/login?error=reauth_required",
		);
		const cookies = response.headers.getSetCookie().join("\n");
		expect(cookies).toContain(`${PRODUCT_COOKIE}=;`);
		expect(cookies).not.toContain("DS=");
		expect(cookies).not.toContain("DS_AUTH=");
	});

	it("clears the product cookie before navigating to logout", async () => {
		const response = await start("logout");
		expect(
			response.headers
				.getSetCookie()
				.some((cookie) => cookie.startsWith(`${PRODUCT_COOKIE}=;`)),
		).toBe(true);
	});
});
