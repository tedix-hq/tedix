import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ServerContext } from "./server-context";
const mocks = vi.hoisted(() => ({
	authority: vi.fn(),
	approve: vi.fn(),
	proof: vi.fn(),
}));
vi.mock("./tenant-machine-probe", () => ({
	prepareMachineProviderProof: mocks.proof,
}));
vi.mock("../auth-helpers", async (original) => ({
	...(await original<typeof import("../auth-helpers")>()),
	resolveFreshExternalAgentAihAuthority: mocks.authority,
}));
vi.mock("@tedix/api-client/internal", async (original) => ({
	...(await original<typeof import("@tedix/api-client/internal")>()),
	getInternalApiClient: () => ({
		mcpGovernance: {
			requestNativeMachineToolApproval: mocks.approve,
			requestMachineToolApproval: mocks.approve,
		},
	}),
}));
import { requireDestructiveToolApproval } from "./governance";

const agent = {
	appId: "root",
	appSlug: "gateway",
	app: { organizationId: "org" },
	env: { API_SERVICE: {} },
	server: { server: { elicitInput: vi.fn() } },
	callerIdentity: {
		authType: "external_agent",
		organizationId: "org",
		externalAgentPrincipalId: "principal",
		externalAgentSessionId: "session",
		externalAgentClientRecordId: "record",
		externalAgentMcpServerId: "server",
		clientId: "client",
	},
} as unknown as ServerContext;
const tool = {
	toolId: "example_read",
	title: "Read",
	config: { transport: "rpc", endpoint: "examples/read" },
	meta: {
		"com.tedix/policy": {
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
	},
};
const newCandidate = () => ({
	descriptor: { kind: "native_rpc" },
	descriptorDigest: "digest",
	revisionId: "revision",
	ruleDigest: "rule",
	effect: {
		disposition: "ask",
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	},
	revalidate: vi.fn().mockResolvedValue(true),
});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.authority.mockResolvedValue({ scopes: ["examples.read"] });
	mocks.approve.mockResolvedValue({
		approved: true,
		approvalRequestId: "approval",
		status: "approved",
		url: "https://example.test",
	});
});
describe("native machine approval", () => {
	it("defers connected machine approval consumption until the verified provider send", async () => {
		mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
		mocks.proof.mockResolvedValue({ receiptId: "" });
		const candidate = {
			descriptor: {
				kind: "machine",
				mount: { rootAppId: "root" },
				profileId: "profile",
				accountRevisionDigest: "a".repeat(64),
			},
			descriptorDigest: "digest",
			revisionId: "revision",
			ruleDigest: "rule",
			effect: {
				disposition: "ask",
				riskTier: "bounded_write",
				blastRadius: "single_resource",
			},
			probe: { revalidate: vi.fn().mockResolvedValue(true) },
		};
		const connectedTool = {
			...tool,
			config: {
				transport: "mcp",
				mcpToolName: "edit",
				auth: { type: "connection", connectionId: "provider" },
			},
		};
		expect(
			await requireDestructiveToolApproval(agent, connectedTool, null, {
				args: { id: "one" },
				extra: { _meta: { "com.tedix/approvalRequestId": "approval" } },
				tenantPolicyCandidate: candidate as never,
			}),
		).toBeNull();
		expect(mocks.approve).not.toHaveBeenCalled();
		expect(await candidate.probe.revalidate()).toBe(true);
		expect(mocks.approve).toHaveBeenCalledOnce();
		expect(await candidate.probe.revalidate()).toBe(false);
	});
	it("requires fresh admin scope for a high-impact connected approval", async () => {
		mocks.proof.mockResolvedValue({ receiptId: "" });
		mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
		const candidate = {
			descriptor: {
				kind: "machine",
				mount: { rootAppId: "root" },
				profileId: "profile",
				accountRevisionDigest: "a".repeat(64),
			},
			descriptorDigest: "digest",
			revisionId: "revision",
			ruleDigest: "rule",
			effect: {
				disposition: "ask",
				riskTier: "high_impact_write",
				blastRadius: "external_system",
			},
			probe: { revalidate: vi.fn().mockResolvedValue(true) },
		};
		const connectedTool = {
			...tool,
			config: {
				transport: "mcp",
				mcpToolName: "edit",
				auth: { type: "connection", connectionId: "provider" },
			},
		};
		expect(
			(
				await requireDestructiveToolApproval(agent, connectedTool, null, {
					args: {},
					tenantPolicyCandidate: candidate as never,
				})
			)?.isError,
		).toBe(true);
		expect(mocks.approve).not.toHaveBeenCalled();
		mocks.authority.mockResolvedValue({
			scopes: ["connections.execute", "connections.admin"],
		});
		mocks.approve.mockResolvedValue({
			approved: false,
			approvalRequestId: "approval",
			status: "pending",
			url: "https://example.test",
		});
		expect(
			(
				await requireDestructiveToolApproval(agent, connectedTool, null, {
					args: {},
					tenantPolicyCandidate: candidate as never,
				})
			)?.isError,
		).toBe(true);
		expect(mocks.approve).toHaveBeenCalledOnce();
	});
	it("consumes only immediately before the first RPC send", async () => {
		const candidate = newCandidate();
		expect(
			await requireDestructiveToolApproval(agent, tool, null, {
				args: { id: "one" },
				extra: { _meta: { "com.tedix/approvalRequestId": "approval" } },
				nativePolicyCandidate: candidate as never,
			}),
		).toBeNull();
		expect(mocks.approve).not.toHaveBeenCalled();
		expect(await candidate.revalidate()).toBe(true);
		expect(mocks.approve).toHaveBeenCalledOnce();
		expect(await candidate.revalidate()).toBe(false);
		expect(mocks.approve).toHaveBeenCalledOnce();
	});
	it("does not consume if fresh tool authority was lost", async () => {
		const candidate = newCandidate();
		await requireDestructiveToolApproval(agent, tool, null, {
			args: {},
			extra: { _meta: { "com.tedix/approvalRequestId": "approval" } },
			nativePolicyCandidate: candidate as never,
		});
		mocks.authority.mockResolvedValue(null);
		expect(await candidate.revalidate()).toBe(false);
		expect(mocks.approve).not.toHaveBeenCalled();
	});
	it("keeps separately configured platform approvals outside the policy path", async () => {
		const candidate = newCandidate();
		const result = await requireDestructiveToolApproval(
			agent,
			{ ...tool, config: { ...tool.config, approvalPolicy: "always" } },
			{ destructiveHint: true },
			{ args: {}, nativePolicyCandidate: candidate as never },
		);
		expect(result?.isError).toBe(true);
		expect(mocks.approve).not.toHaveBeenCalled();
	});
	it("parks a high-impact default ask for a real human approver", async () => {
		const candidate = newCandidate();
		candidate.effect = {
			disposition: "ask",
			riskTier: "high_impact_write",
			blastRadius: "external_system",
		};
		mocks.approve.mockResolvedValue({
			approved: false,
			approvalRequestId: "approval",
			status: "pending",
			url: "https://example.test",
		});
		const result = await requireDestructiveToolApproval(
			agent,
			tool,
			{ destructiveHint: true },
			{ args: {}, nativePolicyCandidate: candidate as never },
		);
		expect(result?.isError).toBe(true);
		expect(mocks.approve).toHaveBeenCalledOnce();
	});
});
