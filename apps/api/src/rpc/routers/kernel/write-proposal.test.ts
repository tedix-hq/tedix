import {
	canonicalWriteToolName,
	preferredToolForCapability,
	renameThisConversationArgs,
} from "./write-tool-intent";
import {
	classifyWriteRisk,
	declaredWriteCapability,
	DESTRUCTIVE_VERBS,
	isWriteCapable,
	WRITE_ONLY_VERBS,
} from "./write-tool-policy";
import {
	normalizeOsSheetCellAddress,
	readEditTargetOutput,
} from "./write-edit-target";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import * as z from "zod";
import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import type { DbClient } from "@tedix/db/client";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelRouteDecision } from "./route-schema";
import {
	clearWriteCatalogCacheForTests,
	kernelWriteEnabled,
	planKernelWriteProposal,
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
	getOsOutput: vi.fn(async () => undefined),
	getOsOutputRevision: vi.fn(async () => undefined),
	readOpenWorkRequests: vi.fn(async () => [] as unknown[]),
}));
vi.mock("./open-work-requests", async (importOriginal) => ({
	...(await importOriginal<typeof import("./open-work-requests")>()),
	readOpenWorkRequests: mocks.readOpenWorkRequests,
}));
vi.mock("@tedix/db/queries/os-workspaces/outputs", () => ({
	getOsOutput: mocks.getOsOutput,
	getOsOutputRevision: mocks.getOsOutputRevision,
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
	clearWriteCatalogCacheForTests();
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
				_meta: {
					"com.tedix/policy": {
						riskTier: "bounded_write",
						blastRadius: "single_resource",
					},
				},
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

	it("every write-only verb requires bounded operational metadata for low risk", () => {
		for (const verb of WRITE_ONLY_VERBS) {
			const name = `app__${verb}_record`;
			expect(isWriteCapable({ name })).toBe(true);
			expect(classifyWriteRisk({ name })).toBe("high");
			expect(
				classifyWriteRisk({
					name,
					_meta: {
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "single_resource",
						},
					},
					annotations: { destructiveHint: false },
				}),
			).toBe(verb === "send" || verb === "publish" ? "high" : "low");
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
	it("constructive verbs need bounded operational metadata and must be non-critical", () => {
		for (const name of [
			"create_invoice",
			"add_contact",
			"update_record",
			"insert_row",
		]) {
			expect(classifyWriteRisk({ name })).toBe("high");
			expect(
				classifyWriteRisk({
					name,
					_meta: {
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "single_resource",
						},
					},
					annotations: { destructiveHint: false },
				}),
			).toBe(name === "create_invoice" ? "high" : "low");
		}
	});
	it("requires human approval for sending despite a safe provider annotation", () => {
		expect(
			classifyWriteRisk({
				name: "gmail__send_message",
				annotations: { destructiveHint: false },
			}),
		).toBe("high");
	});
});

describe("classifyWriteRisk fail-closed boundary", () => {
	it("returns low only for explicitly safe non-critical writes", () => {
		expect(
			classifyWriteRisk({
				name: "create_note",
				_meta: {
					"com.tedix/policy": {
						riskTier: "bounded_write",
						blastRadius: "single_resource",
					},
				},
				annotations: { destructiveHint: false },
			}),
		).toBe("low");
		for (const tool of [
			{ name: "create_invoice" },
			{ name: "create_invoice", annotations: { destructiveHint: false } },
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

describe("preferredToolForCapability", () => {
	const tools = [
		{ name: "google_drive_tedix.create_file" },
		{ name: "os.create_os_output" },
	];
	it("makes a doc, sheet or deck a Tedix output unless a provider is named", () => {
		for (const capability of [
			"sheets.create",
			"documents.create",
			"slides.create",
		]) {
			expect(
				preferredToolForCapability(tools, capability, "create a sheet of costs")
					?.name,
			).toBe("os.create_os_output");
		}
		expect(
			preferredToolForCapability(tools, "sheets.create", "make a Google Sheet"),
		).toBeNull();
		expect(
			preferredToolForCapability(tools, "files.create", "a sheet"),
		).toBeNull();
	});

	it("reads a generic content.create for a named deck as a Tedix output", () => {
		expect(
			preferredToolForCapability(
				tools,
				"content.create",
				"Yes, create it as a presentation output in this workspace.",
			)?.name,
		).toBe("os.create_os_output");
		expect(
			preferredToolForCapability(tools, "content.create", "post a reply"),
		).toBeNull();
		expect(
			preferredToolForCapability(
				tools,
				"content.create",
				"create a deck in Google Slides",
			),
		).toBeNull();
	});
});

describe("canonicalWriteToolName", () => {
	it("maps a conversation rename to the rename primitive in any namespace", () => {
		expect(
			canonicalWriteToolName(
				"conversations.update",
				"Rename this conversation to Q3 plan",
			),
		).toBe("rename_conversation");
		expect(
			canonicalWriteToolName("conversations.update", "Pin this conversation"),
		).toBeNull();
		expect(canonicalWriteToolName("work_items.create")).toBe(
			"work.create_work_items",
		);
		// From a workspace the route can name the output instead.
		expect(
			canonicalWriteToolName(
				"os.update_os_output",
				"Rename this chat to Q3 plan",
			),
		).toBe("rename_conversation");
	});

	it("reads the current conversation and title from a plain rename", () => {
		expect(
			renameThisConversationArgs(
				"Rename this conversation to “Q3 plan”.",
				"home:os:abc",
			),
		).toEqual({ conversationId: "home:os:abc", title: "Q3 plan" });
		expect(
			renameThisConversationArgs("Rename the doc to Q3 plan", "home:os:abc"),
		).toBeNull();
		// The CLI appends local terminal context after the request.
		expect(
			renameThisConversationArgs(
				"Rename this conversation to Q3 plan\n\nLocal terminal context:\n- cwd: /tmp",
				"Q3 thread",
			),
		).toEqual({ conversationId: "Q3 thread", title: "Q3 plan" });
		expect(
			renameThisConversationArgs("Rename this chat to Q3", undefined),
		).toBeNull();
	});
});

describe("planKernelWriteProposal — canonical Code Mode primitive", () => {
	function renameService() {
		return mcpService((body) => {
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
							executionId: "exec-describe",
							result: JSON.stringify([
								{
									callable: "kernel.rename_conversation",
									description: "Rename a Home conversation (chat)",
									annotations: {
										readOnlyHint: false,
										destructiveHint: false,
									},
									parameters: {
										type: "object",
										properties: {
											conversationId: { type: "string" },
											title: { type: "string" },
										},
										required: ["conversationId", "title"],
									},
								},
							]),
						},
					},
				},
			};
		});
	}
	const renameArgs = () => ({
		db: DB,
		organizationId: "org-1",
		route: writeRoute({
			toolIntent: {
				appSlug: "tedix-unified",
				capability: "conversations.update",
				connectionStatus: "connected",
			},
		}),
		actingUserId: "user-123",
		content: "Rename this conversation to Q3 plan",
		gatewayContext: { organizationId: "org-1", sessionKey: "home:os:abc" },
		model: objectModel({
			toolName: "kernel.rename_conversation",
			args: { conversationId: "home:os:abc", title: "Q3 plan" },
			reasoning: "rename the current conversation",
		}),
	});

	it("resolves and describes a rename in one call, with no selection pass", async () => {
		const service = renameService();
		mocks.getAppBySlugForOrg.mockImplementation(async (_db, slug: string) =>
			slug === "tedix-unified" ? { slug } : null,
		);
		const stages: string[] = [];
		const proposal = await planKernelWriteProposal({
			...renameArgs(),
			env: baseEnv(service),
			onStage: (stage) => stages.push(stage),
		});
		expect(proposal).toMatchObject({
			toolName: "kernel.rename_conversation",
			args: { conversationId: "home:os:abc", title: "Q3 plan" },
			transport: "codemode",
		});
		expect(mocks.selectJevAction).not.toHaveBeenCalled();
		expect(service.calls.map((call) => call.method).sort()).toEqual([
			"tools/call",
		]);
		const code = (
			service.calls.find((call) => call.method === "tools/call")?.params
				.arguments as { code?: string }
		)?.code;
		expect(code).toContain('"query":"rename_conversation"');
		expect(code).toContain('".rename_conversation"');
		expect(stages).toEqual([
			"writeCatalogReady",
			"writeToolSelected",
			"writeSchemaReady",
			"writeArgumentsReady",
		]);
	});

	it("reuses the proven schema without listing on the next write turn", async () => {
		const service = renameService();
		mocks.getAppBySlugForOrg.mockImplementation(async (_db, slug: string) =>
			slug === "tedix-unified" ? { slug } : null,
		);
		await planKernelWriteProposal({ ...renameArgs(), env: baseEnv(service) });
		const second = await planKernelWriteProposal({
			...renameArgs(),
			env: baseEnv(service),
		});
		expect(second?.toolName).toBe("kernel.rename_conversation");
		expect(service.calls).toHaveLength(1);
	});
});

describe("planKernelWriteProposal — schema prefetch", () => {
	it("describes the leading candidates during selection, once each", async () => {
		const entry = (name: string) => ({
			callable: name,
			description: `Edit via ${name}`,
			annotations: { readOnlyHint: false, destructiveHint: false },
			parameters: {
				type: "object",
				properties: { outputId: { type: "string" } },
				required: ["outputId"],
			},
		});
		const names = [
			"os.patch_os_document",
			"os.revise_os_output",
			"os.rename_os_output",
			"os.set_os_sheet_range",
		];
		const service = mcpService((body) => {
			if (body.method === "tools/list")
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			const code = String(
				(body.params.arguments as { code?: string } | undefined)?.code,
			);
			const described = names.find((name) =>
				code.includes(`discover.describe({ callable: "${name}" })`),
			);
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						structuredContent: {
							executionId: "exec",
							result: JSON.stringify(
								described ? [entry(described)] : names.map(entry),
							),
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
					capability: "documents.update",
					connectionStatus: "connected",
				},
			}),
			content: "Append a paragraph to the plan",
			model: objectModel({
				toolName: "os.patch_os_document",
				args: { outputId: "o1" },
				reasoning: "append",
			}),
		});
		expect(proposal?.toolName).toBe("os.patch_os_document");
		const describedCalls = service.calls.filter((call) =>
			String(
				(call.params.arguments as { code?: string } | undefined)?.code,
			).includes("discover.describe"),
		);
		// Three prefetched, and the pick reuses its prefetch.
		expect(describedCalls).toHaveLength(3);
	});
});

describe("planKernelWriteProposal — editing a selected Tedix output", () => {
	it("searches for the output's edit tools, not the request's words", async () => {
		const OUTPUT_ID = "00000000-0000-4000-8000-0000000000a1";
		mocks.getOsOutput.mockResolvedValueOnce({
			id: OUTPUT_ID,
			kind: "document",
			title: "Plan",
			status: "active",
			currentRevisionId: "rev-1",
		} as never);
		mocks.getOsOutputRevision.mockResolvedValueOnce({
			id: "rev-1",
			outputId: OUTPUT_ID,
			revision: 1,
			content: '{"kind":"document","blocks":[]}',
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
		} as never);
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: { tools: [{ name: "code" }] },
						},
					}
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: { executionId: "e", result: "[]" },
							},
						},
					},
		);
		mocks.getAppBySlugForOrg.mockImplementation(async (_db, slug: string) =>
			slug === "tedix-unified" ? { slug } : null,
		);
		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute({
				toolIntent: {
					appSlug: "tedix-unified",
					capability: null,
					connectionStatus: "connected",
				},
			}),
			workspaceContext: {
				workspaceId: "ws-1",
				workspaceName: "Scratch",
				workpiece: { kind: "output", id: OUTPUT_ID, name: "Plan" },
			} as never,
			content: "Append a paragraph Fourth line. to this document",
			model: objectModel({ toolName: "NONE", args: null, reasoning: null }),
		});
		const search = service.calls.find((call) =>
			String(
				(call.params.arguments as { code?: string } | undefined)?.code,
			).includes("discover.search"),
		);
		expect(
			(search?.params.arguments as { code?: string } | undefined)?.code,
		).toContain('"query":"os output document edit"');
	});
});

