// @vitest-environment node
import * as localInference from "@/lib/local-inference";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";

const enqueueMessage = vi.fn();
const listTedis = vi.fn();
const listConversations = vi.fn();
const readRun = vi.fn();
const respondApproval = vi.fn();
const invalidateQueries = vi.fn();

vi.mock("@/lib/api", () => ({
	osChatReadApi: {
		tedis: { list: (...args: unknown[]) => listTedis(...args) },
		kernelRuntime: {
			listConversations: (...args: unknown[]) => listConversations(...args),
			readRun: (...args: unknown[]) => readRun(...args),
		},
	},
	osChatMutationApi: {
		kernelRuntime: {
			enqueueMessage: (...args: unknown[]) => enqueueMessage(...args),
			respondApproval: (...args: unknown[]) => respondApproval(...args),
		},
	},
}));

vi.mock("@/router", () => ({
	osQueryClient: {
		invalidateQueries: (...args: unknown[]) => invalidateQueries(...args),
	},
}));

vi.mock("@/components/chat-sidebar", () => ({
	CHAT_CONVERSATIONS_QUERY_KEY: ["home-conversations-key"],
}));

import { buildChatWebMcpTools } from "@/components/chat-webmcp-tools";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TEDIS = {
	data: [
		{
			id: "11111111-1111-4111-8111-111111111111",
			slug: "cto",
			name: "CTO",
			displayName: "The CTO",
			status: "active",
		},
		{
			id: "22222222-2222-4222-8222-222222222222",
			slug: "cmo",
			name: "CMO",
			displayName: null,
			status: "active",
		},
	],
	pagination: { page: 1, limit: 50, total: 2 },
};

function queuedOutput(conversationId: string) {
	return {
		idempotencyKey: "server-echo",
		conversationId,
		status: "queued",
		run: { id: "run-1", conversationId },
	};
}

function tool(name: string) {
	const def = buildChatWebMcpTools().find((t) => t.name === name);
	if (!def) throw new Error(`missing tool ${name}`);
	return def;
}

beforeEach(() => {
	enqueueMessage.mockReset();
	listTedis.mockReset();
	listConversations.mockReset();
	readRun.mockReset();
	respondApproval.mockReset();
	invalidateQueries.mockReset();
});

afterEach(() => {
	setModelContextResolverForTests(null);
});

describe("buildChatWebMcpTools", () => {
	it("marks chat mutations as writes and chat inventories as untrusted reads", () => {
		expect(tool("send_chat_message").annotations).toEqual({
			readOnlyHint: false,
			untrustedContentHint: false,
		});
		expect(tool("list_conversations").annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
	});

	it("registers the six chat tools under the chat scope", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => context);
		const dispose = registerWebMcpScope("chat", buildChatWebMcpTools());
		expect(webMcpRegisteredToolNames()).toEqual([
			"respond_home_approval",
			"send_chat_message",
			"delegate_task_to_tedi",
			"get_chat_run_status",
			"list_tedis",
			"list_conversations",
		]);
		dispose();
	});
});

describe("respond_home_approval", () => {
	it("uses the canonical mutation and returns the dispatched run receipt", async () => {
		respondApproval.mockResolvedValue({
			run: {
				id: "run-parent",
				organizationId: "org",
				conversationId: "home:main",
				status: "queued",
				childRunId: "run-child",
				delegatedTediId: TEDIS.data[0]!.id,
				createdAt: "2026-08-26T00:00:00Z",
			},
			assignments: [],
		});

		const result = await tool("respond_home_approval").execute({
			runId: "run-parent",
			decision: "approve",
			note: "approved in Chat",
		});

		expect(respondApproval).toHaveBeenCalledWith({
			runId: "run-parent",
			decision: "approve",
			assignmentIds: undefined,
			note: "approved in Chat",
		});
		expect(result.structuredContent).toEqual({
			runId: "run-parent",
			conversationId: "home:main",
			status: "queued",
			childRunId: "run-child",
			delegatedTediId: TEDIS.data[0]!.id,
			assignments: [],
			deepLink: "/chat",
		});
	});

	it("rejects invalid decisions and maps API errors", async () => {
		const invalid = await tool("respond_home_approval").execute({
			runId: "run-parent",
			decision: "later",
		});
		expect(invalid.isError).toBe(true);
		expect(respondApproval).not.toHaveBeenCalled();

		respondApproval.mockRejectedValue(new Error("approval latch unavailable"));
		const failed = await tool("respond_home_approval").execute({
			runId: "run-parent",
			decision: "reject",
		});
		expect(failed.isError).toBe(true);
		expect(failed.content[0]!.text).toContain("approval latch unavailable");
	});
});

