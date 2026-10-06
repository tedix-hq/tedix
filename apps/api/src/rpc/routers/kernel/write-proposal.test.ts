import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import * as z from "zod";
import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import type { DbClient } from "@tedix/db/client";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelRouteDecision } from "./route-schema";
import {
	classifyWriteRisk,
	declaredWriteCapability,
	DESTRUCTIVE_VERBS,
	isWriteCapable,
	kernelWriteEnabled,
	planKernelWriteProposal,
	WRITE_ONLY_VERBS,
	type WriteProposalEnv,
} from "./write-proposal";

/**
 * Approved-write proposal planner tests (v1). Stubs `MCP_SERVICE.fetch` to
 * simulate an authorized provider and `MockLanguageModelV3` for the write
 * pass, so the planner's own logic — gate, provider resolution, WRITE-only
 * catalog filtering, pick validation, and fail-soft — is validated
 * deterministically (mirrors execute.test.ts's stub patterns without
 * touching it).
 */

const mocks = vi.hoisted(() => ({
	getAppBySlugForOrg: vi.fn(),
	selectJevAction: vi.fn(),
}));
vi.mock("./jev-action-selection", () => ({
	selectJevAction: mocks.selectJevAction,
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppBySlugForOrg: mocks.getAppBySlugForOrg,
}));

const DB = {} as unknown as DbClient;

function writeRoute(
	overrides: Partial<KernelRouteDecision> = {},
): KernelRouteDecision {
	return {
		routeKind: "propose_tool_write",
		rationale: "Operator wants to create a Globex invoice.",
		risk: "medium",
		confidence: 0.85,
		answer: null,
		targetTediId: null,
		targetTediLabel: null,
		toolIntent: {
			appSlug: "globex",
			capability: "globex.invoices.create",
			connectionStatus: "connected",
		},
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
		...overrides,
	};
}

interface RecordedCall {
	url: string;
	headers: Headers;
	method: string;
	params: Record<string, unknown>;
}

/**
 * A 2026-07-28 server echoes the request id, stamps `resultType` on every
 * result, adds SEP-2549 freshness hints to list results, gives every listed
 * tool an object inputSchema and every tool result a content array; the fixtures
 * state only the payload that matters.
 */
function modernReply(
	body: { id?: unknown; method: string },
	json: unknown,
): unknown {
	if (!json || typeof json !== "object") return json;
	const envelope = json as { result?: Record<string, unknown> };
	return {
		...envelope,
		id: body.id,
		...(envelope.result
			? {
					result: {
						resultType: "complete",
						...(body.method.endsWith("/list")
							? { ttlMs: 0, cacheScope: "private" }
							: {}),
						...(body.method === "tools/call" ? { content: [] } : {}),
						...envelope.result,
						...(Array.isArray(envelope.result.tools)
							? {
									tools: envelope.result.tools.map(
										(tool: { inputSchema?: object }) => ({
											...tool,
											inputSchema: { type: "object", ...tool.inputSchema },
										}),
									),
								}
							: {}),
					},
				}
			: {}),
	};
}

/** The request `_meta` envelope the SDK client binds for Home's calls. */
const HOME_REQUEST_META = {
	"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
	"io.modelcontextprotocol/clientInfo": {
		name: "tedix-home",
		version: "1.0.0",
	},
	"io.modelcontextprotocol/clientCapabilities": {},
};

function mcpService(
	handler: (body: { method: string; params: Record<string, unknown> }) => {
		status?: number;
		json: unknown;
	},
) {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: async (input: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			const headers = new Headers(init?.headers);
			// The real gateway rejects legacy requests before dispatching tools.
			if (
				headers.get("MCP-Protocol-Version") !== MCP_MODERN_PROTOCOL_VERSION ||
				headers.get("Mcp-Method") !== body.method ||
				body.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !==
					MCP_MODERN_PROTOCOL_VERSION ||
				!body.params?._meta?.["io.modelcontextprotocol/clientCapabilities"] ||
				(body.method === "tools/call" &&
					headers.get("Mcp-Name") !== body.params.name)
			)
				return new Response("Unsupported MCP request", { status: 400 });
			calls.push({
				url: input,
				headers,
				method: body.method,
				params: body.params,
			});
			const { status = 200, json } = handler(body);
			return new Response(JSON.stringify(modernReply(body, json)), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	};
}

/** Provider listing a write tool, a read tool, and an unclassifiable tool. */
function globexProvider(body: { method: string }): {
	status?: number;
	json: unknown;
} {
	if (body.method === "tools/list") {
		return {
			json: {
				jsonrpc: "2.0",
				id: 1,
				result: {
					tools: [
						{
							name: "globex__create_invoice",
							description: "Create a draft invoice",
							annotations: { destructiveHint: true },
							inputSchema: {
								properties: {
									amount: { type: "number" },
									customerName: { type: "string" },
								},
								required: ["amount"],
							},
						},
						{
							name: "globex__get_invoices",
							description: "List invoices",
							annotations: { readOnlyHint: true },
							inputSchema: { properties: { limit: { type: "number" } } },
						},
						{
							name: "globex__invoice_render",
							description: "Neither read nor write verb, unannotated",
						},
					],
				},
			},
		};
	}
	return { json: { jsonrpc: "2.0", id: 1, error: { message: "unexpected" } } };
}

function objectModel(object: unknown): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
			content: [{ type: "text", text: JSON.stringify(object) }],
		}),
	});
}

