import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	validateAuth: vi.fn(),
	validateHumanMcpSelection: vi.fn(),
	resolveMcpExpectedAudience: vi.fn(),
	resolveAppFromHostname: vi.fn(),
	extractAppFromHostname: vi.fn(),
	getInternalApiClient: vi.fn(),
	getInteraction: vi.fn(),
}));
vi.mock("./auth-helpers", () => ({
	validateAuth: mocks.validateAuth,
	validateHumanMcpSelection: mocks.validateHumanMcpSelection,
	resolveMcpExpectedAudience: mocks.resolveMcpExpectedAudience,
}));
vi.mock("./resolution", () => ({
	resolveAppFromHostname: mocks.resolveAppFromHostname,
}));
vi.mock("./hostname", () => ({
	extractAppFromHostname: mocks.extractAppFromHostname,
}));
vi.mock("@tedix/api-client/internal", () => ({
	getInternalApiClient: mocks.getInternalApiClient,
}));

import { authorizeInteractionEvent } from "./interaction-event-auth";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const otherOrg = "00000000-0000-4000-8000-000000000003";
const credential = {
	authorization: "Bearer original-human-credential",
	mcpUrl: "https://connect.tedix.test/mcp",
	organizationId: ORGANIZATION_ID,
	requestId: REQUEST_ID,
};
const env = { ENVIRONMENT: "test" } as CloudflareEnv;
const expires = Math.floor(Date.now() / 1000) + 3600;
function auth() {
	return {
		type: "oauth",
		scopes: ["mcp:messaging.read"],
		payload: { sub: "human-subject", exp: expires },
	};
}
function selected(organizationId = ORGANIZATION_ID) {
	return {
		organizations: [
			{
				organizationId,
				descopeTenantId: "tenant-selected",
				gatewaySlug: "selected-unified",
			},
		],
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.extractAppFromHostname.mockReturnValue({
		type: "custom",
		customDomain: "connect.tedix.test",
	});
	mocks.resolveAppFromHostname.mockResolvedValue({
		app: { organizationId: otherOrg },
		metadata: {
			mcpConfig: {
				interactionEvents: true,
				descopeResourceId: "resource-test",
				multiOrgConsent: true,
			},
		},
	});
	mocks.resolveMcpExpectedAudience.mockReturnValue(credential.mcpUrl);
	mocks.validateAuth.mockResolvedValue(auth());
	mocks.validateHumanMcpSelection.mockResolvedValue(selected());
	mocks.getInternalApiClient.mockReturnValue({
		workInteractions: { get: mocks.getInteraction },
	});
	mocks.getInteraction.mockResolvedValue({
		request: { orgId: ORGANIZATION_ID, id: REQUEST_ID },
	});
});