describe("planKernelWriteProposal — answering a Work request by title", () => {
	it("gives the argument pass the operator's open requests with ids and versions", async () => {
		mocks.readOpenWorkRequests.mockResolvedValueOnce([
			{
				requestId: "req-1",
				version: 2,
				kind: "handoff",
				subject: "Onboarding proposal: Q3 plan",
				workItemTitle: "Q3 plan",
			},
		]);
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: { tools: [{ name: "code" }] },
						},
					}
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: {
									executionId: "e",
									result: JSON.stringify([
										{
											callable: "work.respond_work_interaction",
											description: "Respond to a Work interaction",
											annotations: {
												readOnlyHint: false,
												destructiveHint: false,
											},
											parameters: {
												type: "object",
												properties: {
													requestId: { type: "string" },
													expectedRequestVersion: { type: "integer" },
													responseKind: { type: "string" },
												},
												required: [
													"requestId",
													"expectedRequestVersion",
													"responseKind",
												],
											},
										},
									]),
								},
							},
						},
					},
		);
		mocks.getAppBySlugForOrg.mockImplementation(async (_db, slug: string) =>
			slug === "tedix-unified" ? { slug } : null,
		);
		const model = objectModel({
			toolName: "work.respond_work_interaction",
			args: {
				requestId: "req-1",
				expectedRequestVersion: 2,
				responseKind: "handoff_accepted",
			},
			reasoning: "accept",
		});
		const generate = vi.spyOn(model, "doGenerate");
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute({
				toolIntent: {
					appSlug: "tedix-unified",
					capability: null,
					connectionStatus: "connected",
				},
			}),
			actingUserId: "user-123",
			content: "Accept the onboarding proposal 'Q3 plan'",
			model,
		});
		expect(proposal?.toolName).toBe("work.respond_work_interaction");
		expect(mocks.selectJevAction).not.toHaveBeenCalled();
		const prompt = JSON.stringify(generate.mock.calls[0]?.[0].prompt);
		expect(prompt).toContain("<open_work_requests>");
		expect(prompt).toContain("requestId=req-1 version=2");
	});
});