function baseEnv(
	service: ReturnType<typeof mcpService>,
	overrides: Partial<WriteProposalEnv> = {},
): WriteProposalEnv {
	return {
		MCP_SERVICE: service,
		MCP_URL: "https://mcp.tedix.dev",
		PLATFORM_SERVICE_TOKEN: "svc-token",
		KERNEL_EXECUTE: "true",
		...overrides,
	};
}

beforeEach(() => {
	mocks.selectJevAction.mockReset();
	mocks.selectJevAction.mockImplementation(async ({ candidates }) => ({
		toolName: candidates[0]?.id ?? null,
		reason: "selected",
	}));
	mocks.getAppBySlugForOrg.mockReset();
	mocks.getAppBySlugForOrg.mockImplementation(
		async (_db: unknown, slug: string) =>
			slug === "globex-tedix" ? { slug } : null,
	);
});

describe("kernelWriteEnabled", () => {
	it("is true only when KERNEL_EXECUTE === 'true'", () => {
		expect(kernelWriteEnabled({ KERNEL_EXECUTE: "true" })).toBe(true);
		expect(kernelWriteEnabled({ KERNEL_EXECUTE: "false" })).toBe(false);
		expect(kernelWriteEnabled({})).toBe(false);
	});
});

describe("isWriteCapable", () => {
	it("classifies by DECLARATION; only a declared read-only tool is excluded", () => {
		expect(
			isWriteCapable({ name: "x", annotations: { destructiveHint: true } }),
		).toBe(true);
		expect(
			isWriteCapable({
				name: "delete_all",
				annotations: { readOnlyHint: true },
			}),
		).toBe(false);
		// Re-pinned with the declaration that was always MEANT here: this used to
		// assert false for an UNANNOTATED name, i.e. it passed for the wrong
		// reason (no verb matched), which is the defect. Stating readOnlyHint
		// keeps the assertion honest instead of weakening it.
		expect(
			isWriteCapable({
				name: "gmail__search_threads",
				annotations: { readOnlyHint: true },
			}),
		).toBe(false);
		expect(isWriteCapable({ name: "gmail__send_message" })).toBe(true);
		// Mixed read+write verb (undeclared) is a WRITE.
		expect(isWriteCapable({ name: "search_delete_contact" })).toBe(true);
	});

	// Undeclared tools are write-capable regardless of their names.
	it("gates an UNDECLARED tool whose name matches no write verb", () => {
		for (const name of [
			"invoice_render",
			"cms_provision_service_key",
			"finalize_invoice",
			"exchange_delivered_order_items",
			"modify_pending_order_payment",
			"modify_user_address",
			"content_restore",
			"content_duplicate",
			"media_generate_image",
			// camelCase: verbMatcher boundaries on separators only, so `create`
			// followed by `J` never matched.
			"createJiraIssue",
			"editJiraIssue",
			"addCommentToJiraIssue",
			"createConfluencePage",
			"createCompassComponent",
		]) {
			expect(declaredWriteCapability({ name })).toBe("undeclared");
			expect(isWriteCapable({ name })).toBe(true);
			// Undeclared can never be policy-auto-approved: no destructiveHint:false
			// means HIGH risk, so it always costs a human card.
			expect(classifyWriteRisk({ name })).toBe("high");
		}
	});

	it("distinguishes an ABSENT annotation from an annotation that is false", () => {
		// absent → undeclared → gated
		expect(declaredWriteCapability({ name: "acme_thing" })).toBe("undeclared");
		// present-and-false → a POSITIVE statement that the tool writes
		expect(
			declaredWriteCapability({
				name: "acme_thing",
				annotations: { readOnlyHint: false },
			}),
		).toBe("declared_write");
		expect(
			declaredWriteCapability({
				name: "acme_thing",
				annotations: { destructiveHint: false },
			}),
		).toBe("declared_write");
		// present-and-true → declared read-only, the ONLY thing that excludes
		expect(
			declaredWriteCapability({
				name: "acme_thing",
				annotations: { readOnlyHint: true },
			}),
		).toBe("declared_read");
		// An annotation object that classifies nothing stays UNDECLARED rather
		// than being read as "annotated, therefore fine".
		expect(
			declaredWriteCapability({
				name: "acme_thing",
				annotations: { idempotentHint: true } as Record<string, boolean>,
			}),
		).toBe("undeclared");
	});

	it("WARNS on the verb fallback instead of silently returning false", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(isWriteCapable({ name: "createJiraIssue" })).toBe(true);
			expect(warn).toHaveBeenCalledTimes(1);
			const [message, detail] = warn.mock.calls[0] ?? [];
			expect(String(message)).toContain("unclassified tool gated as write");
			// Names the tool, so the backlog is greppable from logs.
			expect(detail).toMatchObject({
				tool: "createJiraIssue",
				declaration: "undeclared",
				verbFallbackMatched: false,
				gated: true,
			});

			// A DECLARED tool never warns — the fallback is only for the gap.
			warn.mockClear();
			expect(
				isWriteCapable({
					name: "acme_thing",
					annotations: { readOnlyHint: true },
				}),
			).toBe(false);
			expect(
				isWriteCapable({
					name: "acme_thing",
					annotations: { readOnlyHint: false },
				}),
			).toBe(true);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("sees the destructive verbs that used to be invisible to the write planner", () => {
		// These lived ONLY in the destructive list, so isWriteCapable returned
		// false and the highest-risk tools never reached the write planner at all.
		for (const verb of [
			"drop",
			"purge",
			"wipe",
			"erase",
			"disable",
			"revoke",
			"unassign",
			"reset",
			"terminate",
			"refund",
			"void",
			"expire",
		]) {
			const name = `provider__${verb}_account`;
			expect(isWriteCapable({ name })).toBe(true);
			expect(classifyWriteRisk({ name })).toBe("high");
		}
	});

	it("sees the money/authority verbs", () => {
		for (const verb of [
			"transfer",
			"pay",
			"charge",
			"submit",
			"issue",
			"grant",
			"refund",
			"revoke",
		]) {
			expect(isWriteCapable({ name: `billing__${verb}_thing` })).toBe(true);
		}
	});

	// Moving money and handing out authority must never ride a wildcard
	// auto-approve (`trustedTools: ["stripe:*"]`), so these are HIGH by verb
	// rather than waiting on the provider to annotate them correctly.
	it("classifies money movement and authority grants as high risk", () => {
		for (const verb of [
			"transfer",
			"pay",
			"charge",
			"issue",
			"grant",
			"refund",
			"revoke",
		]) {
			expect(classifyWriteRisk({ name: `billing__${verb}_thing` })).toBe(
				"high",
			);
		}
		// An unannotated submit is fail-closed; a provider can deliberately mark
		// a non-destructive form/job submission low risk.
		expect(classifyWriteRisk({ name: "billing__submit_thing" })).toBe("high");
		expect(
			classifyWriteRisk({
				name: "billing__submit_thing",
				annotations: { destructiveHint: false },
			}),
		).toBe("low");
	});
});

describe("write/destructive verb sets", () => {
	// The invariant the doc comment always claimed but did not hold: DESTRUCTIVE
	// is a SUBSET of WRITE. Adding a destructive verb that is not write-capable
	// (the old failure mode) fails here.
	it("every destructive verb is write-capable and classified high", () => {
		for (const verb of DESTRUCTIVE_VERBS) {
			for (const name of [verb, `app__${verb}_record`, `do.${verb}`]) {
				expect(isWriteCapable({ name })).toBe(true);
				expect(classifyWriteRisk({ name })).toBe("high");
			}
		}
	});

	it("every write-only verb requires an explicit safe annotation for low risk", () => {
		for (const verb of WRITE_ONLY_VERBS) {
			const name = `app__${verb}_record`;
			expect(isWriteCapable({ name })).toBe(true);
			expect(classifyWriteRisk({ name })).toBe("high");
			expect(
				classifyWriteRisk({
					name,
					annotations: { destructiveHint: false },
				}),
			).toBe("low");
		}
	});

	it("the two verb lists are disjoint (no verb is both low and high risk)", () => {
		const destructive = new Set<string>(DESTRUCTIVE_VERBS);
		for (const verb of WRITE_ONLY_VERBS) {
			expect(destructive.has(verb)).toBe(false);
		}
	});
});

describe("classifyWriteRisk", () => {
	it("annotation destructiveHint => high", () => {
		expect(
			classifyWriteRisk({
				name: "create_thing",
				annotations: { destructiveHint: true },
			}),
		).toBe("high");
	});
	it("destructive verbs => high", () => {
		for (const name of [
			"delete_invoice",
			"globex__cancel_order",
			"archive_thread",
			"revoke_token",
			"deactivate_user",
		]) {
			expect(classifyWriteRisk({ name })).toBe("high");
		}
	});
	it("constructive verbs are fail-closed unless explicitly safe", () => {
		for (const name of [
			"create_invoice",
			"gmail__send_message",
			"add_contact",
			"update_record",
			"insert_row",
		]) {
			expect(classifyWriteRisk({ name })).toBe("high");
			expect(
				classifyWriteRisk({
					name,
					annotations: { destructiveHint: false },
				}),
			).toBe("low");
		}
	});
});

describe("classifyWriteRisk fail-closed boundary", () => {
	it("returns low only for an explicit false hint without a destructive verb", () => {
		expect(
			classifyWriteRisk({
				name: "create_invoice",
				annotations: { destructiveHint: false },
			}),
		).toBe("low");
		for (const tool of [
			{ name: "create_invoice" },
			{ name: "send_payment" },
			{ name: "execute_payout" },
			{
				name: "delete_invoice",
				annotations: { destructiveHint: false },
			},
			{
				name: "create_invoice",
				annotations: { destructiveHint: true },
			},
		]) {
			expect(classifyWriteRisk(tool)).toBe("high");
		}
	});
});

describe("planKernelWriteProposal — positive path", () => {
	it("carries workspace context through the remaining argument generation pass without injecting provider arguments", async () => {
		const model = objectModel({
			toolName: "globex__create_invoice",
			argsJson: '{"amount":100}',
			reasoning: null,
		});
		const generate = vi.spyOn(model, "doGenerate");
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(globexProvider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			workspaceContext: {
				workspaceId: "a6083071-d7f3-4056-881d-e8f9c0df0a13",
				workspaceName: "Supplier review",
			},
			model,
		});
		expect(generate).toHaveBeenCalledTimes(1);
		for (const [options] of generate.mock.calls) {
			const prompt = JSON.stringify(options.prompt);
			expect(prompt).toContain("a6083071-d7f3-4056-881d-e8f9c0df0a13");
			expect(prompt).toContain("Supplier review");
			expect(prompt).toContain("not authorization");
		}
		expect(proposal?.args).toEqual({ amount: 100 });
	});

	it("plans the write call: resolved provider slug, validated tool + args", async () => {
		const service = mcpService(globexProvider);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			actingUserId: "user-123",
			content: "create a globex invoice over 100 euros for ACME",
			model: objectModel({
				toolName: "globex__create_invoice",
				argsJson: '{"amount":100,"customerName":"ACME","notAParam":"x"}',
				reasoning: "create the requested invoice",
			}),
		});

		// Undeclared args are dropped; declared args survive. The mock tool carries
		// `destructiveHint:true` ⇒ classified high risk (annotation wins).
		expect(proposal).toEqual({
			appSlug: "globex-tedix",
			toolName: "globex__create_invoice",
			args: { amount: 100, customerName: "ACME" },
			reasoning: "create the requested invoice",
			riskTier: "high",
			transport: "direct",
		});
		// It only LISTS tools — proposal planning never calls tools/call.
		expect(service.calls.map((c) => c.method)).toEqual(["tools/list"]);
		const list = service.calls[0];
		expect(list?.headers.get("X-Tedix-Host")).toBe(
			"globex-tedix.mcp.tedix.dev",
		);
		expect(list?.headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(list?.headers.get("X-Tedix-Acting-User")).toBe("user-123");
		// Tenant control-plane audit marker (kernel actor in apps/mcp).
		expect(list?.headers.get("X-Tedix-Kernel")).toBe("true");
		expect(list?.params._meta).toEqual(HOME_REQUEST_META);
	});

	it("shows the model ONLY write-capable tools (read tools never enter the catalog)", async () => {
		const service = mcpService(globexProvider);
		let captured = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				if (!captured) captured = JSON.stringify(options.prompt);
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify({
								toolName: "globex__create_invoice",
								argsJson: '{"amount":1}',
								reasoning: null,
							}),
						},
					],
				};
			},
		});
		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model,
		});
		captured = JSON.stringify(
			mocks.selectJevAction.mock.calls[0]?.[0].candidates,
		);
		expect(captured).toContain("globex__create_invoice");
		// Only a DECLARED read-only tool is filtered out of the prompt.
		expect(captured).not.toContain("globex__get_invoices");
		// The UNDECLARED tool is admitted (gated), but marked so the planner
		// prefers a declared write, and ranked AFTER declared writes so it can
		// never displace one from the MAX_CATALOG_TOOLS window.
		expect(captured).toContain("globex__invoice_render");
		expect(captured).toContain("globex__invoice_render() [unverified]");
		const text = String(captured);
		// The DECLARED write carries no marker.
		expect(text).toMatch(
			/globex__create_invoice\([^)]*\)[^\\]*?required=\[amount\](?! \[unverified\])/,
		);
		expect(text.indexOf("globex__create_invoice(")).toBeLessThan(
			text.indexOf("globex__invoice_render("),
		);
	});

	it("ranks declared writes ahead of undeclared tools in the catalog", async () => {
		// Blast-radius mitigation: the undeclared set is large and largely
		// read-only in practice, so admitting it must not push a real write out of
		// the truncated prompt window.
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: {
							tools: [
								{ name: "globex__getContact" },
								{ name: "globex__listOrders" },
								{
									name: "globex__create_invoice",
									annotations: { destructiveHint: true },
									inputSchema: { properties: {}, required: [] },
								},
							],
						},
					},
				};
			}
			return { json: { jsonrpc: "2.0", id: 1, error: { message: "no" } } };
		});
		let captured = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				if (!captured) captured = JSON.stringify(options.prompt);
				return {
					finishReason: "stop" as const,
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								toolName: "globex__create_invoice",
								argsJson: "{}",
								reasoning: null,
							}),
						},
					],
				};
			},
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await planKernelWriteProposal({
				db: DB,
				env: baseEnv(service),
				organizationId: "org-1",
				route: writeRoute(),
				content: "create an invoice",
				model,
			});
		} finally {
			warn.mockRestore();
		}
		const text = JSON.stringify(
			mocks.selectJevAction.mock.calls[0]?.[0].candidates,
		);
		expect(text.indexOf("globex__create_invoice(")).toBeLessThan(
			text.indexOf("globex__getContact("),
		);
		expect(text.indexOf("globex__create_invoice(")).toBeLessThan(
			text.indexOf("globex__listOrders("),
		);
	});

	it("discovers and plans an aggregate Code Mode callable", async () => {
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }, { name: "get_info" }] },
					},
				};
			}
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						structuredContent: {
							executionId: "exec-discovery",
							result: JSON.stringify([
								{
									callable: "work.create_work_items",
									description: "Create a provider-neutral work item",
									annotations: { readOnlyHint: false },
									parameters: {
										properties: {
											title: { type: "string" },
											description: { type: "string" },
										},
										required: ["title"],
									},
								},
							]),
						},
					},
				},
			};
		});
		mocks.getAppBySlugForOrg.mockImplementation(async (_db, slug: string) =>
			slug === "tedix-unified" ? { slug } : null,
		);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute({
				toolIntent: {
					appSlug: "tedix-unified",
					capability: "create_work_item",
					connectionStatus: "connected",
				},
			}),
			actingUserId: "user-123",
			content: "create the work item titled Release proof",
			model: objectModel({
				toolName: "work.create_work_items",
				argsJson: '{"title":"Release proof","description":"live check"}',
				reasoning: "create the requested work item",
			}),
		});

		expect(proposal).toEqual({
			appSlug: "tedix-unified",
			toolName: "work.create_work_items",
			args: { title: "Release proof", description: "live check" },
			reasoning: "create the requested work item",
			riskTier: "high",
			transport: "codemode",
		});
		expect(service.calls.map((call) => call.method)).toEqual([
			"tools/list",
			"tools/call",
			"tools/call",
		]);
		expect(service.calls[1]?.params).toMatchObject({
			name: "code",
			arguments: {
				code: expect.stringContaining('"query":"create work item"'),
			},
		});
		expect(
			(service.calls[1]?.params.arguments as { code?: string })?.code,
		).toContain("Object.fromEntries");
		expect(JSON.stringify(service.calls[2]?.params)).toContain(
			"discover.describe",
		);
	});

	it("pins catalog installs to the current gateway and real execution", async () => {
		mocks.selectJevAction.mockResolvedValue({
			toolName: null,
			reason: "uncertain",
		});
		const installTool = {
			callable: "tenant.install_tenant_mcp_apps",
			description: "Install multiple catalog apps into this tenant gateway",
			annotations: { readOnlyHint: false, destructiveHint: false },
			parameters: {
				type: "object",
				properties: {
					catalogAppQueries: { type: "array", items: { type: "string" } },
					targetAggregatorSlug: { type: "string" },
					dryRun: { type: "boolean" },
				},
				required: ["catalogAppQueries", "targetAggregatorSlug"],
			},
		};
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			}
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						structuredContent: {
							executionId: "exec-install",
							result: JSON.stringify([installTool]),
						},
					},
				},
			};
		});
		mocks.getAppBySlugForOrg.mockImplementation(async (_db, slug: string) =>
			slug === "acme-unified" ? { slug } : null,
		);

		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute({
				toolIntent: {
					appSlug: "acme-unified",
					capability: "catalog.install",
					connectionStatus: "connected",
				},
			}),
			content: "install Google Calendar and Outlook from the catalog",
			model: objectModel({
				toolName: "tenant.install_tenant_mcp_apps",
				argsJson:
					'{"catalogAppQueries":["Google Calendar","Outlook"],"targetAggregatorSlug":"wrong","dryRun":true}',
				reasoning: "install both requested apps",
			}),
		});

		expect(proposal).toMatchObject({
			appSlug: "acme-unified",
			toolName: "tenant.install_tenant_mcp_apps",
			args: {
				catalogAppQueries: ["Google Calendar", "Outlook"],
				targetAggregatorSlug: "acme-unified",
				dryRun: false,
			},
			transport: "codemode",
		});
		expect(mocks.selectJevAction).not.toHaveBeenCalled();
	});
});