describe("send_chat_message", () => {
	it("reports offline mode without dispatching a browser-agent message", async () => {
		const mode = vi
			.spyOn(localInference, "isLocalAiUnavailable")
			.mockReturnValue(true);
		try {
			const result = await tool("send_chat_message").execute({
				content: "Draft an agenda",
			});
			expect(result.isError).toBe(true);
			expect(result.content[0]!.text).toContain("AI replies are off");
			expect(enqueueMessage).not.toHaveBeenCalled();
		} finally {
			mode.mockRestore();
		}
	});
	it("mints a home:os conversation id and an idempotency key for a new thread", async () => {
		enqueueMessage.mockImplementation(
			async (input: { conversationId: string }) =>
				queuedOutput(input.conversationId),
		);

		const result = await tool("send_chat_message").execute({
			content: "hello",
		});

		expect(enqueueMessage).toHaveBeenCalledTimes(1);
		const input = enqueueMessage.mock.calls[0]![0] as Record<string, unknown>;
		expect(input["content"]).toBe("hello");
		expect(input["conversationId"]).toMatch(/^home:os:[0-9a-f-]+$/);
		expect(input["idempotencyKey"]).toMatch(UUID_RE);
		expect(input["delegateToTediId"]).toBeUndefined();

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			conversationId: input["conversationId"],
			status: "queued",
			runId: "run-1",
			deepLink: "/chat",
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: ["home-conversations-key"],
		});
	});

	it("preserves an explicit conversationId and delegateToTediId", async () => {
		enqueueMessage.mockResolvedValue(queuedOutput("home:main"));

		await tool("send_chat_message").execute({
			content: "status?",
			conversationId: "home:main",
			delegateToTediId: TEDIS.data[0]!.id,
		});

		expect(enqueueMessage.mock.calls[0]![0]).toMatchObject({
			conversationId: "home:main",
			content: "status?",
			delegateToTediId: TEDIS.data[0]!.id,
		});
	});

	it("preserves a caller idempotency key and returns the server receipt", async () => {
		enqueueMessage.mockResolvedValue({
			...queuedOutput("home:main"),
			idempotencyKey: "stable-retry-key",
		});

		const result = await tool("send_chat_message").execute({
			content: "status?",
			conversationId: "home:main",
			idempotencyKey: "stable-retry-key",
		});

		expect(enqueueMessage.mock.calls[0]![0]).toMatchObject({
			idempotencyKey: "stable-retry-key",
		});
		expect(result.structuredContent).toMatchObject({
			idempotencyKey: "stable-retry-key",
		});
	});

	it.each(["completed", "canceled"])(
		"returns a %s Home turn without suggesting a delegation retry",
		async (status) => {
			enqueueMessage.mockResolvedValue({
				idempotencyKey: "k",
				conversationId: "home:main",
				status: "needs_delegation",
				run: { id: "run-2", status },
				assistantMessage: {
					content:
						"Delegated worker execution is unavailable in this local installation.",
				},
			});
			const result = await tool("send_chat_message").execute({
				content: "Delegate a task",
			});
			expect(result.structuredContent).toMatchObject({
				status,
				runId: "run-2",
				content:
					"Delegated worker execution is unavailable in this local installation.",
			});
			expect(result.structuredContent).not.toHaveProperty("availableTedis");
			expect(listTedis).not.toHaveBeenCalled();
			expect(invalidateQueries).toHaveBeenCalled();
		},
	);

	it("returns the tedi roster as a structured hint on needs_delegation", async () => {
		enqueueMessage.mockResolvedValue({
			idempotencyKey: "k",
			conversationId: "home:main",
			status: "needs_delegation",
			run: { id: "run-2" },
		});
		listTedis.mockResolvedValue(TEDIS);

		const result = await tool("send_chat_message").execute({
			content: "do the thing",
		});

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			status: "needs_delegation",
			availableTedis: [
				{ id: TEDIS.data[0]!.id, slug: "cto", name: "CTO" },
				{ id: TEDIS.data[1]!.id, slug: "cmo", name: "CMO" },
			],
		});
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("maps a failed status and an API rejection to isError", async () => {
		enqueueMessage.mockResolvedValue({
			idempotencyKey: "k",
			conversationId: "c",
			status: "failed",
			run: { id: "run-3" },
			error: "budget exhausted",
		});
		const failed = await tool("send_chat_message").execute({ content: "x" });
		expect(failed.isError).toBe(true);
		expect(failed.content[0]!.text).toContain("budget exhausted");

		enqueueMessage.mockRejectedValue(new Error("network down"));
		const rejected = await tool("send_chat_message").execute({ content: "x" });
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0]!.text).toContain("network down");
	});

	it("rejects empty content without calling the API", async () => {
		const result = await tool("send_chat_message").execute({ content: "  " });
		expect(result.isError).toBe(true);
		expect(enqueueMessage).not.toHaveBeenCalled();
	});
});

