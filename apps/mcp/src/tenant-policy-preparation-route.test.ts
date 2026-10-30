import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { prepare, probe, machineProbe } = vi.hoisted(() => ({
	prepare: vi.fn(),
	probe: vi.fn(),
	machineProbe: vi.fn(),
}));
vi.mock("./mcp/tenant-policy-mount", () => ({
	prepareTenantPolicyMount: prepare,
	prepareTenantIdentityProfileMount: prepare,
	prepareTenantNativePolicyMount: prepare,
}));
vi.mock("./mcp/tenant-profile-probe", () => ({
	probeReviewedProviderIdentity: probe,
}));
vi.mock("./mcp/tenant-machine-probe", () => ({
	redeemAndPrepareMachineProviderProof: machineProbe,
}));
import worker, { InternalEntrypoint } from "./index";

const env = {
	ENVIRONMENT: "development",
	MCP_URL: "https://mcp.example.test",
	API_URL: "https://api.example.test",
	API_SERVICE: { fetch: vi.fn() },
} as unknown as CloudflareEnv;
const ctx = {
	waitUntil: vi.fn(),
	passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;
function request(service: boolean) {
	return new Request(
		"https://mcp.example.test/_internal/tenant-tool-policy/prepare",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(service ? { "X-Service-Binding": "true" } : {}),
			},
			body: JSON.stringify({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: "app__tool",
			}),
		},
	);
}

describe("tenant policy mount preparation ingress", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		prepare.mockResolvedValue({
			descriptor: { version: 1 },
			descriptorDigest: "digest",
		});
		probe.mockResolvedValue("c".repeat(64));
		machineProbe.mockResolvedValue({ receiptId: "proof" });
	});
	it("rejects public requests even when they forge the service header", async () => {
		const response = await worker.fetch(request(true), env, ctx);
		expect(response.status).toBe(403);
		expect(prepare).not.toHaveBeenCalled();
	});
	it("allows only the internal binding to ask for a fresh mount", async () => {
		const noBinding = await new InternalEntrypoint(ctx, env).fetch(
			request(false),
		);
		expect(noBinding.status).toBe(403);
		const response = await new InternalEntrypoint(ctx, env).fetch(
			request(true),
		);
		expect(response.status).toBe(200);
		expect(prepare).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: "app__tool",
			}),
		);
	});
	it("keeps requester-bound identity probes behind the internal binding", async () => {
		const probeRequest = () =>
			new Request(
				"https://mcp.example.test/_internal/tenant-tool-policy/probe-profile",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Service-Binding": "true",
					},
					body: JSON.stringify({
						organizationId: "org",
						receiptId: "receipt",
						exampleArgs: { page: "one" },
					}),
				},
			);
		expect((await worker.fetch(probeRequest(), env, ctx)).status).toBe(403);
		expect(probe).not.toHaveBeenCalled();
		const internal = await new InternalEntrypoint(ctx, env).fetch(
			probeRequest(),
		);
		expect(internal.status).toBe(200);
		expect(await internal.json()).toEqual({
			accountRevisionDigest: "c".repeat(64),
		});
		expect(probe).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org",
				receiptId: "receipt",
				exampleArgs: { page: "one" },
			}),
		);
	});
	it("keeps machine proof redemption behind the internal binding", async () => {
		const request = () =>
			new Request(
				"https://mcp.example.test/_internal/tenant-tool-policy/probe-machine",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Service-Binding": "true",
					},
					body: JSON.stringify({
						organizationId: "org",
						receiptId: "receipt",
						exampleArgs: { page: "one" },
						principalId: "untrusted",
					}),
				},
			);
		expect((await worker.fetch(request(), env, ctx)).status).toBe(403);
		expect(machineProbe).not.toHaveBeenCalled();
		const response = await new InternalEntrypoint(ctx, env).fetch(request());
		expect(await response.json()).toEqual({ receiptId: "proof" });
		expect(machineProbe).toHaveBeenCalledWith(
			expect.not.objectContaining({ principalId: "untrusted" }),
		);
	});
});