describe("planKernelWriteProposal — validation (model never trusted)", () => {
	it("rejects a pick that is not in the write list (e.g. a read tool)", async () => {
		const service = mcpService(globexProvider);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({
				toolName: "globex__get_invoices",
				argsJson: "{}",
				reasoning: null,
			}),
		});
		expect(proposal).toBeNull();
	});

	it("rejects when a required param is missing after filtering", async () => {
		const service = mcpService(globexProvider);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({
				toolName: "globex__create_invoice",
				argsJson: '{"customerName":"ACME"}', // missing required `amount`
				reasoning: null,
			}),
		});
		expect(proposal).toBeNull();
	});

	it("rejects oversized serialized args", async () => {
		const service = mcpService(globexProvider);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({
				toolName: "globex__create_invoice",
				argsJson: JSON.stringify({
					amount: 100,
					customerName: "x".repeat(3000),
				}),
				reasoning: null,
			}),
		});
		expect(proposal).toBeNull();
	});
});

describe("planKernelWriteProposal — fail-soft gates", () => {
	it("returns null when the gate flag is off (and makes no MCP calls)", async () => {
		const service = mcpService(globexProvider);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service, { KERNEL_EXECUTE: undefined }),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({}),
		});
		expect(proposal).toBeNull();
		expect(service.calls).toHaveLength(0);
	});

	it("returns null without a model — writes have NO heuristic fallback", async () => {
		const service = mcpService(globexProvider);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: null,
		});
		expect(proposal).toBeNull();
		expect(service.calls).toHaveLength(0);
	});

	it("returns null for non-write routes, NONE picks, bad argsJson, model throw, no provider", async () => {
		const service = mcpService(globexProvider);
		const env = baseEnv(service);
		const base = {
			db: DB,
			env,
			organizationId: "org-1",
			content: "create an invoice",
		};

		expect(
			await planKernelWriteProposal({
				...base,
				route: writeRoute({ routeKind: "answer_in_home" }),
				model: objectModel({}),
			}),
		).toBeNull();

		expect(
			await planKernelWriteProposal({
				...base,
				route: writeRoute(),
				model: objectModel({
					toolName: "NONE",
					argsJson: "{}",
					reasoning: null,
				}),
			}),
		).toBeNull();

		expect(
			await planKernelWriteProposal({
				...base,
				route: writeRoute(),
				model: objectModel({
					toolName: "globex__create_invoice",
					argsJson: "not json",
					reasoning: null,
				}),
			}),
		).toBeNull();

		const throwing = new MockLanguageModelV3({
			doGenerate: async () => {
				throw new Error("Azure 500");
			},
		});
		expect(
			await planKernelWriteProposal({
				...base,
				route: writeRoute(),
				model: throwing,
			}),
		).toBeNull();

		mocks.getAppBySlugForOrg.mockResolvedValue(null);
		expect(
			await planKernelWriteProposal({
				...base,
				route: writeRoute(),
				model: objectModel({
					toolName: "globex__create_invoice",
					argsJson: '{"amount":1}',
					reasoning: null,
				}),
			}),
		).toBeNull();
	});

	it("returns null when the provider lists no write-capable tools", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								tools: [
									{
										name: "globex__get_invoices",
										annotations: { readOnlyHint: true },
									},
								],
							},
						},
					}
				: { json: { jsonrpc: "2.0", id: 1, error: { message: "no" } } },
		);
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({
				toolName: "globex__get_invoices",
				argsJson: "{}",
				reasoning: null,
			}),
		});
		expect(proposal).toBeNull();
	});
});