describe("readEditTargetOutput", () => {
	const OUTPUT_ID = "00000000-0000-4000-8000-0000000000a1";
	const output = {
		id: OUTPUT_ID,
		kind: "document",
		title: "Plan",
		status: "active",
		currentRevisionId: "rev-1",
	};
	const revision = (sources: unknown[]) => ({
		id: "rev-1",
		outputId: OUTPUT_ID,
		revision: 3,
		content:
			'{"kind":"document","blocks":[{"type":"paragraph","text":"First draft."}]}',
		accessEnvelope: JSON.stringify({ version: 1, sources }),
	});
	it("returns the current body of the output the request names", async () => {
		mocks.getOsOutput.mockResolvedValueOnce(output as never);
		mocks.getOsOutputRevision.mockResolvedValueOnce(revision([]) as never);
		const target = await readEditTargetOutput({
			db: DB,
			organizationId: "org-1",
			viewer: { userIds: [] },
			texts: [`append a paragraph to ${OUTPUT_ID}`],
		});
		expect(JSON.parse(target ?? "null")).toMatchObject({
			outputId: OUTPUT_ID,
			kind: "document",
			revision: 3,
			content: expect.stringContaining("First draft."),
		});
	});
	it("prefers the selected output, deduplicates ids, and excludes the workspace id", async () => {
		mocks.getOsOutput.mockClear();
		mocks.getOsOutput.mockResolvedValueOnce(output as never);
		mocks.getOsOutputRevision.mockResolvedValueOnce(revision([]) as never);
		const workspaceId = "00000000-0000-4000-8000-0000000000b1";
		const target = await readEditTargetOutput({
			db: DB,
			organizationId: "org-1",
			viewer: { userIds: [] },
			workspaceContext: {
				workspaceId,
				workspaceName: "Plans",
				workpiece: { kind: "output", id: OUTPUT_ID },
			} as never,
			texts: [workspaceId, OUTPUT_ID.toUpperCase()],
		});
		expect(JSON.parse(target!)).toMatchObject({ outputId: OUTPUT_ID });
		expect(mocks.getOsOutput).toHaveBeenCalledExactlyOnceWith(DB, {
			organizationId: "org-1",
			outputId: OUTPUT_ID,
		});
	});
	it("skips a revision belonging to another output and caps the returned body", async () => {
		const otherId = "00000000-0000-4000-8000-0000000000b2";
		mocks.getOsOutput
			.mockResolvedValueOnce(output as never)
			.mockResolvedValueOnce({ ...output, id: otherId } as never);
		mocks.getOsOutputRevision
			.mockResolvedValueOnce({
				...revision([]),
				outputId: "different",
			} as never)
			.mockResolvedValueOnce({
				...revision([]),
				outputId: otherId,
				content: "x".repeat(12001),
			} as never);
		const target = JSON.parse(
			(await readEditTargetOutput({
				db: DB,
				organizationId: "org-1",
				viewer: { userIds: [] },
				texts: [OUTPUT_ID, otherId],
			}))!,
		);
		expect(target).toMatchObject({ outputId: otherId, truncated: true });
		expect(target.content).toHaveLength(12000);
	});
	it("never reads a protected revision", async () => {
		mocks.getOsOutput.mockResolvedValueOnce(output as never);
		mocks.getOsOutputRevision.mockResolvedValueOnce(
			revision([{ kind: "resource" }]) as never,
		);
		expect(
			await readEditTargetOutput({
				db: DB,
				organizationId: "org-1",
				viewer: { userIds: [] },
				texts: [OUTPUT_ID],
			}),
		).toBeNull();
	});
});