describe("Interaction event live authorization", () => {
	it("never treats the verified local demo owner as a human OAuth event grant", async () => {
		mocks.validateAuth.mockResolvedValue({ ...auth(), localDemo: true });
		await expect(authorizeInteractionEvent(env, credential)).rejects.toThrow(
			"Human OAuth required",
		);
		expect(mocks.validateHumanMcpSelection).not.toHaveBeenCalled();
		expect(mocks.getInteraction).not.toHaveBeenCalled();
	});
	it("revalidates only the original bearer and exact current grant on every read", async () => {
		for (let i = 0; i < 2; i++) {
			expect(await authorizeInteractionEvent(env, credential)).toEqual({
				owner: "human-subject",
				expiresAt: expires * 1000,
			});
		}
		expect(mocks.validateAuth).toHaveBeenCalledTimes(2);
		expect(mocks.validateHumanMcpSelection).toHaveBeenCalledTimes(2);
		expect(mocks.getInteraction).toHaveBeenCalledTimes(2);
		for (const [request, actualEnv, options] of mocks.validateAuth.mock.calls) {
			expect(request.url).toBe(credential.mcpUrl);
			expect([...request.headers.entries()]).toEqual([
				["authorization", credential.authorization],
			]);
			expect(actualEnv).toBe(env);
			expect(options).toEqual({
				hostname: "connect.tedix.test",
				expectedAudience: credential.mcpUrl,
				mcpServerId: "resource-test",
			});
		}
		expect(mocks.validateHumanMcpSelection).toHaveBeenCalledWith(
			auth().payload,
			env,
			{
				audience: credential.mcpUrl,
				mcpServerId: "resource-test",
				multiOrganization: true,
			},
		);
		expect(mocks.getInternalApiClient).toHaveBeenCalledWith(env, {
			organizationId: ORGANIZATION_ID,
			headers: {
				"X-Forwarded-Authorization": credential.authorization,
				"X-Tedix-Caller-Type": "mcp-edge-user",
				"X-Tedix-Mcp-Caller-Scopes": "mcp:messaging.read",
			},
		});
		expect(mocks.getInteraction).toHaveBeenCalledWith({
			requestId: REQUEST_ID,
			responseLimit: 1,
		});
	});

	it.each([
		[
			"expired bearer rejected by validator",
			() => Response.json({ error: "expired" }, { status: 401 }),
		],
		["machine credential", () => ({ ...auth(), type: "apikey" })],
		[
			"tedi token",
			() => ({ ...auth(), payload: { ...auth().payload, entityType: "tedi" } }),
		],
		[
			"missing expiry",
			() => ({ ...auth(), payload: { sub: "human-subject" } }),
		],
		["wrong scope", () => ({ ...auth(), scopes: ["mcp:work.read"] })],
	] as const)("prevents disclosure for %s", async (_name, invalidAuth) => {
		mocks.validateAuth.mockResolvedValue(invalidAuth());
		await expect(authorizeInteractionEvent(env, credential)).rejects.toThrow();
		expect(mocks.getInteraction).not.toHaveBeenCalled();
	});

	it("fails closed when the current grant is revoked after a successful read", async () => {
		await authorizeInteractionEvent(env, credential);
		mocks.validateHumanMcpSelection.mockResolvedValue(null);
		await expect(authorizeInteractionEvent(env, credential)).rejects.toThrow(
			"Current consent unavailable",
		);
		expect(mocks.getInteraction).toHaveBeenCalledTimes(1);
	});

	it("rejects organizations outside the live selection", async () => {
		mocks.validateHumanMcpSelection.mockResolvedValue(selected(otherOrg));
		await expect(authorizeInteractionEvent(env, credential)).rejects.toThrow();
		expect(mocks.getInteraction).not.toHaveBeenCalled();
	});

	it("requires a single-org app to own the selected organization", async () => {
		mocks.resolveAppFromHostname.mockResolvedValue({
			app: { organizationId: otherOrg },
			metadata: {
				mcpConfig: {
					interactionEvents: true,
					descopeResourceId: "resource-test",
					multiOrgConsent: false,
				},
			},
		});
		await expect(authorizeInteractionEvent(env, credential)).rejects.toThrow(
			"Organization not selected",
		);
		expect(mocks.getInteraction).not.toHaveBeenCalled();
	});

	it("honors current exact Interaction access denial", async () => {
		mocks.getInteraction.mockRejectedValue(new Error("FORBIDDEN"));
		await expect(authorizeInteractionEvent(env, credential)).rejects.toThrow(
			"FORBIDDEN",
		);
	});

	it.each([
		{ orgId: otherOrg, id: REQUEST_ID },
		{ orgId: ORGANIZATION_ID, id: "00000000-0000-4000-8000-000000000004" },
	])("rejects a mismatched canonical request result", async (request) => {
		mocks.getInteraction.mockResolvedValue({ request });
		await expect(authorizeInteractionEvent(env, credential)).rejects.toThrow(
			"Interaction scope mismatch",
		);
	});
});