describe("planKernelWriteProposal — onDecline reporting (fail-soft is not fail-silent)", () => {
	it("reports the stage at each gate: disabled, missing model, NONE pick, validation", async () => {
		const service = mcpService(globexProvider);
		const declines: Array<{ stage: string; detail?: string }> = [];
		const onDecline = (d: { stage: string; detail?: string }) =>
			declines.push(d);

		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service, { KERNEL_EXECUTE: undefined }),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({}),
			onDecline,
		});
		expect(declines.at(-1)?.stage).toBe("disabled");

		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: null,
			onDecline,
		});
		expect(declines.at(-1)?.stage).toBe("missing_inputs");

		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({ toolName: "NONE", argsJson: "{}", reasoning: null }),
			onDecline,
		});
		expect(declines.at(-1)?.stage).toBe("planner_declined");

		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			// invented tool name -> not in the write list -> validation fails
			model: objectModel({
				toolName: "globex__not_a_real_tool",
				argsJson: "{}",
				reasoning: null,
			}),
			onDecline,
		});
		expect(declines.at(-1)?.stage).toBe("validation_failed");
	});

	it("reports no_provider when the routed app cannot be resolved", async () => {
		mocks.getAppBySlugForOrg.mockImplementation(async () => null);
		const service = mcpService(globexProvider);
		const declines: Array<{ stage: string }> = [];
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({}),
			onDecline: (d) => declines.push(d),
		});
		expect(proposal).toBeNull();
		expect(declines.at(-1)?.stage).toBe("no_provider");
	});

	it("does not call onDecline on a successful proposal", async () => {
		const service = mcpService(globexProvider);
		const declines: Array<{ stage: string }> = [];
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice for ACME",
			model: objectModel({
				toolName: "globex__create_invoice",
				argsJson: '{"amount":100,"customerName":"ACME"}',
				reasoning: "create the requested invoice",
			}),
			onDecline: (d) => declines.push(d),
		});
		expect(proposal?.toolName).toBe("globex__create_invoice");
		expect(declines).toHaveLength(0);
	});

	it("a stalled write pass settles to null at the flat bound (not a hang)", async () => {
		// The provider lists tools fine; the WRITE LLM pass then stalls (opens,
		// never yields, never closes). Without the flat-timeout guard the awaited
		// generateObject would wedge the turn forever.
		const service = mcpService(globexProvider);
		const stallModel = new MockLanguageModelV3({
			doGenerate: async ({ abortSignal }) => {
				await new Promise<never>((_resolve, reject) => {
					const onAbort = () =>
						reject(abortSignal?.reason ?? new Error("aborted"));
					if (abortSignal?.aborted) return onAbort();
					abortSignal?.addEventListener("abort", onAbort, { once: true });
				});
				throw new Error("unreachable");
			},
		});
		const declines: Array<{ stage: string; detail?: string }> = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		const guard = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error("stalled write pass did not settle (wedged)")),
				800,
			);
		});
		try {
			const proposal = await Promise.race([
				planKernelWriteProposal({
					db: DB,
					env: baseEnv(service),
					organizationId: "org-1",
					route: writeRoute(),
					content: "create an invoice",
					model: stallModel,
					onDecline: (d) => declines.push(d),
					timeoutMs: 60,
				}),
				guard,
			]);
			// Fail-soft: the stall is caught and reported as the error stage, never a
			// concrete (potentially wrong) write.
			expect(proposal).toBeNull();
			expect(declines.at(-1)?.stage).toBe("planner_declined");
		} finally {
			if (timer) clearTimeout(timer);
		}
	});

	it("reports 'error' stage via onDecline when the inner try/catch catches (no silent null)", async () => {
		// Simulate an MCP service fetch that throws AFTER the provider is resolved
		// (i.e. the outer try-catch in planKernelWriteProposal fires, not the inner
		// DB-catch in resolveProviderApp). This verifies the outer catch now calls
		// onDecline so turn-work.ts sees the error stage and shows the honest
		// "nothing was created or sent" message instead of the optimistic text.
		const sensitive = "Bearer sk-secret-from-provider";
		const throwingService = {
			fetch: async () => {
				throw new Error(sensitive, {
					cause: new TypeError("private SQL text"),
				});
			},
		};
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const declines: Array<{ stage: string; detail?: string }> = [];
		try {
			const proposal = await planKernelWriteProposal({
				db: DB,
				env: baseEnv(throwingService as ReturnType<typeof mcpService>),
				organizationId: "org-1",
				route: writeRoute(),
				content: "create an invoice",
				model: objectModel({
					toolName: "globex__create_invoice",
					argsJson: '{"amount":1}',
					reasoning: null,
				}),
				onDecline: (d) => declines.push(d),
			});
			expect(proposal).toBeNull();
			// The outer catch still reports the honest "nothing was created" stage.
			expect(declines.at(-1)).toEqual({
				stage: "error",
				detail: "Write proposal planning failed",
			});
			expect(warnings).toHaveBeenCalledWith("[kernel.writeProposal] threw", {
				exception: {
					type: "Error",
					cause: { type: "TypeError" },
				},
			});
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(sensitive);
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(
				"private SQL text",
			);
		} finally {
			warnings.mockRestore();
		}
	});

	it("redacts protocol and planner error text while declining without a proposal", async () => {
		const sensitive = "Bearer sk-secret-from-provider";
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const protocolService = mcpService(() => ({
				json: {
					jsonrpc: "2.0",
					id: 1,
					error: { code: -32603, message: sensitive },
				},
			}));
			const protocolResult = await planKernelWriteProposal({
				db: DB,
				env: baseEnv(protocolService),
				organizationId: "org-1",
				route: writeRoute(),
				content: "create an invoice",
				model: objectModel({}),
			});
			expect(protocolResult).toBeNull();
			expect(warnings).toHaveBeenCalledWith(
				"[kernel.writeProposal] mcp call error/parse",
				{ method: "tools/list", failureKind: "protocol_error" },
			);

			const failingModel = new MockLanguageModelV3({
				doGenerate: async () => {
					throw new Error(sensitive);
				},
			});
			const plannerResult = await planKernelWriteProposal({
				db: DB,
				env: baseEnv(mcpService(globexProvider)),
				organizationId: "org-1",
				route: writeRoute(),
				content: "create an invoice",
				model: failingModel,
			});
			expect(plannerResult).toBeNull();
			expect(warnings).toHaveBeenCalledWith(
				"[kernel.writeProposal] planWriteCall failed",
				expect.objectContaining({ exception: expect.any(Object) }),
			);
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(sensitive);
		} finally {
			warnings.mockRestore();
		}
	});
});