describe("delegate_task_to_tedi", () => {
	it("resolves the slug to the tedi id and sends the task as content", async () => {
		listTedis.mockResolvedValue(TEDIS);
		enqueueMessage.mockImplementation(
			async (input: { conversationId: string }) =>
				queuedOutput(input.conversationId),
		);

		const result = await tool("delegate_task_to_tedi").execute({
			task: "ship the release notes",
			tediSlug: "cmo",
		});

		const input = enqueueMessage.mock.calls[0]![0] as Record<string, unknown>;
		expect(input["delegateToTediId"]).toBe(TEDIS.data[1]!.id);
		expect(input["content"]).toBe("ship the release notes");
		expect(input["conversationId"]).toMatch(/^home:os:[0-9a-f-]+$/);
		expect(input["idempotencyKey"]).toMatch(UUID_RE);
		expect(result.structuredContent).toMatchObject({
			status: "queued",
			deepLink: "/chat",
		});
	});

	it("rejects an unknown slug with the valid slugs listed", async () => {
		listTedis.mockResolvedValue(TEDIS);

		const result = await tool("delegate_task_to_tedi").execute({
			task: "anything",
			tediSlug: "nope",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain('"nope"');
		expect(result.content[0]!.text).toContain("cto");
		expect(result.content[0]!.text).toContain("cmo");
		expect(enqueueMessage).not.toHaveBeenCalled();
	});

	it("maps a roster read failure to isError", async () => {
		listTedis.mockRejectedValue(new Error("403"));
		const result = await tool("delegate_task_to_tedi").execute({
			task: "anything",
			tediSlug: "cto",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("403");
	});
});

describe("list_tedis", () => {
	it("returns compact roster rows", async () => {
		listTedis.mockResolvedValue(TEDIS);
		const result = await tool("list_tedis").execute({});
		expect(result.structuredContent).toEqual({
			tedis: [
				{
					id: TEDIS.data[0]!.id,
					slug: "cto",
					name: "CTO",
					displayName: "The CTO",
					status: "active",
				},
				{
					id: TEDIS.data[1]!.id,
					slug: "cmo",
					name: "CMO",
					displayName: null,
					status: "active",
				},
			],
		});
	});
});

describe("WebMCP execution cancellation", () => {
	it("forwards the browser AbortSignal to Chat reads", async () => {
		const controller = new AbortController();
		await tool("list_conversations").execute({}, { signal: controller.signal });
		expect(listConversations).toHaveBeenCalledWith(
			{},
			{ signal: controller.signal },
		);
	});
});

describe("get_chat_run_status", () => {
	it("returns the durable run outcome and progress", async () => {
		readRun.mockResolvedValue({
			run: {
				id: "run-1",
				conversationId: "home:os:one",
				status: "completed",
				progress: { current: 100, total: 100, label: "Complete" },
				childRunId: "child-1",
				delegatedTediId: TEDIS.data[0]!.id,
				completedAt: "2026-08-27T00:00:00Z",
			},
		});

		const result = await tool("get_chat_run_status").execute({
			runId: "run-1",
		});
		expect(readRun).toHaveBeenCalledWith({ runId: "run-1" });
		expect(result.structuredContent).toMatchObject({
			runId: "run-1",
			status: "completed",
			childRunId: "child-1",
		});
	});

	it("rejects an empty run id without reading", async () => {
		const result = await tool("get_chat_run_status").execute({ runId: "" });
		expect(result.isError).toBe(true);
		expect(readRun).not.toHaveBeenCalled();
	});
});

describe("list_conversations", () => {
	it("passes limit through and returns compact rows with the chat deep link", async () => {
		listConversations.mockResolvedValue({
			conversations: [
				{
					id: "home:main",
					organizationId: "org",
					title: "Main",
					status: "active",
					lastMessageAt: "2026-08-26T00:00:00Z",
					messageCount: 12,
					createdAt: "2026-08-01T00:00:00Z",
				},
				{
					id: "home:os:abc",
					organizationId: "org",
					title: null,
					status: "active",
					createdAt: "2026-08-20T00:00:00Z",
				},
			],
			nextCursor: null,
		});

		const result = await tool("list_conversations").execute({ limit: 20 });

		expect(listConversations).toHaveBeenCalledWith({ limit: 20 });
		expect(result.structuredContent).toEqual({
			conversations: [
				{
					conversationId: "home:main",
					title: "Main",
					status: "active",
					lastMessageAt: "2026-08-26T00:00:00Z",
					messageCount: 12,
				},
				{
					conversationId: "home:os:abc",
					title: null,
					status: "active",
					lastMessageAt: null,
					messageCount: null,
				},
			],
			deepLink: "/chat",
		});
	});

	it("maps a rejection to isError", async () => {
		listConversations.mockRejectedValue(new Error("timeout"));
		const result = await tool("list_conversations").execute({});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("timeout");
	});
});