describe("planKernelWriteProposal — positive path", () => {
	it("retries invalid argument JSON once without executing a provider write", async () => {
		const service = mcpService(globexProvider);
		const model = objectModel({
			toolName: "globex__create_invoice",
			args: { amount: 12 },
			reasoning: null,
		});
		const generate = vi
			.spyOn(model, "doGenerate")
			.mockImplementationOnce(async () => ({
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
				content: [{ type: "text", text: "invalid json" }],
			}));
		const result = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "Create a draft invoice for 12",
			model,
		});
		expect(result?.args).toEqual({ amount: 12 });
		expect(generate).toHaveBeenCalledTimes(2);
		expect(
			service.calls.filter((call) => call.method === "tools/call"),
		).toHaveLength(0);
	});
	it("repairs schema-invalid tool arguments once, before any write executes", async () => {
		const service = mcpService(globexProvider);
		const model = objectModel({
			toolName: "globex__create_invoice",
			args: { amount: 12 },
			reasoning: null,
		});
		const generate = vi
			.spyOn(model, "doGenerate")
			.mockImplementationOnce(async () => ({
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
				content: [
					{
						type: "text",
						text: JSON.stringify({
							toolName: "globex__create_invoice",
							args: { amount: "12" },
						}),
					},
				],
			}));
		const result = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "Create a draft invoice for 12",
			model,
		});
		expect(result?.args).toEqual({ amount: 12 });
		expect(generate).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(generate.mock.calls[1]?.[0].prompt)).toContain(
			"amount",
		);
		expect(JSON.stringify(generate.mock.calls[1]?.[0].prompt)).toContain(
			"previous plan failed",
		);
		expect(
			service.calls.filter((call) => call.method === "tools/call"),
		).toHaveLength(0);
	});

	it("stops after one failed input repair without proposing a write", async () => {
		const service = mcpService(globexProvider);
		const model = objectModel({
			toolName: "globex__create_invoice",
			args: { amount: "12" },
		});
		const result = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "Create a draft invoice for 12",
			model,
		});
		expect(result).toBeNull();
		expect(model.doGenerateCalls).toHaveLength(2);
		expect(
			service.calls.filter((call) => call.method === "tools/call"),
		).toHaveLength(0);
	});

	it.each([true, false])(
		"uses the canonical title only for the matching edit target (%s)",
		async (matches) => {
			const outputId = "11111111-1111-4111-8111-111111111111";
			mocks.getOsOutput.mockResolvedValueOnce({
				id: outputId,
				kind: "document",
				title: "Project plan",
				status: "active",
				currentRevisionId: "rev-1",
			} as never);
			mocks.getOsOutputRevision.mockResolvedValueOnce({
				id: "rev-1",
				outputId,
				revision: 1,
				content: '{"kind":"document","blocks":[]}',
				accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			} as never);
			const toolName = "os.patch_os_document";
			const proposal = await planKernelWriteProposal({
				db: DB,
				env: baseEnv(
					mcpService(() => ({
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								tools: [
									{
										name: toolName,
										annotations: { readOnlyHint: false },
										inputSchema: {
											type: "object",
											properties: { outputId: { type: "string" } },
											required: ["outputId"],
										},
									},
								],
							},
						},
					})),
				),
				organizationId: "org-1",
				route: writeRoute(),
				content: `update ${outputId}`,
				model: objectModel({
					toolName,
					args: {
						outputId: matches
							? outputId
							: "22222222-2222-4222-8222-222222222222",
					},
					reasoning: null,
				}),
			});
			expect(proposal).not.toBeNull();
			expect(proposal?.outputTitle).toBe(matches ? "Project plan" : undefined);
		},
	);

	it("carries workspace context through the remaining argument generation pass without injecting provider arguments", async () => {
		const model = objectModel({
			toolName: "globex__create_invoice",
			args: { amount: 100 },
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

	it("tells the argument pass which conversation is 'this conversation'", async () => {
		const model = objectModel({
			toolName: "globex__create_invoice",
			args: { amount: 1 },
			reasoning: null,
		});
		const generate = vi.spyOn(model, "doGenerate");
		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(globexProvider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "rename this conversation",
			gatewayContext: { organizationId: "org-1", sessionKey: "home:os:abc" },
			model,
		});
		expect(JSON.stringify(generate.mock.calls[0]?.[0].prompt)).toContain(
			'CURRENT HOME CONVERSATION: conversationId=\\"home:os:abc\\"',
		);
	});

	it("keeps a tool schema's $defs resolvable when it nests under args", async () => {
		const defs = { __schema0: { type: "string", maxLength: 20 } };
		const provider = (body: { method: string }) =>
			body.method === "tools/list"
				? {
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
												customerName: { $ref: "#/$defs/__schema0" },
											},
											required: ["amount"],
											$defs: defs,
										},
									},
								],
							},
						},
					}
				: globexProvider(body);
		const model = objectModel({
			toolName: "globex__create_invoice",
			args: { amount: 100 },
			reasoning: null,
		});
		const generate = vi.spyOn(model, "doGenerate");
		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(provider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model,
		});
		const format = generate.mock.calls.at(-1)?.[0].responseFormat as {
			schema?: {
				$defs?: unknown;
				properties?: { args?: { anyOf?: Array<Record<string, unknown>> } };
			};
		};
		expect(format.schema?.$defs).toEqual(defs);
		expect(format.schema?.properties?.args?.anyOf?.[0]).not.toHaveProperty(
			"$defs",
		);
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
				args: { amount: 100, customerName: "ACME", notAParam: "x" },
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
			// The approver may change the tool's scalar inputs before approving.
			editableFields: [
				{
					name: "amount",
					label: "Amount",
					required: true,
					schema: { type: "number" },
				},
				{
					name: "customerName",
					label: "Customer name",
					required: false,
					schema: { type: "string" },
				},
			],
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
								args: { amount: 1 },
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
								args: {},
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

	it("preserves a long Work brief in an aggregate proposal without executing it", async () => {
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
		const description =
			"Create a demo, source files and playback notes. ".repeat(60);
		const model = objectModel({
			toolName: "work.create_work_items",
			args: { title: "Release proof", description },
			reasoning: "create the requested work item",
		});
		const generate = vi.spyOn(model, "doGenerate");
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute({
				toolIntent: {
					appSlug: "tedix-unified",
					capability: "work_items.create",
					connectionStatus: "connected",
				},
			}),
			actingUserId: "user-123",
			content: `create the work item titled Release proof. Description: ${description}`,
			model,
		});
		expect(mocks.selectJevAction).not.toHaveBeenCalled();

		expect(proposal).toEqual({
			appSlug: "tedix-unified",
			toolName: "work.create_work_items",
			args: { title: "Release proof", description },
			reasoning: "create the requested work item",
			riskTier: "high",
			transport: "codemode",
			editableFields: [
				{
					name: "title",
					label: "Title",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "description",
					label: "Description",
					required: false,
					schema: { type: "string" },
				},
			],
		});
		// work_items.create has one canonical primitive: no catalog search, one
		// Code Mode call that describes it directly.
		expect(service.calls.map((call) => call.method).sort()).toEqual([
			"tools/call",
		]);
		const canonicalCode = (
			service.calls.find((call) => call.method === "tools/call")?.params
				.arguments as { code?: string }
		)?.code;
		expect(canonicalCode).toContain("discover.describe");
		expect(canonicalCode).toContain('"work.create_work_items"');
		expect(canonicalCode).not.toContain("discover.search");
		expect(JSON.stringify(generate.mock.calls[0]?.[0].prompt)).toContain(
			"Creating the record does not execute or delegate the work it describes.",
		);
		expect(generate.mock.calls[0]?.[0].providerOptions).toMatchObject({
			cloudflareAutoRouter: { strictJsonSchema: false, reasoningEffort: "low" },
		});
		expect(generate.mock.calls[0]?.[0].maxOutputTokens).toBe(8192);
		expect(generate.mock.calls[0]?.[0].responseFormat).toMatchObject({
			type: "json",
			schema: {
				properties: {
					args: {
						anyOf: expect.arrayContaining([
							{
								type: "object",
								properties: {
									title: { type: "string" },
									description: { type: "string" },
								},
								required: ["title"],
							},
						]),
					},
				},
			},
		});
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
				args: {
					catalogAppQueries: ["Google Calendar", "Outlook"],
					targetAggregatorSlug: "wrong",
					dryRun: true,
				},
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
				args: {},
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
				args: { customerName: "ACME" }, // missing required `amount`
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
				args: {
					amount: 100,
					customerName: "x".repeat(20_000),
				},
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

	it("returns null for non-write routes, NONE picks, bad args, model throw, no provider", async () => {
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
					args: {},
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
					args: "not json",
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
					args: { amount: 1 },
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
				args: {},
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
			model: objectModel({ toolName: "NONE", args: {}, reasoning: null }),
			onDecline,
		});
		expect(declines.at(-1)?.stage).toBe("planner_declined");
		expect(declines.at(-1)?.detail).toBe(
			"Argument planner declined the selected tool",
		);

		await planKernelWriteProposal({
			db: DB,
			env: baseEnv(service),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			// invented tool name -> not in the write list -> validation fails
			model: objectModel({
				toolName: "globex__not_a_real_tool",
				args: {},
				reasoning: null,
			}),
			onDecline,
		});
		expect(declines.at(-1)?.stage).toBe("validation_failed");
	});

	it.each([
		["not json", "Argument planner did not return an object"],
		[[], "Argument planner did not return an object"],
	])("records a bounded diagnostic for %s arguments", async (args, detail) => {
		const onDecline = vi.fn();
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(globexProvider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: objectModel({
				toolName: "globex__create_invoice",
				args,
				reasoning: null,
			}),
			onDecline,
		});
		expect(proposal).toBeNull();
		expect(onDecline).toHaveBeenCalledWith({
			stage: "planner_declined",
			detail,
		});
	});

	it("identifies reasoning-only output-budget exhaustion without retaining reasoning text", async () => {
		const onDecline = vi.fn();
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(globexProvider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create an invoice",
			model: new MockLanguageModelV3({
				doGenerate: async () => ({
					finishReason: { unified: "length", raw: "length" },
					usage: { inputTokens: 100, outputTokens: 3000, totalTokens: 3100 },
					warnings: [],
					content: [{ type: "reasoning", text: "private model reasoning" }],
				}),
			}),
			onDecline,
		});
		expect(proposal).toBeNull();
		expect(onDecline).toHaveBeenCalledWith({
			stage: "planner_declined",
			detail: "Argument generation exhausted its output budget",
		});
		expect(JSON.stringify(onDecline.mock.calls)).not.toContain(
			"private model reasoning",
		);
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

	it("accepts an omitted rationale without retrying a valid write plan", async () => {
		const model = objectModel({
			toolName: "globex__create_invoice",
			args: { amount: 100, customerName: "Example" },
		});
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(globexProvider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create a draft invoice",
			model,
		});
		expect(proposal).toMatchObject({
			toolName: "globex__create_invoice",
			reasoning: null,
			args: { amount: 100, customerName: "Example" },
		});
		expect(model.doGenerateCalls).toHaveLength(1);
	});

	it("still rejects invalid required tool arguments when the rationale is omitted", async () => {
		const proposal = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(globexProvider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create a draft invoice",
			model: objectModel({
				toolName: "globex__create_invoice",
				args: { customerName: "Example" },
			}),
		});
		expect(proposal).toBeNull();
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
				args: { amount: 100, customerName: "ACME" },
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
					args: { amount: 1 },
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
	it.each(["document", "sheet"])(
		"validates a body-only draft against the full %s tool schema",
		async (kind) => {
			const service = mcpService(() => ({
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						tools: [
							{
								name: "os.create_os_output",
								annotations: { readOnlyHint: false, destructiveHint: false },
								inputSchema: z.toJSONSchema(
									z.object({
										kind: z.literal(kind),
										title: z.string(),
										content: OsOutputContentSchema,
									}),
								),
							},
						],
					},
				},
			}));
			const blocks = [{ type: "paragraph", text: "Welcome to the shop." }];
			const result = await planKernelWriteProposal({
				db: DB,
				env: baseEnv(service),
				organizationId: "org-1",
				route: writeRoute({
					toolIntent: {
						appSlug: "globex",
						capability: "documents.create",
						connectionStatus: "connected",
					},
				}),
				content: 'Create a document titled "Welcome" welcoming visitors.',
				model: objectModel({ blocks }),
			});
			expect(Boolean(result)).toBe(kind === "document");
			if (result)
				expect(result.args).toEqual({
					kind: "document",
					title: "Welcome",
					content: { kind: "document", blocks },
				});
			expect(
				service.calls.every(
					(call) => call.method !== "tools/call" || call.params.name === "code",
				),
			).toBe(true);
		},
	);

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
		const responseFormats: string[] = [];
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				prompts.push(JSON.stringify(options.prompt));
				responseFormats.push(JSON.stringify(options.responseFormat));
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify({
								toolName: "create_os_output",
								args: {
									kind: "document",
									title: "Test",
									content,
								},
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
		expect(prompts).toHaveLength(accepted ? 1 : 2);
		if (!accepted) expect(prompts[1]).toContain("previous plan failed");
		expect(prompts[0]).not.toContain("Input JSON Schema:");
		expect(responseFormats[0]).toContain("paragraph");
		expect(responseFormats[0]).toContain("$defs");
		expect(prompts[0].indexOf("<tool_catalog>")).toBeLessThan(
			prompts[0].indexOf("<operator_request>"),
		);
		expect(
			JSON.stringify(mocks.selectJevAction.mock.calls[0]?.[0].candidates),
		).not.toContain("Input JSON Schema:");
		if (accepted) expect(result?.args.content).toEqual(content);
	});
});

