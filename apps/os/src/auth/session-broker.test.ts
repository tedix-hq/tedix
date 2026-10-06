// @vitest-environment node
import { validateToken } from "@tedix/auth/jwt";
import { resolveOsTenant } from "@/shared/os-tenant";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	CLI_BROKER_CORRELATION_COOKIE,
	CLI_BROKER_SESSION_COOKIE,
	handleOsSessionBroker,
	OS_BROKER_SESSION_COOKIE,
} from "./session-broker";

vi.mock("@tedix/auth/jwt", () => ({ validateToken: vi.fn() }));

const validate = vi.mocked(validateToken);
const host = resolveOsTenant("acme.os.tedix.dev");
const env = {
	DESCOPE_PROJECT_ID: "project",
};

describe("OS broker status", () => {
	beforeEach(() => {
		validate.mockReset();
	});

	it("requires broker renewal during the final 60 seconds", async () => {
		validate.mockResolvedValue({
			aud: ["project"],
			exp: Math.floor(Date.now() / 1000) + 59,
			iat: Math.floor(Date.now() / 1000) - 1,
			iss: "project",
			sub: "user-1",
		});
		const response = await handleOsSessionBroker(
			new Request("https://acme.os.tedix.dev/auth/session-broker/status", {
				headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=session-jwt` },
			}),
			env,
			host,
			"T-acme",
		);

		expect(response?.status).toBe(401);
		expect(await response?.json()).toEqual({
			authenticated: false,
			renewalRequired: true,
		});
	});

	it("returns only identity metadata and expiry for a fresh session", async () => {
		const expiresAt = Math.floor(Date.now() / 1000) + 120;
		validate.mockResolvedValue({
			aud: ["project"],
			dct: "T-acme",
			email: "member@example.com",
			exp: expiresAt,
			iat: Math.floor(Date.now() / 1000) - 1,
			iss: "project",
			name: "Member",
			sub: "user-1",
		});
		const response = await handleOsSessionBroker(
			new Request("https://acme.os.tedix.dev/auth/session-broker/status", {
				headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=session-jwt` },
			}),
			env,
			host,
			"T-acme",
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			authenticated: true,
			expiresAt,
			tenantId: "T-acme",
			user: { email: "member@example.com", name: "Member" },
		});
	});

	it.each([
		["a tenantless session", undefined],
		["a session selected for another tenant", "T-other"],
	])("reissues %s before mounting a tenant OS", async (_label, dct) => {
		validate.mockResolvedValue({
			aud: ["project"],
			dct,
			exp: Math.floor(Date.now() / 1000) + 120,
			iat: Math.floor(Date.now() / 1000) - 1,
			iss: "project",
			sub: "user-1",
		});
		const response = await handleOsSessionBroker(
			new Request("https://acme.os.tedix.dev/auth/session-broker/status", {
				headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=session-jwt` },
			}),
			env,
			host,
			"T-acme",
		);

		expect(response?.status).toBe(401);
		expect(await response?.json()).toEqual({
			authenticated: false,
			renewalRequired: true,
		});
	});

	it("refuses state-changing status requests before token validation", async () => {
		const response = await handleOsSessionBroker(
			new Request("https://acme.os.tedix.dev/auth/session-broker/status", {
				method: "POST",
			}),
			env,
			host,
			"T-acme",
		);

		expect(response?.status).toBe(405);
		expect(response?.headers.get("allow")).toBe("GET, HEAD");
		expect(validate).not.toHaveBeenCalled();
	});

	it("does not mount the login bounce on the CLI prefix", async () => {
		const response = await handleOsSessionBroker(
			new Request(
				"https://os.tedix.dev/cli/session-broker/continue?redirect_to=%2Fcli%2Flogin",
			),
			{
				...env,
				CLI_SESSION_BROKER: { createIntent: vi.fn(), exchangeCode: vi.fn() },
			},
			resolveOsTenant("os.tedix.dev"),
			null,
		);
		expect(response).toBeNull();
	});

	it("normalises the bounce redirect before it reaches start", async () => {
		const response = await handleOsSessionBroker(
			new Request(
				"https://acme.os.tedix.dev/auth/session-broker/continue?redirect_to=https%3A%2F%2Fattacker.example%2F",
				{ headers: { "Sec-Fetch-Site": "cross-site" } },
			),
			{
				...env,
				OS_SESSION_BROKER: { createIntent: vi.fn(), exchangeCode: vi.fn() },
			},
			host,
			"T-acme",
		);
		expect(response?.status).toBe(200);
		expect(await response?.text()).toContain(
			'url=/auth/session-broker/start?redirect_to=%2F"',
		);
	});

	it("returns CLI logout to the pending authorization request", async () => {
		const createIntent = vi.fn().mockResolvedValue({
			authorizeUrl: "https://auth.tedix.dev/login",
			expiresAt: Math.floor(Date.now() / 1000) + 600,
			intentId: "intent-1",
		});
		const response = await handleOsSessionBroker(
			new Request(
				"https://os.tedix.dev/cli/session-broker/start?operation=logout&redirect_to=%2Fcli%2Flogin%3Fport%3D49921%26state%3Dstate-1",
				{ headers: { "Sec-Fetch-Site": "same-origin" } },
			),
			{ ...env, CLI_SESSION_BROKER: { createIntent, exchangeCode: vi.fn() } },
			resolveOsTenant("os.tedix.dev"),
			null,
		);

		expect(response?.status).toBe(302);
		expect(createIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: "logout",
				redirectPath: "/cli/login?port=49921&state=state-1",
			}),
		);
	});

	it("selects the membership-validated CLI tenant through the central broker", async () => {
		const createIntent = vi.fn().mockResolvedValue({
			authorizeUrl: "https://auth.tedix.dev/login",
			expiresAt: Math.floor(Date.now() / 1000) + 600,
			intentId: "intent-1",
		});
		const response = await handleOsSessionBroker(
			new Request(
				"https://os.tedix.dev/cli/session-broker/start?tenant_id=org_globex&redirect_to=%2Fcli%2Flogin%3Fport%3D49921%26state%3Dstate-1%26selected_organization%3Dglobex%26selected_tenant%3Dorg_globex",
				{ headers: { "Sec-Fetch-Site": "same-origin" } },
			),
			{ ...env, CLI_SESSION_BROKER: { createIntent, exchangeCode: vi.fn() } },
			resolveOsTenant("os.tedix.dev"),
			null,
		);

		expect(response?.status).toBe(302);
		expect(createIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: "issue_session",
				tenantId: "org_globex",
				redirectPath:
					"/cli/login?port=49921&state=state-1&selected_organization=globex&selected_tenant=org_globex",
			}),
		);
	});

	it("rejects a malformed CLI-selected tenant before creating an intent", async () => {
		const createIntent = vi.fn();
		const response = await handleOsSessionBroker(
			new Request(
				"https://os.tedix.dev/cli/session-broker/start?tenant_id=https%3A%2F%2Fevil.example&redirect_to=%2Fcli%2Flogin",
				{ headers: { "Sec-Fetch-Site": "same-origin" } },
			),
			{ ...env, CLI_SESSION_BROKER: { createIntent, exchangeCode: vi.fn() } },
			resolveOsTenant("os.tedix.dev"),
			null,
		);

		expect(response?.status).toBe(400);
		expect(createIntent).not.toHaveBeenCalled();
	});

	it("clears the CLI session when OS logout begins", async () => {
		const response = await handleOsSessionBroker(
			new Request(
				"https://os.tedix.dev/auth/session-broker/start?operation=logout",
				{
					headers: { "Sec-Fetch-Site": "same-origin" },
				},
			),
			{
				...env,
				OS_SESSION_BROKER: {
					createIntent: vi.fn().mockResolvedValue({
						authorizeUrl: "https://auth.tedix.dev/login",
						expiresAt: Math.floor(Date.now() / 1000) + 600,
						intentId: "intent-1",
					}),
					exchangeCode: vi.fn(),
				},
			},
			resolveOsTenant("os.tedix.dev"),
			null,
		);

		const cookies = response?.headers.getSetCookie().join("\n") ?? "";
		expect(cookies).toContain(`${CLI_BROKER_SESSION_COOKIE}=;`);
		expect(cookies).toContain(`${CLI_BROKER_CORRELATION_COOKIE}=;`);
	});
});
