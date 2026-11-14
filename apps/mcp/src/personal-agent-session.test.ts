import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { checkSignedOutPersonalAgentSession } from "./personal-agent-session";
import { PersonalAgentSessionRequestSchema } from "@tedix/api-contract/schemas/personal-agent-session";

const { verify, getApiClient } = vi.hoisted(() => {
	const verify = vi.fn();
	return {
		verify,
		getApiClient: vi.fn(() => ({ osTenant: { personalAgentSession: verify } })),
	};
});
vi.mock("./lib/api-client", () => ({ getApiClient }));
const env = { API_SERVICE: {} } as CloudflareEnv;
const input = () => ({
	request: new Request("https://mcp.example/mcp", {
		headers: { "Poppy-Session": "fictional-jwt", "Poppy-Version": "1.0" },
	}),
	appId: "app-example",
	organizationId: "org-example",
	env,
});

describe("signed-out MCP Session gate", () => {
	beforeEach(() => vi.clearAllMocks());
	it.each([
		["Poppy-Session", 20000, "sessionToken", "invalid_session"],
		["Poppy-Version", 40, "version", "version_unsupported"],
	] as const)(
		"returns a protocol error for an oversized %s header",
		async (header, size, field, status) => {
			const p = input();
			p.request.headers.set(header, "x".repeat(size));
			verify.mockResolvedValue({ status });
			const response = await checkSignedOutPersonalAgentSession(p);
			const payload = verify.mock.calls[0]![0];
			expect(PersonalAgentSessionRequestSchema.safeParse(payload).success).toBe(
				true,
			);
			expect(payload[field]).toBeNull();
			expect(response?.status).toBe(400);
			expect(await response?.json()).toEqual({ error: status });
		},
	);
	it.each(["accepted", "not_configured"])(
		"continues normal MCP routing for %s without granting account headers",
		async (status) => {
			verify.mockResolvedValue({ status });
			const p = input();
			expect(await checkSignedOutPersonalAgentSession(p)).toBeNull();
			expect(
				[...p.request.headers.keys()].filter((name) =>
					name.startsWith("x-tedix-auth-"),
				),
			).toEqual([]);
			expect(getApiClient).toHaveBeenCalledWith({
				serviceFetch: env.API_SERVICE,
				orgId: p.organizationId,
			});
			expect(verify).toHaveBeenCalledWith({
				organizationId: p.organizationId,
				appId: p.appId,
				url: p.request.url,
				method: "GET",
				sessionToken: "fictional-jwt",
				version: "1.0",
			});
		},
	);
	it.each([
		"invalid_session",
		"session_ended",
		"version_unsupported",
		"rate_limited",
	])(
		"returns the %s protocol error without echoing credentials",
		async (status) => {
			verify.mockResolvedValue({ status });
			const response = await checkSignedOutPersonalAgentSession(input());
			expect(response?.status).toBe(status === "rate_limited" ? 429 : 400);
			expect(await response?.json()).toEqual({ error: status });
			expect(response?.headers.get("cache-control")).toBe("no-store");
		},
	);
	it("propagates infrastructure errors rather than accepting unverified identity", async () => {
		verify.mockRejectedValue(new Error("API unavailable"));
		await expect(checkSignedOutPersonalAgentSession(input())).rejects.toThrow(
			"API unavailable",
		);
	});
});