describe("Jev action selection failure boundary", () => {
	it.each(["invalid_candidates"])(
		"declines %s without generative selection or arguments",
		async (reason) => {
			mocks.selectJevAction.mockResolvedValue({ toolName: null, reason });
			const model = objectModel({
				toolName: "globex__create_invoice",
				args: { amount: 1 },
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

	it.each(["none", "uncertain", "unavailable"])(
		"lets the write planner pick from the same catalog when Jev answers %s",
		async (reason) => {
			mocks.selectJevAction.mockResolvedValue({ toolName: null, reason });
			const model = objectModel({
				toolName: "globex__create_invoice",
				args: { amount: 1 },
				reasoning: null,
			});
			const generate = vi.spyOn(model, "doGenerate");
			const result = await planKernelWriteProposal({
				db: DB,
				env: baseEnv(mcpService(globexProvider)),
				organizationId: "org-1",
				route: writeRoute(),
				content: "create an invoice for 1",
				model,
			});
			expect(result).toMatchObject({
				toolName: "globex__create_invoice",
				args: { amount: 1 },
			});
			// One selection pass over the catalog, one argument pass on the exact tool.
			expect(generate).toHaveBeenCalledTimes(2);
			expect(generate.mock.calls[0]?.[0].responseFormat).toMatchObject({
				type: "json",
				schema: {
					properties: {
						args: {
							anyOf: [
								{ type: "object", properties: {}, additionalProperties: false },
								{ type: "null" },
							],
						},
					},
				},
			});
		},
	);

	it("still declines an uncertain request the write planner also rejects", async () => {
		mocks.selectJevAction.mockResolvedValue({
			toolName: null,
			reason: "uncertain",
		});
		const onDecline = vi.fn();
		const result = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(mcpService(globexProvider)),
			organizationId: "org-1",
			route: writeRoute(),
			content: "create invoice",
			model: objectModel({
				toolName: "globex__get_invoices",
				args: {},
				reasoning: null,
			}),
			onDecline,
		});
		expect(result).toBeNull();
		expect(onDecline).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "planner_declined",
				detail: expect.stringContaining("actionSelection=uncertain"),
			}),
		);
	});
});

