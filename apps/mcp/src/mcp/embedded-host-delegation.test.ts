import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { callApiRpc } from "../lib/rpc";
import {
	resolveEmbeddedHostDelegation,
	redactDelegationResponse,
} from "./embedded-host-delegation";
import type { ToolExecutionContext } from "./handler";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
vi.mock("../lib/rpc", () => ({ callApiRpc: vi.fn() }));
const config = {
	baseUrl: "https://provider.example/api",
	auth: { type: "connection", connectionId: "aggregate-connection" },
	_sourceAppId: "source-app",
} as unknown as ToolConfig;
function context(): ToolExecutionContext<ToolConfig> {
	return {
		env: { API_SERVICE: {} } as CloudflareEnv,
		appId: "gateway",
		appCapabilities: {},
		requestId: "request",
		app: { id: "gateway", slug: "gateway", name: "Gateway", domain: null },
		config,
		toolId: "acme_staging__orders_detail",
		callable: "acme_staging.orders_detail",
		callerIdentity: {
			authType: "tedi",
			tediId: "worker",
			organizationId: "customer",
		},
		requestMeta: { "tedix/embedded-session": "browser-token" },
	} as ToolExecutionContext<ToolConfig>;
}
const accepted = () => ({
	data: {
		token: "provider-assertion",
		providerOrganizationId: "provider",
		connectionProviderId: "source-connection",
		connectionScopes: ["orders:read"],
		authHeader: "Authorization",
		authTemplate: "{token}",
		audience: "https://provider.example",
		expiresAt: Date.now() / 1000 + 60,
	},
	status: 200,
});
describe("embedded host delegation", () => {
	beforeEach(() => vi.mocked(callApiRpc).mockReset());
	it("leaves ordinary credential dispatch unchanged", async () => {
		const ctx = context();
		ctx.requestMeta = undefined;
		expect(await resolveEmbeddedHostDelegation(ctx, config)).toBeUndefined();
		expect(callApiRpc).not.toHaveBeenCalled();
	});
	it("uses only authenticated context and trusted projection for service validation", async () => {
		vi.mocked(callApiRpc).mockResolvedValue(accepted());
		expect(
			await resolveEmbeddedHostDelegation(context(), config),
		).toMatchObject({
			token: "provider-assertion",
			providerOrganizationId: "provider",
			connectionProviderId: "source-connection",
			connectionScopes: ["orders:read"],
			authHeader: "Authorization",
			authTemplate: "{token}",
		});
		expect(callApiRpc).toHaveBeenCalledWith(
			expect.anything(),
			"tedis/resolveEmbeddedHostDelegation",
			{
				token: "browser-token",
				tediId: "worker",
				organizationId: "customer",
				sourceAppId: "source-app",
				callable: "acme_staging.orders_detail",
				audience: "https://provider.example",
			},
			expect.objectContaining({ serviceBinding: true }),
		);
	});
	it("rejects missing binding, human callers, and malformed metadata before lookup", async () => {
		for (const patch of [
			{ env: {} },
			{
				callerIdentity: {
					authType: "user",
					tediId: "worker",
					organizationId: "customer",
				},
			},
			{ requestMeta: { "tedix/embedded-session": { token: "forged" } } },
		]) {
			await expect(
				resolveEmbeddedHostDelegation(
					{ ...context(), ...patch } as ToolExecutionContext<ToolConfig>,
					config,
				),
			).rejects.toThrow();
		}
		expect(callApiRpc).not.toHaveBeenCalled();
	});
	it("fails closed on rejected, expired, and wrong-audience resolutions", async () => {
		for (const response of [
			{ status: 403, data: {} },
			{ ...accepted(), data: { ...accepted().data, expiresAt: 1 } },
			{
				...accepted(),
				data: { ...accepted().data, audience: "https://other.example" },
			},
		]) {
			vi.mocked(callApiRpc).mockResolvedValue(response);
			await expect(
				resolveEmbeddedHostDelegation(context(), config),
			).rejects.toThrow();
		}
	});
	it("redacts upstream assertion echoes without truncating product data", () => {
		expect(
			redactDelegationResponse(
				{ text: "Bearer secret", nested: ["secret", 42] },
				"secret",
			),
		).toEqual({ text: "Bearer <redacted>", nested: ["<redacted>", 42] });
	});
});
