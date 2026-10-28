import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SensitiveDataLatch } from "@tedix/api-contract/schemas/sensitive-data-latch";
import {
	callToolResultText,
	requireDestructiveToolApproval,
} from "./governance";
import {
	callerRunRef,
	recordSensitiveRead,
	resetSensitiveDataLatchCaches,
} from "./sensitive-data-latch";
import type { ServerContext } from "./server-context";

const LATCH: SensitiveDataLatch = {
	version: 1,
	latchedAt: "2026-10-27T10:00:00.000Z",
	source: {
		appSlug: "hr",
		toolId: "list_salaries",
		connectionProviderId: "hr-system",
		reason: "connection_restricted",
	},
};

function runAgent(input: {
	latch: SensitiveDataLatch | null | "unavailable";
	caller?: Record<string, unknown>;
	governance?: Record<string, unknown>;
}) {
	const resolveRunSensitiveDataLatch = vi.fn(async () => {
		if (input.latch === "unavailable") throw new Error("api down");
		return { known: true, latch: input.latch };
	});
	const agent = {
		server: { server: { elicitInput: vi.fn() } },
		app: { organizationId: "org-1" },
		appSlug: "cms",
		env: {},
		ctx: { waitUntil: vi.fn() },
		callerIdentity: {
			authType: "service",
			organizationId: "org-1",
			tediId: "tedi-1",
			skillRunId: "run-1",
			skillId: "skill-1",
			workflowExecutionEpoch: 0,
			...input.caller,
		},
		apiClient: {
			mcpGovernance: {
				resolveRunSensitiveDataLatch,
				...input.governance,
			},
		},
	} as unknown as ServerContext;
	return { agent, resolveRunSensitiveDataLatch };
}

const publishTool = {
	toolId: "content_publish",
	title: "Publish",
	publicEgress: true,
	config: { transport: "rpc", endpoint: "cms/publish" },
};
// Declared egress that no other gate reserves for a person.
const exportTool = {
	toolId: "export_report",
	title: "Export report",
	publicEgress: true,
	config: { transport: "rpc", endpoint: "reports/export" },
};

