import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import { PersonalAgentSessionFailure } from "@tedix/auth/personal-agent-session";
import { verifySignedOutPersonalAgentSession } from "./personal-agent-session";

const mocks = vi.hoisted(() => ({
	app: vi.fn(),
	organization: vi.fn(),
	verify: vi.fn(),
	rate: vi.fn(),
	session: vi.fn(),
}));
vi.mock("@tedix/auth/personal-agent-session", async (original) => ({
	...(await original<typeof import("@tedix/auth/personal-agent-session")>()),
	createPersonalAgentSessionVerifier: () => mocks.verify,
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppByIdForOrganization: mocks.app,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.organization,
	isOrganizationOffboarding: (metadata: Record<string, unknown>) =>
		Boolean(metadata.retiredAt),
}));
vi.mock("@tedix/db/queries/personal-agent-sessions", () => ({
	consumePersonalAgentClientRate: mocks.rate,
	continuePersonalAgentSession: mocks.session,
}));

const db = {} as DbClient;
const input = {
	organizationId: "org-example",
	appId: "app-example",
	url: "https://mcp.example/mcp",
	method: "GET" as const,
	sessionToken: "fictional-session-token",
	version: "1.0",
};
const config = {
	domain: "company.example",
	mcpUrl: input.url,
	description: "Public tools",
	allowedClientIds: ["https://agent.example/agent.json"],
	requestsPerMinute: 17,
};
const organization = () => ({
	features: { os: true },
	metadata: { personalAgentProtocol: config },
});
const session = {
	clientId: config.allowedClientIds[0],
	sessionId: "sid-example",
	userId: "user-example",
	version: "1.0",
};

describe("signed-out protocol resource boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.app.mockResolvedValue({
			visibility: "public",
			metadata: { mcpConfig: { authMode: "public" } },
		});
		mocks.organization.mockResolvedValue(organization());
		mocks.verify.mockResolvedValue(session);
		mocks.rate.mockResolvedValue(true);
		mocks.session.mockResolvedValue("accepted");
	});
	it("binds the app to the organization and the Session to its protocol audience", async () => {
		expect(await verifySignedOutPersonalAgentSession(db, input)).toEqual({
			status: "accepted",
		});
		expect(mocks.app).toHaveBeenCalledWith(
			db,
			input.appId,
			input.organizationId,
		);
		const verification = mocks.verify.mock.calls[0]![0];
		expect(verification.audience).toBe("https://company.example");
		expect(verification.policy.allowedClientIds).toEqual(
			config.allowedClientIds,
		);
		expect(verification.request.headers.get("Poppy-Session")).toBe(
			input.sessionToken,
		);
		expect(mocks.rate).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				organizationId: input.organizationId,
				clientId: session.clientId,
				limit: 17,
			}),
		);
		expect(mocks.session).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				organizationId: input.organizationId,
				...session,
			}),
		);
	});
	it("does not create a signed-out route on an authenticated or foreign app", async () => {
		for (const app of [
			undefined,
			{ visibility: "disabled" },
			{ metadata: { mcpConfig: { authMode: "authenticated" } } },
		]) {
			mocks.app.mockResolvedValue(app);
			expect(await verifySignedOutPersonalAgentSession(db, input)).toEqual({
				status: "not_configured",
			});
		}
		expect(mocks.verify).not.toHaveBeenCalled();
		expect(mocks.session).not.toHaveBeenCalled();
	});
	it("does not apply one organization's identity to unrelated URLs or a lookalike path", async () => {
		for (const url of [
			"https://foreign.example/mcp",
			"https://mcp.example/mcp-lookalike",
			"https://mcp.example/other",
		]) {
			expect(
				await verifySignedOutPersonalAgentSession(db, { ...input, url }),
			).toEqual({ status: "not_configured" });
		}
		expect(mocks.verify).not.toHaveBeenCalled();
	});
	it("does not trust Session identity for retired or unprovisioned organizations", async () => {
		for (const value of [
			undefined,
			{ ...organization(), features: { os: false } },
			{
				...organization(),
				metadata: { ...organization().metadata, retiredAt: "2026-01-01" },
			},
		]) {
			mocks.organization.mockResolvedValue(value);
			expect(await verifySignedOutPersonalAgentSession(db, input)).toEqual({
				status: "not_configured",
			});
		}
		expect(mocks.verify).not.toHaveBeenCalled();
	});
	it.each(["invalid_session", "version_unsupported"] as const)(
		"rejects %s before any Session lookup or mutation",
		async (code) => {
			mocks.verify.mockRejectedValue(new PersonalAgentSessionFailure(code));
			expect(await verifySignedOutPersonalAgentSession(db, input)).toEqual({
				status: code,
			});
			expect(mocks.rate).not.toHaveBeenCalled();
			expect(mocks.session).not.toHaveBeenCalled();
		},
	);
	it("applies the per-client limit before persisting another Session", async () => {
		mocks.rate.mockResolvedValue(false);
		expect(await verifySignedOutPersonalAgentSession(db, input)).toEqual({
			status: "rate_limited",
		});
		expect(mocks.session).not.toHaveBeenCalled();
	});
	it("returns ended state and propagates storage failure without relabeling it", async () => {
		mocks.session.mockResolvedValue("session_ended");
		expect(await verifySignedOutPersonalAgentSession(db, input)).toEqual({
			status: "session_ended",
		});
		mocks.session.mockRejectedValue(new Error("D1 unavailable"));
		await expect(
			verifySignedOutPersonalAgentSession(db, input),
		).rejects.toThrow("D1 unavailable");
	});
});