describe("exact output input schemas", () => {
	const inputSchema = z.toJSONSchema(
		z.object({
			kind: z.literal("document"),
			title: z.string(),
			content: OsOutputContentSchema,
		}),
	);
	it.each([
		["plain string", "not a document", false],
		[
			"invalid nested paragraph",
			{ kind: "document", blocks: [{ type: "paragraph", text: 42 }] },
			false,
		],
		[
			"document blocks",
			{
				kind: "document",
				blocks: [{ type: "paragraph", text: "Synthetic agenda" }],
			},
			true,
		],
	])("validates %s before approval", async (_label, content, accepted) => {
		const service = mcpService(() => ({
			json: {
				jsonrpc: "2.0",
				id: 1,
				result: {
					tools: [
						{
							name: "create_os_output",
							description: "Create a document",
							annotations: { readOnlyHint: false, destructiveHint: false },
							inputSchema,
						},
					],
				},
			},
		}));
		let prompts: string[] = [];
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				prompts.push(JSON.stringify(options.prompt));
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify({
								toolName: "create_os_output",
								argsJson: JSON.stringify({
									kind: "document",
									title: "Test",
									content,
								}),
								reasoning: null,
							}),
						},
					],
				};
			},
		});
		const result = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "Create a document with the synthetic agenda",
			model,
		});
		expect(Boolean(result)).toBe(accepted);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Input JSON Schema:");
		expect(prompts[0]).toContain("paragraph");
		expect(
			JSON.stringify(mocks.selectJevAction.mock.calls[0]?.[0].candidates),
		).not.toContain("Input JSON Schema:");
		if (accepted) expect(result?.args.content).toEqual(content);
	});
});

describe("Jev action selection failure boundary", () => {
	it.each(["none", "uncertain", "unavailable", "invalid_candidates"])(
		"declines %s without generative selection or arguments",
		async (reason) => {
			mocks.selectJevAction.mockResolvedValue({ toolName: null, reason });
			const model = objectModel({
				toolName: "globex__create_invoice",
				argsJson: '{"amount":1}',
				reasoning: null,
			});
			const generate = vi.spyOn(model, "doGenerate");
			const onDecline = vi.fn();
			const result = await planKernelWriteProposal({
				db: DB,
				env: baseEnv(mcpService(globexProvider)),
				organizationId: "org-1",
				route: writeRoute(),
				content: "create invoice",
				model,
				onDecline,
			});
			expect(result).toBeNull();
			expect(generate).not.toHaveBeenCalled();
			expect(onDecline).toHaveBeenCalledWith(
				expect.objectContaining({
					stage: "planner_declined",
					detail: expect.stringContaining(`actionSelection=${reason}`),
				}),
			);
		},
	);
});