describe("factory creation preview", () => {
	it.each([true, false])(
		"requires a successful dry run before approval (preview=%s)",
		async (valid) => {
			const service = mcpService((body) => {
				if (body.method === "tools/list")
					return {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: { tools: [{ name: "code" }] },
						},
					};
				const code = (body.params.arguments as { code: string }).code;
				const data = code.includes("discover.describe")
					? [
							{
								callable: "projects.create_factory",
								description: "Preview then create a factory",
								annotations: { readOnlyHint: false },
								parameters: {
									type: "object",
									properties: {
										goal: { type: "string" },
										slug: { type: "string" },
										dryRun: { type: "boolean" },
									},
									required: ["goal"],
								},
							},
						]
					: valid
						? {
								dryRun: true,
								ownerTediName: "Sample operator",
								projectKey: "SAMPLE-COMMENTS",
								output: {
									id: null,
									title: "Sample daily review",
									kind: "document",
								},
								completionEvidence: { status: "partial" },
								cron: "17 8 * * *",
								warnings: ["Check the selected output"],
							}
						: { error: "preview rejected" };
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: {
							structuredContent: {
								executionId: "sample-exec",
								result: JSON.stringify(data),
							},
						},
					},
				};
			});
			mocks.getAppBySlugForOrg.mockResolvedValue({ slug: "sample-tools" });
			const proposal = await planKernelWriteProposal({
				db: DB,
				organizationId: "org-1",
				env: baseEnv(service),
				route: writeRoute({
					toolIntent: {
						appSlug: "sample-tools",
						capability: "factories.create",
						connectionStatus: "connected",
					},
				}),
				content: "Create a daily factory",
				model: objectModel({
					toolName: "projects.create_factory",
					args: {
						goal: "Summarise project comments",
						slug: "sample-comments",
						dryRun: true,
					},
					reasoning: "Create daily report",
				}),
			});
			const executionCalls = service.calls.filter(
				(c) =>
					c.method === "tools/call" &&
					!(c.params.arguments as { code: string }).code.includes("discover."),
			);
			expect(executionCalls).toHaveLength(1);
			expect(
				(executionCalls[0]!.params.arguments as { code: string }).code,
			).toContain('"dryRun":true');
			if (valid) {
				expect(proposal?.args.dryRun).toBe(false);
				expect(proposal?.riskTier).toBe("high");
				expect(proposal?.reasoning).toContain("Check the selected output");
				expect(proposal?.reasoning).toContain("Sample daily review (document)");
				expect(proposal?.reasoning).not.toContain("completionEvidence");
				expect(proposal?.reasoning).not.toContain("Create daily report");
			} else expect(proposal).toBeNull();
		},
	);
});