describe("sensitive-data latch at the approval gate", () => {
	it("refuses public egress after a sensitive read, with the reason and next step", async () => {
		const { agent } = runAgent({ latch: LATCH });
		const result = await requireDestructiveToolApproval(agent, publishTool, {
			readOnlyHint: false,
		});
		expect(result?.isError).toBe(true);
		const text = callToolResultText(result!);
		expect(text).toContain("read data marked sensitive");
		expect(text).toContain("list_salaries on the hr-system connection");
		expect(text).toContain("owner or admin");
		expect(text).toContain("clear_run_sensitive_data_latch");
		expect(text).toContain("No side effect was executed");
	});

	it("allows the same egress for a run without a sensitive read", async () => {
		// A standing grant approves the export; only the latch could stop it.
		const governance = {
			resolveToolApprovalGrant: vi.fn(async () => ({
				approved: true,
				grantId: "grant-1",
			})),
		};
		const grantedExport = {
			...exportTool,
			config: { ...exportTool.config, approvalPolicy: "always" },
		};
		const { agent, resolveRunSensitiveDataLatch } = runAgent({
			latch: null,
			governance,
		});
		expect(
			await requireDestructiveToolApproval(agent, grantedExport, {
				destructiveHint: true,
			}),
		).toBeNull();
		expect(resolveRunSensitiveDataLatch).toHaveBeenCalledWith({
			organizationId: "org-1",
			runRef: { kind: "skill_run", id: "run-1" },
		});
		const latched = await requireDestructiveToolApproval(
			runAgent({ latch: LATCH, governance }).agent,
			grantedExport,
			{ destructiveHint: true },
		);
		expect(callToolResultText(latched!)).toContain(
			"read data marked sensitive",
		);
	});

	it("does not look up the latch for a caller outside any run", async () => {
		const { agent, resolveRunSensitiveDataLatch } = runAgent({
			latch: LATCH,
			caller: { skillRunId: undefined, requestRunId: undefined },
		});
		await requireDestructiveToolApproval(agent, publishTool, {
			readOnlyHint: false,
		});
		expect(resolveRunSensitiveDataLatch).not.toHaveBeenCalled();
	});

	it("refuses egress even on a Home approval replay of a latched kernel run", async () => {
		const resolveHomeToolApproval = vi.fn(async () => ({ approved: true }));
		const { agent } = runAgent({
			latch: LATCH,
			caller: {
				kernel: true,
				userId: "user-1",
				skillRunId: undefined,
				requestRunId: "home-1",
			},
			governance: { resolveHomeToolApproval },
		});
		const result = await requireDestructiveToolApproval(
			agent,
			publishTool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"com.tedix/homeApprovalRequestId":
							"00000000-0000-4000-8000-000000000009",
					},
				},
			},
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("read data marked sensitive");
		expect(resolveHomeToolApproval).not.toHaveBeenCalled();
	});

	it("fails closed on egress when the latch cannot be read", async () => {
		const { agent } = runAgent({ latch: "unavailable" });
		const result = await requireDestructiveToolApproval(agent, publishTool, {
			readOnlyHint: false,
		});
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("could not be checked");
	});

	it("refuses a durable-grant auto-approval while latched", async () => {
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "grant-1",
		}));
		const { agent } = runAgent({
			latch: LATCH,
			governance: { resolveToolApprovalGrant },
		});
		const result = await requireDestructiveToolApproval(
			agent,
			{
				toolId: "update_record",
				title: "Update",
				config: { approvalPolicy: "always" },
			},
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("automatic approval");
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
	});

	it("still honors the grant for the same tool when the run is not latched", async () => {
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "grant-1",
		}));
		const { agent } = runAgent({
			latch: null,
			governance: { resolveToolApprovalGrant },
		});
		expect(
			await requireDestructiveToolApproval(
				agent,
				{
					toolId: "update_record",
					title: "Update",
					config: { approvalPolicy: "always" },
				},
				{ destructiveHint: true },
				{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
			),
		).toBeNull();
		expect(resolveToolApprovalGrant).toHaveBeenCalled();
	});
});

