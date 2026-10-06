import { describe, expect, it } from "vite-plus/test";
import { EnqueueHomeMessageInputSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	buildHomeSurfaceTools,
	homeQueuedAckText,
	removeProjectedKernelConversationLifecycleTools,
	shouldExposeHomeSurface,
} from "./home-surface";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "@tedix/mcp-shared/auth/tool-scopes";

describe("home surface tools", () => {
	const tools = buildHomeSurfaceTools();
	const byId = new Map(tools.map((tool) => [tool.toolId, tool]));

	it("exposes canonical optional Workspace context without widening Home authority", () => {
		const schema = byId.get("ask")!.inputSchema;
		const canonical = zodToToolInputJsonSchema(
			EnqueueHomeMessageInputSchema.pick({ workspaceContext: true }),
		);
		expect(schema.properties?.workspaceContext).toEqual(
			canonical.properties?.workspaceContext,
		);
		expect(schema.required).toEqual(["content"]);
		expect(schema.additionalProperties).toBe(false);
		for (const field of [
			"organizationId",
			"executionPolicy",
			"modelRef",
			"idempotencyKey",
		]) {
			expect(schema.properties?.[field]).toBeUndefined();
		}
		expect(schema.properties?.workspaceContext).toMatchObject({
			type: "object",
			required: ["workspaceId"],
			properties: {
				workpiece: {
					type: "object",
					required: ["kind", "id"],
					properties: { kind: { enum: ["gadget", "output"] } },
				},
			},
		});
	});

	it("emits ask as the sole unnamespaced Home entry point", () => {
		expect([...byId.keys()].sort()).toEqual(
			[
				"home__accept_work_item",
				"home__approve_home_plan",
				"ask",
				"home__async_canary",
				"home__cancel_home_run",
				"home__cancel_work_item",
				"home__complete_work_item",
				"home__create_work_item",
				"home__archive_conversation",
				"home__delete_conversation",
				"home__list_kernel_trace_bundles",
				"home__list_conversations",
				"home__pin_conversation",
				"home__read_child_run_evidence",
				"home__read_child_run_tree",
				"home__read_home_messages",
				"home__read_home_run",
				"home__read_home_trace",
				"home__read_home_run_events",
				"home__read_delegated_tedi_traces",
				"home__read_home_run_set",
				"home__rename_conversation",
				"home__respond_home_approval",
				"home__retry_delegation",
				"home__steer_home_run",
				"home__synthesize_spoken_reply",
				"home__update_work_item",
			].sort(),
		);
	});

	it("marks the async canary _asyncTask so the generic-task gate is reachable", () => {
		const canary = byId.get("home__async_canary");
		expect(canary).toBeDefined();
		expect((canary?.config as { _asyncTask?: boolean })._asyncTask).toBe(true);
		expect(
			(canary?.config as { _forwardCallerAuth?: boolean })._forwardCallerAuth,
		).toBeUndefined();
		expect((canary?.config as { endpoint?: string }).endpoint).toBe(
			"kernelRuntime/readRunSet",
		);
		// Other home tools must not opt into async execution.
		const asyncTools = tools.filter(
			(tool) => (tool.config as { _asyncTask?: boolean })._asyncTask === true,
		);
		expect(asyncTools.map((tool) => tool.toolId)).toEqual([
			"home__async_canary",
		]);
		for (const tool of tools.filter((candidate) => candidate !== canary)) {
			expect(
				(tool.config as { _forwardCallerAuth?: boolean })._forwardCallerAuth,
				tool.toolId,
			).toBe(true);
		}
	});

	it("maps each tool to its kernelRuntime rpc endpoint", () => {
		const endpoints = Object.fromEntries(
			tools.map((tool) => [
				tool.toolId,
				(tool.config as { endpoint?: string }).endpoint,
			]),
		);
		expect(endpoints).toMatchObject({
			ask: "kernelRuntime/enqueueMessage",
			home__read_home_messages: "kernelRuntime/readMessages",
			home__read_home_run_set: "kernelRuntime/readRunSet",
			home__read_home_run: "kernelRuntime/readRun",
			home__read_home_trace: "kernelRuntime/readRunTrace",
			home__read_home_run_events: "kernelRuntime/readRunEvents",
			home__read_child_run_evidence: "kernelRuntime/readChildRunEvidence",
			home__read_child_run_tree: "kernelRuntime/readChildRunTree",
			home__list_conversations: "kernelRuntime/listConversations",
			home__rename_conversation: "kernelRuntime/renameConversation",
			home__pin_conversation: "kernelRuntime/pinConversation",
			home__archive_conversation: "kernelRuntime/archiveConversation",
			home__delete_conversation: "kernelRuntime/deleteConversation",
			home__read_delegated_tedi_traces: "harness/listTraceBundles",
			home__list_kernel_trace_bundles: "harness/listKernelTraceBundles",
			home__approve_home_plan: "kernelRuntime/approvePlanAssignments",
			home__respond_home_approval: "kernelRuntime/respondApproval",
			home__cancel_home_run: "kernelRuntime/cancelRun",
			home__steer_home_run: "kernelRuntime/steerRun",
			home__retry_delegation: "kernelRuntime/retryDelegation",
			home__synthesize_spoken_reply: "voice/synthesizeSpokenReply",
			home__create_work_item: "workItems/create",
			home__update_work_item: "workItems/updateSpecification",
			home__accept_work_item: "workItems/accept",
			home__complete_work_item: "workItems/complete",
			home__cancel_work_item: "workItems/cancel",
		});
	});

	it("never carries a tedi identity (org resolves from caller header)", () => {
		// read_delegated_tedi_traces takes a `tediId` INPUT that references the
		// delegated tedi whose bundles to read — not the caller's identity. It is
		// safe under the same invariants as every other home tool: allowExplicitTediId
		// stays false (so a tedi caller is force-scoped to itself by
		// enforceContextParams; a human operator's reference passes through), and the
		// harness/listTraceBundles endpoint authorizes it via requireTediAccess (org
		// membership). The static-identity checks below still apply to it.
		const REFERENCES_DELEGATED_TEDI = new Set([
			"home__read_delegated_tedi_traces",
		]);
		for (const tool of tools) {
			const config = tool.config as Record<string, unknown>;
			expect(config.transport).toBe("rpc");
			expect(config.allowExplicitTediId).toBe(false);
			// No tedi static params: home is not modeled under a tedi.
			expect(config._aggregateTediId).toBeUndefined();
			expect(
				(config.staticParams as { tediId?: unknown })?.tediId,
			).toBeUndefined();
			expect(config._aggregateNamespace).toBe("home");
			// No organizationId param advertised — org rides X-Tedix-Org-Id.
			const props = tool.inputSchema.properties ?? {};
			expect(props.organizationId).toBeUndefined();
			if (!REFERENCES_DELEGATED_TEDI.has(tool.toolId)) {
				expect(props.tediId).toBeUndefined();
			}
		}
	});

	it("marks ask + mutations as not read-only, reads as read-only", () => {
		expect(byId.get("ask")?.annotations?.readOnlyHint).toBe(false);
		expect(byId.get("home__cancel_home_run")?.annotations?.readOnlyHint).toBe(
			false,
		);
		expect(byId.get("home__steer_home_run")?.annotations?.readOnlyHint).toBe(
			false,
		);
		expect(
			byId.get("home__respond_home_approval")?.annotations?.readOnlyHint,
		).toBe(false);
		expect(
			byId.get("home__synthesize_spoken_reply")?.annotations?.readOnlyHint,
		).toBe(false);
		expect(
			byId.get("home__read_home_messages")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(byId.get("home__read_home_run")?.annotations?.readOnlyHint).toBe(
			true,
		);
		expect(
			byId.get("home__read_child_run_evidence")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(
			byId.get("home__read_child_run_tree")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(
			byId.get("home__list_conversations")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(byId.get("home__archive_conversation")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});
		expect(byId.get("home__delete_conversation")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(byId.get("home__delete_conversation")?.inputSchema.required).toEqual(
			["conversationId", "reason", "confirmDestructive"],
		);
		expect(
			byId.get("home__list_kernel_trace_bundles")?.annotations?.readOnlyHint,
		).toBe(true);
	});

	it("removes only duplicate kernel conversation lifecycle projections", () => {
		const template = tools[0];
		expect(template).toBeDefined();
		const projected = [
			{
				...template!,
				toolId: "kernel__list",
				config: { endpoint: "kernelRuntime/listConversations" },
			},
			{
				...template!,
				toolId: "kernel__archive",
				config: { endpoint: "kernelRuntime/archiveConversation" },
			},
			{
				...template!,
				toolId: "kernel__trace",
				config: { endpoint: "kernelRuntime/readRunTrace" },
			},
			{
				...template!,
				toolId: "observe__list",
				config: { endpoint: "observe/listEvents" },
			},
		];

		expect(
			removeProjectedKernelConversationLifecycleTools(projected).map(
				(tool) => tool.toolId,
			),
		).toEqual(["kernel__trace", "observe__list"]);
	});

	it("links enqueue tools to the MCP tasks extension (task.id = homeRunId)", () => {
		const enqueueIds = ["ask"];
		for (const id of enqueueIds) {
			const tool = byId.get(id);
			expect((tool?.config as Record<string, unknown>)._emitTaskLinkage).toBe(
				true,
			);
			expect(tool?.description).toContain("tasks/get");
		}
		// Reads/approvals never claim task linkage — only enqueue creates a run.
		for (const [id, tool] of byId) {
			if (enqueueIds.includes(id)) continue;
			expect(
				(tool.config as Record<string, unknown>)._emitTaskLinkage,
			).toBeUndefined();
		}
	});

	it("requires content for ask and runId for run-scoped tools", () => {
		expect(byId.get("ask")?.inputSchema.required).toEqual(["content"]);
		expect(byId.get("ask")?.inputSchema.properties).toHaveProperty(
			"attachments",
		);
		expect(
			byId.get("home__synthesize_spoken_reply")?.inputSchema.required,
		).toEqual(["text"]);
		expect(byId.get("home__read_home_run")?.inputSchema.required).toEqual([
			"runId",
		]);
		expect(
			byId.get("home__read_child_run_evidence")?.inputSchema.required,
		).toEqual(["delegatedTediId", "childRunId"]);
		expect(
			byId.get("home__read_child_run_tree")?.inputSchema.properties,
		).toHaveProperty("conversationId");
		expect(byId.get("home__steer_home_run")?.inputSchema.required).toEqual([
			"runId",
			"instruction",
		]);
	});

	it("respond_home_approval is the single approval surface: runId + required decision, never a raw approval UUID", () => {
		const tool = byId.get("home__respond_home_approval");
		expect(tool?.inputSchema.required).toEqual(["runId", "decision"]);
		const decision = (
			tool?.inputSchema.properties as
				| Record<string, { enum?: string[] }>
				| undefined
		)?.decision;
		expect(decision?.enum).toEqual(["approve", "reject"]);
		// No approvalRequestId/raw-UUID input — the surface stays Home-shaped.
		expect(tool?.inputSchema.properties?.approvalRequestId).toBeUndefined();
		expect(tool?.description).toContain("write-action");
		expect(tool?.description).toContain("plan");
	});

	it("enumerates suggest_handoff among the kernel route kinds in ask", () => {
		expect(byId.get("ask")?.description).toContain("suggest_handoff");
	});

	it("wires the Work Item write tools to workItems/* over the service binding (org from header, no organizationId input)", () => {
		const writeTools = [
			"home__create_work_item",
			"home__update_work_item",
			"home__accept_work_item",
			"home__complete_work_item",
			"home__cancel_work_item",
		];
		for (const id of writeTools) {
			const tool = byId.get(id);
			expect(tool, id).toBeDefined();
			const config = tool?.config as Record<string, unknown>;
			expect(config.transport).toBe("rpc");
			expect(config.method).toBe("POST");
			expect(config._forwardCallerAuth).toBe(true);
			expect(config.allowExplicitTediId).toBe(false);
			// Org rides X-Tedix-Org-Id; never an input field the caller can spoof.
			expect(tool?.inputSchema.properties?.organizationId).toBeUndefined();
		}
	});

	it("scopes targeted Work Item writes as MUTATING", () => {
		for (const id of [
			"home__create_work_item",
			"home__update_work_item",
			"home__accept_work_item",
			"home__complete_work_item",
			"home__cancel_work_item",
		]) {
			expect(byId.get(id)?.annotations?.readOnlyHint, id).toBe(false);
			expect(byId.get(id)?.annotations?.destructiveHint, id).toBe(false);
		}
		expect(byId.get("home__cancel_work_item")?.inputSchema.required).toEqual([
			"id",
		]);
		expect(byId.get("home__create_work_item")?.inputSchema.required).toEqual([
			"title",
		]);
		expect(byId.get("home__update_work_item")?.inputSchema.required).toEqual([
			"id",
		]);
	});
});

describe("home Work Item write tools are fail-closed without the write scope", () => {
	const tools = buildHomeSurfaceTools();
	const byId = new Map(tools.map((tool) => [tool.toolId, tool]));
	// The Code Mode authorization path resolves inner-tool scopes with
	// fallbackOnAuthenticatedAuthMode — the seam where a scopeless caller is
	// actually denied (apps/mcp/src/mcp/codemode-auth.ts).
	const CODE_MODE = { fallbackOnAuthenticatedAuthMode: true } as const;
	// Work Item writes use the dedicated collaboration capability.
	const WRITE_SCOPE: Record<string, string> = {
		home__create_work_item: "mcp:work.write",
		home__update_work_item: "mcp:work.write",
		home__accept_work_item: "mcp:work.admin",
		home__complete_work_item: "mcp:work.write",
		home__cancel_work_item: "mcp:work.admin",
	};

	it("resolves a concrete, non-empty write scope for every Work Item write tool", () => {
		for (const [id, scope] of Object.entries(WRITE_SCOPE)) {
			const tool = byId.get(id);
			expect(tool, id).toBeDefined();
			const required = resolveMcpToolRequiredScopes(
				tool!,
				"home",
				undefined,
				CODE_MODE,
			);
			expect(required, id).toEqual([scope]);
		}
	});

	it("denies an unauthenticated or scopeless caller, and a caller holding only an unrelated scope", () => {
		for (const id of Object.keys(WRITE_SCOPE)) {
			const tool = byId.get(id)!;
			// No identity at all → fail-closed.
			expect(
				isMcpToolVisibleToCaller(tool, "home", undefined, {}, CODE_MODE),
				id,
			).toBe(false);
			// Authenticated but no scopes → fail-closed.
			expect(
				isMcpToolVisibleToCaller(
					tool,
					"home",
					undefined,
					{ authType: "oauth", scopes: [] },
					CODE_MODE,
				),
				id,
			).toBe(false);
			// A read-only scope is not a write grant → still denied.
			expect(
				isMcpToolVisibleToCaller(
					tool,
					"home",
					undefined,
					{ authType: "oauth", scopes: ["mcp:observe"] },
					CODE_MODE,
				),
				id,
			).toBe(false);
		}
	});

	it("admits a caller that holds the tool's write scope", () => {
		for (const [id, scope] of Object.entries(WRITE_SCOPE)) {
			const tool = byId.get(id)!;
			expect(
				isMcpToolVisibleToCaller(
					tool,
					"home",
					undefined,
					{ authType: "oauth", scopes: [scope] },
					CODE_MODE,
				),
				id,
			).toBe(true);
		}
	});

	it("admits targeted writes through their resolved scope and trusted service transport", () => {
		for (const id of [
			"home__create_work_item",
			"home__update_work_item",
			"home__accept_work_item",
			"home__complete_work_item",
			"home__cancel_work_item",
		]) {
			expect(
				isMcpToolVisibleToCaller(
					byId.get(id)!,
					"home",
					undefined,
					{ authType: "oauth", scopes: [WRITE_SCOPE[id]!] },
					CODE_MODE,
				),
				id,
			).toBe(true);
			expect(
				isMcpToolVisibleToCaller(
					byId.get(id)!,
					"home",
					undefined,
					{ authType: "service" },
					CODE_MODE,
				),
				id,
			).toBe(true);
		}
	});
});

describe("shouldExposeHomeSurface", () => {
	it("exposes Home on newly provisioned tedi-only organization gateways", () => {
		expect(
			shouldExposeHomeSurface({
				appSlug: "cedar-trial-unified",
				metadata: {
					mcpConfig: { aggregateTedis: [{ slug: "cedar-trial" }] },
				},
			}),
		).toBe(true);
	});

	it("exposes Home on the platform aggregate and tenant aggregate apps", () => {
		expect(
			shouldExposeHomeSurface({
				appSlug: "tedix-unified",
				metadata: null,
			}),
		).toBe(true);
		expect(
			shouldExposeHomeSurface({
				appSlug: "acme-unified",
				metadata: {
					mcpConfig: {
						aggregateApps: [{ slug: "openai-docs-acme" }],
					},
				},
			}),
		).toBe(true);
	});

	it("keeps single-purpose provider apps off the Home surface", () => {
		expect(
			shouldExposeHomeSurface({
				appSlug: "openai-docs-acme",
				metadata: { mcpConfig: {} },
			}),
		).toBe(false);
		expect(
			shouldExposeHomeSurface({
				appSlug: "openai-docs-acme",
				metadata: { mcpConfig: { aggregateApps: [], aggregateTedis: [] } },
			}),
		).toBe(false);
	});
});

describe("homeQueuedAckText (soft-deadline ack synthesis)", () => {
	const QUEUED_ACK = {
		idempotencyKey: "home_run_42",
		conversationId: "home:main",
		status: "queued",
		run: { id: "home_run_42", status: "running", metadata: {} },
		task: { id: "home_run_42", pollWith: "tasks/get" },
	};

	it("synthesizes the honest ack text for the queued shape (no assistantMessage)", () => {
		const text = homeQueuedAckText(QUEUED_ACK);
		expect(text).toBe(
			"Working on it — this turn continues in the background. Poll tasks/get with task id home_run_42 or read_home_run for the result; the Home transcript receives the answer when ready.",
		);
	});

	it("acks on run.status running even without the top-level queued status", () => {
		const text = homeQueuedAckText({
			run: { id: "home_run_7", status: "running" },
		});
		expect(text).toContain("home_run_7");
		expect(text).toContain("tasks/get");
		expect(text).toContain("read_home_run");
	});

	it("returns null for fast turns (assistantMessage present) — output stays unchanged", () => {
		expect(
			homeQueuedAckText({
				...QUEUED_ACK,
				status: "needs_delegation",
				run: { id: "home_run_42", status: "completed" },
				assistantMessage: {
					id: "home_run_42:assistant",
					content: "Here is your answer.",
				},
			}),
		).toBeNull();
		// Even a queued-looking shape with a real answer never gets the ack.
		expect(
			homeQueuedAckText({
				...QUEUED_ACK,
				assistantMessage: { id: "x", content: "answer" },
			}),
		).toBeNull();
	});

	it("returns null for completed/failed runs without the queued markers", () => {
		expect(
			homeQueuedAckText({
				status: "needs_delegation",
				run: { id: "home_run_42", status: "completed" },
			}),
		).toBeNull();
		expect(
			homeQueuedAckText({
				status: "failed",
				error: "boom",
				run: { id: "home_run_42", status: "failed" },
			}),
		).toBeNull();
	});

	it("returns null for malformed shapes (no run, no run id, non-records)", () => {
		expect(homeQueuedAckText(undefined)).toBeNull();
		expect(homeQueuedAckText(null)).toBeNull();
		expect(homeQueuedAckText("queued")).toBeNull();
		expect(homeQueuedAckText({ status: "queued" })).toBeNull();
		expect(
			homeQueuedAckText({ status: "queued", run: { status: "running" } }),
		).toBeNull();
		expect(homeQueuedAckText({ status: "queued", run: [] })).toBeNull();
	});
});