describe("Tedix single-cell A1 coordinates", () => {
	const args = {
		outputId: "abcdef00-ab12-4011-8111-000000000001",
		startRow: 2,
		startColumn: 2,
		cells: [[15]],
		expectedRevision: 4,
	};
	it.each([
		["A1", 0, 0],
		["B2", 1, 1],
		["AA10", 9, 26],
	] as const)("%s converts once before validation", (cell, row, column) => {
		const normalized = normalizeOsSheetCellAddress(
			`Update cell ${cell} to 15 in sheet ${args.outputId}, titled "Q3 budget". Preserve all other cells and the title.`,
			"os.set_os_sheet_range",
			args,
		);
		expect(normalized).toEqual({ ...args, startRow: row, startColumn: column });
		expect(args.startRow).toBe(2);
	});
	it.each([
		"Update cell B2 to 15 and cell C3 to 20",
		"Update range B2:C3 to 15",
		"Do not update cell B2 to 15",
	])("%s leaves model arguments intact", (content) => {
		expect(
			normalizeOsSheetCellAddress(content, "os.set_os_sheet_range", args),
		).toBe(args);
	});
	it("preserves multi-cell and external-provider semantics", () => {
		const range = { ...args, cells: [[1, 2]] };
		expect(
			normalizeOsSheetCellAddress(
				"Set cell B2 to 15",
				"os.set_os_sheet_range",
				range,
			),
		).toBe(range);
		expect(
			normalizeOsSheetCellAddress("Set cell B2 to 15", "excel.set_range", args),
		).toBe(args);
	});
});