describe("sensitive-data latch and an admin's action-type opt-in", () => {
	// A third-party write whose declared action type an admin let run without asking.
	const comment = {
		toolId: "github__add_issue_comment",
		title: "Comment on issue",
		actionType: "comment_on_issue",
		writeCapability: "write" as const,
		config: {
			transport: "mcp",
			mcpToolName: "add_issue_comment",
			auth: { type: "connection", connectionId: "github" },
		},
		meta: {
			"com.tedix/policy": {
				riskTier: "external_side_effect",
				blastRadius: "external_system",
			},
		},
	};
	const governance = () => ({
		resolveAgentTransportPolicy: vi.fn(async () => ({
			requireExplicitApprovalPolicy: false,
			autonomy: { version: 1, maxRisk: "medium" },
		})),
		resolveActionTypeOptIn: vi.fn(async () => ({
			approved: true,
			grantId: "grant-comment",
		})),
		recordPolicyToolApproval: vi.fn(async () => ({
			approvalRequestId: null,
		})),
	});
	const annotations = { readOnlyHint: false, destructiveHint: false };

	it("asks a person instead of using the opt-in once the run is latched", async () => {
		const clear = governance();
		const { agent } = runAgent({
			latch: null,
			caller: { authType: "tedi" },
			governance: clear,
		});
		expect(
			await requireDestructiveToolApproval(agent, comment, annotations, {
				args: { issue: 7, body: "Looks good" },
			}),
		).toBeNull();
		expect(clear.resolveActionTypeOptIn).toHaveBeenCalled();

		const latched = governance();
		const result = await requireDestructiveToolApproval(
			runAgent({
				latch: LATCH,
				caller: { authType: "tedi" },
				governance: latched,
			}).agent,
			comment,
			annotations,
			{ args: { issue: 7, body: "Looks good" } },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("automatic approval");
		expect(callToolResultText(result!)).toContain("read data marked sensitive");
		expect(latched.resolveActionTypeOptIn).not.toHaveBeenCalled();
	});
});

describe("recording a sensitive read", () => {
	beforeEach(() => resetSensitiveDataLatchCaches());

	const gmailRead = (toolName = "get_message") => ({
		version: 1 as const,
		kind: "connected_collection_read" as const,
		source: {
			appId: "app-1",
			appSlug: "google-gmail",
			toolName,
			connectionProviderId: "google-gmail",
		},
		collection: "messages",
		observedAt: "2026-10-27T10:00:00.000Z",
	});
	const firecrawlRead = {
		version: 1 as const,
		kind: "connected_collection_read" as const,
		source: {
			appId: "app-2",
			appSlug: "firecrawl",
			toolName: "firecrawl_search",
			connectionProviderId: "firecrawl",
		},
		collection: null,
		observedAt: "2026-10-28T07:00:00.000Z",
	};

	function agentFor(
		runId: string,
		mcpGovernance: Record<string, unknown>,
	): ServerContext {
		return {
			app: { organizationId: "org-1" },
			appSlug: "hr",
			callerIdentity: { authType: "service", skillRunId: runId },
			apiClient: { mcpGovernance },
		} as unknown as ServerContext;
	}

	it("maps the caller to its skill run or Home run", () => {
		expect(
			callerRunRef({ skillRunId: "run-1", requestRunId: "home-1" }),
		).toEqual({ kind: "skill_run", id: "run-1" });
		expect(callerRunRef({ requestRunId: "home-1" })).toEqual({
			kind: "kernel_run",
			id: "home-1",
		});
		expect(callerRunRef({})).toBeNull();
	});

	it("latches a declared sensitive tool without asking about any connection", async () => {
		const latchRunSensitiveData = vi.fn(async () => ({
			known: true,
			latch: LATCH,
		}));
		const resolveConnectionSensitivity = vi.fn();
		const agent = agentFor("run-1", {
			latchRunSensitiveData,
			resolveConnectionSensitivity,
		});
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "list_salaries", sensitiveData: true },
				null,
			),
		).toBe(true);
		expect(resolveConnectionSensitivity).not.toHaveBeenCalled();
		expect(latchRunSensitiveData).toHaveBeenCalledWith({
			organizationId: "org-1",
			runRef: { kind: "skill_run", id: "run-1" },
			source: {
				appSlug: "hr",
				toolId: "list_salaries",
				connectionProviderId: null,
				toolDeclaredSensitive: true,
			},
		});
	});

	it("never withholds a non-sensitive connected read, even when the latch API errors", async () => {
		const latchRunSensitiveData = vi.fn(async () => {
			throw new Error("D1 unavailable");
		});
		const resolveConnectionSensitivity = vi.fn(async () => ({
			restricted: false,
		}));
		const agent = agentFor("run-fc", {
			latchRunSensitiveData,
			resolveConnectionSensitivity,
		});
		for (let i = 0; i < 3; i += 1) {
			expect(
				await recordSensitiveRead(
					agent,
					{ toolId: "firecrawl__firecrawl_search", sensitiveData: false },
					firecrawlRead,
				),
			).toBe(true);
		}
		expect(latchRunSensitiveData).not.toHaveBeenCalled();
		// The classification is cached per organization and provider.
		expect(resolveConnectionSensitivity).toHaveBeenCalledTimes(1);
		expect(resolveConnectionSensitivity).toHaveBeenCalledWith({
			organizationId: "org-1",
			connectionProviderId: "firecrawl",
		});
	});

	it("reuses a known classification when the lookup fails later", async () => {
		const latchRunSensitiveData = vi.fn(async () => {
			throw new Error("D1 unavailable");
		});
		const resolveConnectionSensitivity = vi
			.fn<() => Promise<{ restricted: boolean }>>()
			.mockResolvedValueOnce({ restricted: false })
			.mockRejectedValue(new Error("D1 unavailable"));
		const agent = agentFor("run-fc2", {
			latchRunSensitiveData,
			resolveConnectionSensitivity,
		});
		const read = () =>
			recordSensitiveRead(
				agent,
				{ toolId: "firecrawl__firecrawl_search", sensitiveData: false },
				firecrawlRead,
			);
		expect(await read()).toBe(true);
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 6 * 60 * 1000);
			expect(await read()).toBe(true);
		} finally {
			vi.useRealTimers();
		}
		expect(resolveConnectionSensitivity).toHaveBeenCalledTimes(2);
		expect(latchRunSensitiveData).not.toHaveBeenCalled();
	});

	it("withholds a connected read whose classification was never known while the API is down", async () => {
		const agent = agentFor("run-unknown", {
			latchRunSensitiveData: vi.fn(),
			resolveConnectionSensitivity: vi.fn(async () => {
				throw new Error("D1 unavailable");
			}),
		});
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "firecrawl__firecrawl_search", sensitiveData: false },
				firecrawlRead,
			),
		).toBe(false);
	});

	it("latches a restricted connection's read once per run and skips the write afterwards", async () => {
		const latchRunSensitiveData = vi.fn(async () => ({
			known: true,
			latch: LATCH,
		}));
		const agent = agentFor("run-2", {
			latchRunSensitiveData,
			resolveConnectionSensitivity: vi.fn(async () => ({ restricted: true })),
		});
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "get_message", sensitiveData: false },
				gmailRead(),
			),
		).toBe(true);
		expect(latchRunSensitiveData).toHaveBeenCalledWith(
			expect.objectContaining({
				runRef: { kind: "skill_run", id: "run-2" },
				source: expect.objectContaining({
					appSlug: "google-gmail",
					connectionProviderId: "google-gmail",
					toolDeclaredSensitive: false,
				}),
			}),
		);
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "list_messages", sensitiveData: false },
				gmailRead("list_messages"),
			),
		).toBe(true);
		expect(latchRunSensitiveData).toHaveBeenCalledTimes(1);
	});

	it("does nothing for a read that is neither declared sensitive nor connected", async () => {
		const latchRunSensitiveData = vi.fn();
		const resolveConnectionSensitivity = vi.fn();
		const agent = agentFor("run-3", {
			latchRunSensitiveData,
			resolveConnectionSensitivity,
		});
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "list_apps", sensitiveData: false },
				null,
			),
		).toBe(true);
		expect(latchRunSensitiveData).not.toHaveBeenCalled();
		expect(resolveConnectionSensitivity).not.toHaveBeenCalled();
	});

	it("retries the latch write once, then withholds the sensitive read", async () => {
		const latchRunSensitiveData = vi
			.fn<() => Promise<{ known: boolean; latch: SensitiveDataLatch | null }>>()
			.mockRejectedValueOnce(new Error("api down"))
			.mockResolvedValueOnce({ known: true, latch: LATCH });
		const agent = {
			app: { organizationId: "org-1" },
			appSlug: "hr",
			callerIdentity: { authType: "service", requestRunId: "home-1" },
			apiClient: { mcpGovernance: { latchRunSensitiveData } },
		} as unknown as ServerContext;
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "list_salaries", sensitiveData: true },
				null,
			),
		).toBe(true);
		expect(latchRunSensitiveData).toHaveBeenCalledTimes(2);

		const failing = {
			...agent,
			callerIdentity: { authType: "service", requestRunId: "home-2" },
			apiClient: {
				mcpGovernance: {
					latchRunSensitiveData: vi.fn(async () => {
						throw new Error("api down");
					}),
				},
			},
		} as unknown as ServerContext;
		expect(
			await recordSensitiveRead(
				failing,
				{ toolId: "list_salaries", sensitiveData: true },
				null,
			),
		).toBe(false);
	});
});