describe("factory manual dispatch planning", () => {
	it("plans the verified owner and a fresh cycle key behind approval without dispatching", async () => {
		const service = mcpService((body) => ({
			json: {
				jsonrpc: "2.0",
				id: 1,
				result:
					body.method === "tools/list"
						? { tools: [{ name: "code" }] }
						: {
								structuredContent: {
									executionId: "sample-describe",
									result: JSON.stringify([
										{
											callable: "skills.run_workflow",
											description: "Run workflow",
											annotations: {
												readOnlyHint: false,
												destructiveHint: true,
											},
											parameters: {
												type: "object",
												properties: {
													skillId: { type: "string" },
													idempotencyKey: { type: "string" },
													tediId: { type: "string" },
													params: {
														type: "object",
														additionalProperties: true,
													},
													reason: { type: "string" },
													confirmDestructive: { type: "boolean" },
												},
												required: ["tediId"],
											},
										},
									]),
								},
							},
			},
		}));
		mocks.getAppBySlugForOrg.mockResolvedValue({ slug: "sample-tools" });
		const plan = () =>
			planKernelWriteProposal({
				db: DB,
				organizationId: "org-1",
				env: baseEnv(service),
				route: writeRoute({
					rationale:
						"Exact lane skill id: sample-skill; owner tedi id: sample-owner.",
					toolIntent: {
						appSlug: "sample-tools",
						capability: "factories.run",
						connectionStatus: "connected",
					},
				}),
				content: "Run it now",
				model: objectModel({
					toolName: "skills.run_workflow",
					args: { skillId: "sample-skill", tediId: "sample-owner" },
					reasoning: "Run the known lane",
				}),
			});
		const first = await plan();
		const second = await plan();
		expect(first?.args).toMatchObject({
			skillId: "sample-skill",
			tediId: "sample-owner",
			confirmDestructive: true,
			params: { cycleKey: expect.stringMatching(/^manual-/) },
		});
		expect(first?.riskTier).toBe("high");
		expect(first?.args.idempotencyKey).toBe(
			(first?.args.params as { cycleKey: string }).cycleKey,
		);
		expect((first?.args.params as { cycleKey: string }).cycleKey).not.toBe(
			(second?.args.params as { cycleKey: string }).cycleKey,
		);
		expect(
			service.calls
				.filter((c) => c.method === "tools/call")
				.every((c) =>
					(c.params.arguments as { code: string }).code.includes(
						"discover.describe",
					),
				),
		).toBe(true);
	});
});

describe("explicit document create", () => {
	it("drafts the body while the canonical describe is in flight", async () => {
		const order: string[] = [];
		const service = mcpService(() => ({
			json: {
				jsonrpc: "2.0",
				id: 1,
				result: {
					structuredContent: {
						executionId: "exec-describe",
						result: JSON.stringify([
							{
								callable: "os.create_os_output",
								description: "Create a Tedix output",
								annotations: { readOnlyHint: false, destructiveHint: false },
								parameters: z.toJSONSchema(
									z.object({
										kind: z.literal("document"),
										title: z.string(),
										content: OsOutputContentSchema,
									}),
								),
							},
						]),
					},
				},
			},
		}));
		const slowDescribe = {
			...service,
			fetch: async (input: string, init?: RequestInit) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				const response = await service.fetch(input, init);
				order.push("describe");
				return response;
			},
		};
		const blocks = [{ type: "paragraph", text: "Welcome to the shop." }];
		const model = new MockLanguageModelV3({
			doGenerate: async () => {
				order.push("draft");
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [{ type: "text", text: JSON.stringify({ blocks }) }],
				};
			},
		});
		const result = await planKernelWriteProposal({
			db: DB,
			env: baseEnv(slowDescribe),
			organizationId: "org-1",
			route: writeRoute({
				toolIntent: {
					appSlug: "globex",
					capability: "documents.create",
					connectionStatus: "connected",
				},
			}),
			actingUserId: "user-123",
			content: 'Create a document titled "Welcome" welcoming visitors.',
			model,
		});
		expect(result?.toolName).toBe("os.create_os_output");
		expect(result?.args).toEqual({
			kind: "document",
			title: "Welcome",
			content: { kind: "document", blocks },
		});
		expect(order).toEqual(["draft", "describe"]);
		expect(service.calls).toHaveLength(1);
		expect(model.doGenerateCalls).toHaveLength(1);
	});
});

it.each([undefined, "external_side_effect", "high_impact_write"])(
	"annotations cannot lower configured or missing operational risk: %s",
	(riskTier) => {
		expect(
			classifyWriteRisk({
				name: "run_operation",
				annotations: { destructiveHint: false },
				_meta: riskTier
					? {
							"com.tedix/policy": {
								riskTier,
								blastRadius:
									riskTier === "external_side_effect"
										? "external_system"
										: "tenant",
							},
						}
					: undefined,
			}),
		).toBe("high");
	},
);
