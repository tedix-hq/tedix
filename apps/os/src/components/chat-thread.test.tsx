import * as localInference from "@/lib/local-inference";
import type {
	EnqueueHomeMessageOutput,
	HomeMessage,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

// ---------------------------------------------------------------------------
// Seams for the MOUNTED coverage below
//
// Every mock identity here is module-level and STABLE: a hook mock that returns
// a fresh object each render re-runs every effect that depends on it, which in
// this repo means an infinite render loop rather than a visible failure.
// ---------------------------------------------------------------------------

vi.mock("@/components/widget-frame", () => ({
	WidgetFrame: ({ onFollowUp }: { onFollowUp?: (message: string) => void }) => (
		<button onClick={() => onFollowUp?.("Tell me more about Bun")}>
			Widget follow-up
		</button>
	),
}));

const kernelRuntimeApi = vi.hoisted(() => ({
	attachConversationArtifactPin: vi.fn(),
	attachConversationCapability: vi.fn(),
	detachConversationArtifactPin: vi.fn(),
	detachConversationCapability: vi.fn(),
	listConversationArtifactPins: vi.fn(),
	listConversationCapabilities: vi.fn(),
	readMessages: vi.fn(),
	readRunSet: vi.fn(),
	retryRun: vi.fn(),
}));
const capabilitiesApi = vi.hoisted(() => ({ list: vi.fn() }));
const skillsApi = vi.hoisted(() => ({ listByOrg: vi.fn() }));
const modelCatalogApi = vi.hoisted(() => ({ list: vi.fn() }));
const tedisApi = vi.hoisted(() => ({ list: vi.fn() }));
const userSettingsApi = vi.hoisted(() => ({ getContext: vi.fn() }));
const directReadApi = vi.hoisted(() => ({
	kernelRuntime: { listReadOnlyTools: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		capabilities: capabilitiesApi,
		kernelRuntime: kernelRuntimeApi,
		modelCatalog: modelCatalogApi,
		skills: skillsApi,
		tedis: tedisApi,
		userSettings: userSettingsApi,
	},
	osDirectReadApi: directReadApi,
}));

/**
 * The chat transport seam. `status` is THIS conversation's stream — the signal
 * the reconnect reconcile reads — and the test drives it directly.
 */
const transport = vi.hoisted(() => ({
	status: "idle" as "idle" | "connecting" | "open" | "reconnecting",
	overlays: [] as never[],
	actions: {
		enqueueMessage: vi.fn(),
		cancelRun: vi.fn(),
		respondApproval: vi.fn(),
	},
}));

vi.mock("@/lib/use-capn-chat", () => ({
	useChatTransport: () => ({
		supported: true,
		status: transport.status,
		overlays: transport.overlays,
		actions: transport.actions,
	}),
}));

/**
 * The shell's worst-first aggregate, pinned to `connecting` for every mounted
 * test. Another capability stuck mid-establish is exactly the state that held
 * the aggregate off `open` and silently disabled the reconcile; pinning it
 * means the reconnect test below can only pass by reading the conversation's
 * own stream.
 */
const REALTIME_AGGREGATE = vi.hoisted(() => ({
	status: "connecting" as const,
	degraded: false,
	subscriptions: 2,
	subscribers: 2,
	sockets: 1,
}));
const REALTIME_SURFACE = vi.hoisted(() => ({
	conversationId: "home:main",
	status: "connecting" as const,
}));

vi.mock("@/lib/use-realtime", () => ({
	useRealtimeSurface: () => REALTIME_SURFACE,
	useRealtimeStatus: () => REALTIME_AGGREGATE,
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import {
	homeMessagesQueryKey,
	homeRunSetQueryKey,
} from "@/lib/os-query-options";
import {
	ACTIVE_RUN_STATUSES,
	activeDelegations,
	imageAttachmentRefusal,
	JumpToLatestControl,
	shouldReconcileApprovalsOnStreamOpen,
	isUnresolvedApprovalCard,
	reconcileApprovalsAfterReconnect,
	selectedModelImageInput,
	ApprovalInputGate,
	applyDelegatedRunPreviews,
	appendHydrateEvents,
	buildReadArguments,
	ChatMessageBubble,
	ChatResponseActions,
	ChatThread,
	chatResponseActionPrompt,
	chatResponseActionSendsImmediately,
	chatDraftKey,
	composerImageRefusal,
	compareHomeMessages,
	contextUsedItems,
	conversationIdForSend,
	directReadError,
	HYDRATE_RUN_EVENTS_TAIL,
	executionLinkMessageIds,
	encodeChatContext,
	invalidateOnFocus,
	mergeHomeMessages,
	newHomeConversationId,
	needsDelegationChoice,
	latestActionableAssistantMessageId,
	isBlockingApprovalCard,
	nextSessionAutoApproval,
	nextIdempotencyKey,
	parseDirectReadCommand,
	readToolFields,
	restoreChatDraft,
	ProvisionalUserBubble,
	RunningIndicator,
	runSetPollInterval,
	SendFailureBanner,
	shouldPollTranscript,
	shouldHydrateRun,
	shouldShowRunningIndicator,
	userMessageFromEnqueue,
} from "./chat-thread";
import type { ProvisionalSend } from "@/lib/provisional-send";
import {
	applyOverlayEvent,
	createOverlayState,
	listOverlays,
	visibleOverlays,
} from "@/lib/overlay-state";
import { approvalsFromRunSet, RunLinkChip } from "./chat-cards";
import type { CardRunLinkProps } from "./chat-cards";
import type { HomeRunSet } from "@tedix/api-contract/schemas/kernel-runtime";
import type { ModelCatalogModel } from "@tedix/api-contract/schemas/model-catalog-projection";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("pending-run convergence", () => {
	it("polls a pending send even while realtime reports healthy", () => {
		expect(
			runSetPollInterval({
				active: false,
				forceActive: true,
				realtimeDegraded: false,
			}),
		).toBe(4000);
		expect(
			shouldPollTranscript({
				isActive: true,
				pendingRun: true,
				realtimeDegraded: false,
			}),
		).toBe(true);
	});

	it("reconciles active run-set state even while realtime is healthy", () => {
		expect(
			runSetPollInterval({
				active: true,
				forceActive: false,
				realtimeDegraded: false,
			}),
		).toBe(15_000);
		expect(
			shouldPollTranscript({
				isActive: true,
				pendingRun: false,
				realtimeDegraded: false,
			}),
		).toBe(false);
	});

	it("uses fast polling for a pending send or degraded realtime", () => {
		expect(
			runSetPollInterval({
				active: false,
				forceActive: true,
				realtimeDegraded: false,
			}),
		).toBe(4000);
		expect(
			runSetPollInterval({
				active: true,
				forceActive: false,
				realtimeDegraded: true,
			}),
		).toBe(4000);
	});

	it("periodically reconciles an idle run set for no-run changes", () => {
		expect(
			runSetPollInterval({
				active: false,
				forceActive: false,
				realtimeDegraded: false,
			}),
		).toBe(60_000);
	});
});

describe("contextUsedItems", () => {
	it("allows only attributable run context and excludes secret-shaped metadata", () => {
		const runs: HomeRun[] = [
			{
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: "home:workspace",
				status: "completed",
				usage: {
					pricing: null,

					inputTokens: 7105,
					outputTokens: 198,
					reasoningTokens: 83,
					totalTokens: 7303,
					costUsd: 0.01,
				},
				delegatedTediId: "tedi-cto",
				createdAt: "2026-08-21T12:00:00.000Z",
				metadata: {
					modelRef: "azure-openai/gpt-5.6-luna",
					routerVersion: "router-v1",
					kernelRoute: { routeKind: "delegate_tedi" },
					contextManifest: {
						version: 1,
						budgetTokens: 124000,
						inputTokens: 7105,
						sources: [
							{ name: "workspace", count: 1 },
							{ name: "history", count: 4 },
						],
						historyCompaction: null,
					},
					workspaceContext: {
						workspaceId: "workspace-1",
						workspaceName: "Launch room",
						workpiece: { kind: "output", id: "output-1" },
					},
					accessToken: "must-never-render",
					apiKey: "must-never-render",
				},
			},
		];
		const items = contextUsedItems(runs);
		expect(items).toEqual(
			expect.arrayContaining([
				{ label: "Organization", value: ORG_ID },
				{ label: "Workspace", value: "Launch room" },
				{ label: "Workpiece", value: "output: output-1" },
				{ label: "Model", value: "azure-openai/gpt-5.6-luna" },
				{ label: "Route", value: "delegate_tedi" },
				{ label: "Delegated tedi", value: "tedi-cto" },
				{
					label: "Context sources",
					value: "workspace: 1 → history: 4",
				},
				{ label: "Model input", value: "7105 tokens" },
				{ label: "Reasoning usage", value: "83 tokens" },
				{ label: "Context budget", value: "124000 tokens" },
				{ label: "History compaction", value: "Not applied" },
			]),
		);
		expect(JSON.stringify(items)).not.toContain("must-never-render");
	});
});

function message(overrides: Partial<HomeMessage> = {}): HomeMessage {
	return {
		id: `${RUN_ID}:assistant`,
		organizationId: ORG_ID,
		conversationId: "home:main",
		role: "assistant",
		status: "completed",
		content: "Hello from the kernel",
		createdAt: "2026-08-13T10:00:00.000Z",
		...overrides,
	};
}

/** Router-free stand-in for the TanStack Link so bubbles SSR in tests. */
function StubLink({
	to,
	params,
	search,
	className,
	children,
}: CardRunLinkProps) {
	const href = `${to.replace("$runId", params.runId)}${search?.branch ? `?branch=${encodeURIComponent(search.branch)}` : ""}`;
	return (
		<a data-testid="run-chip" href={href} className={className}>
			{children}
		</a>
	);
}

describe("chat response actions", () => {
	it("offers Tedix-native transient and durable continuation paths", () => {
		const html = renderToStaticMarkup(
			<ChatResponseActions onChoose={() => undefined} />,
		);
		expect(html).toContain('data-slot="chat-response-actions"');
		expect(html).toContain("Visualize");
		expect(html).toContain("Generate UI");
		expect(html).toContain("Create output");
		expect(html).toContain("Build gadget");
	});

	it("keeps persistence behind an explicit confirmation step", () => {
		expect(chatResponseActionPrompt("visualize")).toContain(
			"Do not create or modify a durable Gadget or Output",
		);
		expect(chatResponseActionPrompt("visualize")).toContain("ui.get_catalog");
		expect(chatResponseActionPrompt("generate-ui")).toContain(
			"ui.create_mcp_app",
		);
		expect(chatResponseActionPrompt("output")).toContain(
			"ask for my confirmation",
		);
		expect(chatResponseActionPrompt("gadget")).toContain(
			"ask for my confirmation",
		);
		expect(chatResponseActionSendsImmediately("visualize")).toBe(true);
		expect(chatResponseActionSendsImmediately("generate-ui")).toBe(true);
		expect(chatResponseActionSendsImmediately("output")).toBe(false);
		expect(chatResponseActionSendsImmediately("gadget")).toBe(false);
	});

	it("targets only the newest completed assistant answer with prose", () => {
		expect(
			latestActionableAssistantMessageId([
				message({ id: "answer-1", content: "First answer" }),
				message({ id: "empty", content: "", role: "assistant" }),
				message({ id: "failed", content: "Partial", status: "failed" }),
				message({ id: "answer-2", content: "Latest answer" }),
			]),
		).toBe("answer-2");
		expect(
			latestActionableAssistantMessageId([
				message({ id: "answer", content: "Previous answer" }),
				message({ id: "user", content: "New question", role: "user" }),
			]),
		).toBeNull();
	});

	it("offers no continuation on a turn whose delegated run failed", () => {
		// Regression: "Continue with Visualize / Generate UI" rendered
		// under "The delegated tedi reported that the assignment failed." The
		// parent message is legitimately completed — it delivered the report —
		// so the failure only shows on the child run.
		const report = {
			...message({ id: "report", content: "The delegated tedi failed." }),
			childRunId: "child-1",
		};
		expect(
			latestActionableAssistantMessageId([report], [
				{ id: "child-1", status: "failed" },
			] as never),
		).toBeNull();
		// A child that succeeded is still an answer worth promoting.
		expect(
			latestActionableAssistantMessageId([report], [
				{ id: "child-1", status: "completed" },
			] as never),
		).toBe("report");
		// An in-flight child is not a failure either.
		expect(
			latestActionableAssistantMessageId([report], [
				{ id: "child-1", status: "running" },
			] as never),
		).toBe("report");
	});
});

describe("JumpToLatestControl", () => {
	it("reserves a row outside the scrollport for the icon-only control", () => {
		const html = renderToStaticMarkup(
			<JumpToLatestControl visible onJump={() => undefined} />,
		);

		expect(html).toContain('data-slot="jump-to-latest-control"');
		expect(html).toContain("shrink-0");
		expect(html).toContain("py-1");
		expect(html).not.toContain("absolute");
		expect(html).toContain("pointer-events-none");
		expect(html).toContain('aria-label="Jump to latest"');
		expect(html).toContain('data-icon-only="true"');
		expect(html).toContain("pointer-events-auto");
		expect(html).toContain("rounded-full");
		expect(html).toContain("bg-kumo-base");
		expect(html).not.toContain(">Jump to latest<");
	});

	it("does not reserve space while the transcript follows the bottom", () => {
		expect(
			renderToStaticMarkup(
				<JumpToLatestControl visible={false} onJump={() => undefined} />,
			),
		).toBe("");
	});
});

describe("ChatMessageBubble", () => {
	it("lets message rows shrink inside the capped transcript grid", () => {
		const durable = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ role: "user", content: "x".repeat(2_000) })}
			/>,
		);
		const provisional = renderToStaticMarkup(
			<ProvisionalUserBubble
				send={{
					idempotencyKey: "long-message",
					messageId: "long-message:input",
					conversationId: "home:main",
					content: "x".repeat(2_000),
					state: "sending",
					attempts: 1,
					error: null,
					createdAt: "2026-08-24T22:00:00.000Z",
				}}
			/>,
		);

		for (const html of [durable, provisional]) {
			expect(html).toContain("w-full min-w-0 max-w-full");
		}
	});

	it("keeps terminal delegation history out of global live chrome", () => {
		const runs = [
			{
				id: "completed-parent",
				organizationId: ORG_ID,
				conversationId: "home:main",
				status: "completed",
				delegatedTediId: "tedi-completed",
				childRunId: "child-completed",
				createdAt: "2026-08-21T10:00:00.000Z",
			},
			{
				id: "running-parent",
				organizationId: ORG_ID,
				conversationId: "home:main",
				status: "running",
				delegatedTediId: "tedi-running",
				childRunId: "child-running",
				createdAt: "2026-08-21T10:01:00.000Z",
			},
		] as const;
		expect(activeDelegations(runs)).toEqual([
			expect.objectContaining({ runId: "running-parent" }),
		]);
	});

	it("accepts only a fully-qualified explicit direct-read command", () => {
		expect(
			parseDirectReadCommand('/read acme.search_products {"query":"AirPods"}'),
		).toEqual({
			appSlug: "acme",
			toolName: "search_products",
			arguments: { query: "AirPods" },
		});
		expect(parseDirectReadCommand("read acme.search_products")).toBeNull();
		expect(parseDirectReadCommand("/read acme.search_products []")).toBeNull();
		expect(
			parseDirectReadCommand("/read acme.search_products {bad}"),
		).toBeNull();
	});

	it("derives required composer controls and typed arguments from tool schema", () => {
		const tool = {
			name: "search_products",
			title: "Search products",
			description: null,
			connectionState: "connected" as const,
			connectionReason: null,
			connectProviderId: null,
			inputSchema: {
				type: "object",
				required: ["query"],
				properties: {
					query: { type: "string", title: "Search query" },
					limit: { type: "integer" },
					includeUsed: { type: "boolean" },
				},
			},
		};
		expect(readToolFields(tool)).toEqual([
			expect.objectContaining({ name: "query", required: true }),
			expect.objectContaining({ name: "limit", required: false }),
			expect.objectContaining({ name: "includeUsed", required: false }),
		]);
		expect(
			buildReadArguments(tool, {
				query: "AirPods",
				limit: "5",
				includeUsed: "true",
			}),
		).toEqual({ query: "AirPods", limit: 5, includeUsed: true });
		expect(() => buildReadArguments(tool, {})).toThrow("query is required");
	});

	it("validates structured read arguments with field-specific errors", () => {
		const tool = {
			name: "search_products",
			title: "Search products",
			description: null,
			connectionState: "connected" as const,
			connectionReason: null,
			connectProviderId: null,
			inputSchema: {
				type: "object",
				properties: {
					filters: { type: "object" },
					categories: { type: "array" },
				},
			},
		};
		expect(
			buildReadArguments(tool, {
				filters: '{"country":"DE"}',
				categories: '["audio"]',
			}),
		).toEqual({ filters: { country: "DE" }, categories: ["audio"] });
		expect(() => buildReadArguments(tool, { filters: "{" })).toThrow(
			"filters must be valid JSON",
		);
	});

	it("preserves typed enum values from schema-derived selects", () => {
		const tool = {
			name: "list_invoices",
			title: "List invoices",
			description: null,
			connectionState: "connected" as const,
			connectionReason: null,
			connectProviderId: null,
			inputSchema: {
				type: "object",
				properties: {
					pageSize: { enum: [10, 25, 50] },
					includeCanceled: { enum: [true, false] },
				},
			},
		};
		expect(
			buildReadArguments(tool, {
				pageSize: "25",
				includeCanceled: "false",
			}),
		).toEqual({ pageSize: 25, includeCanceled: false });
	});

	it("offers a labeled, keyboard-reachable copy control on assistant turns", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ role: "assistant", content: "The answer is 42." })}
			/>,
		);
		expect(html).toContain("Copy this response to the clipboard");
		// Hover-revealed, but never removed from the tab order — focus inside the
		// control brings it back for keyboard operators.
		expect(html).toContain("focus-within:opacity-100");
		expect(html).toContain("group-hover/message:opacity-100");
	});

	it("does not offer a copy control on user turns", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ role: "user", content: "What is the answer?" })}
			/>,
		);
		expect(html).not.toContain("Copy this response to the clipboard");
	});

	it("renders structured direct-read results as labeled fields instead of JSON", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({
					content: "acme · search_products returned a structured result.",
					metadata: {
						directReadResult: { product: "AirPods Pro", price: 249 },
					},
				})}
			/>,
		);
		expect(html).toContain("product");
		expect(html).toContain("AirPods Pro");
		expect(html).toContain("price");
		expect(html).not.toContain("&quot;product&quot;");
	});

	it("renders structured direct-read results from the durable message envelope", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({
					content: "facturama · catalog_search returned a structured result.",
					metadata: {
						role: "assistant",
						content: "facturama · catalog_search returned a structured result.",
						channel: "home",
						metadata: {
							directReadResult: {
								result: [{ Name: "Hardware para anteojos", Value: "42142904" }],
							},
						},
					},
				})}
			/>,
		);
		expect(html).toContain("Hardware para anteojos");
		expect(html).toContain("42142904");
	});

	it("reads durable connection recovery metadata without a run", () => {
		expect(
			directReadError(
				message({
					content: "Read failed: no active tenant connection",
					metadata: {
						directReadError: {
							kind: "connection_required",
							retryable: false,
							connectProviderId: "facturama-api-key",
						},
					},
				}),
			),
		).toEqual({
			kind: "connection_required",
			retryable: false,
			connectProviderId: "facturama-api-key",
		});
	});

	it("keeps a New thread isolated and stable across a retry", () => {
		expect(newHomeConversationId()).toMatch(/^home:os:[0-9a-f-]+$/);
		const first = conversationIdForSend(null, null, () => "fresh-id");
		expect(first).toBe("home:os:fresh-id");
		expect(conversationIdForSend(null, first, () => "second-id")).toBe(first);
		expect(conversationIdForSend("home:main", first, () => "ignored-id")).toBe(
			"home:main",
		);
		expect(newHomeConversationId(() => "other-id")).toBe("home:os:other-id");
	});

	it("renders a user message as a right-aligned filled bubble", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({
					id: `${RUN_ID}:input`,
					role: "user",
					content: "Ship the chat surface",
				})}
			/>,
		);
		expect(html).toContain('data-role="user"');
		expect(html).toContain("justify-end");
		expect(html).toContain("bg-kumo-fill");
		// The brief's user-bubble geometry: 24px radius, squared bottom-right,
		// capped at min(680px, 78%).
		expect(html).toContain("rounded-[24px]");
		expect(html).toContain("rounded-br-lg");
		expect(html).toContain("max-w-[min(680px,78%)]");
		expect(html).toContain("type-tedix-body");
		expect(html).not.toContain("text-sm leading-relaxed");
		expect(html).toContain("Ship the chat surface");
	});

	it("renders an assistant message bubble-free with preserved whitespace", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ content: "line one\nline two" })}
			/>,
		);
		expect(html).toContain('data-role="assistant"');
		expect(html).toContain("justify-start");
		// No bubble for assistant turns: plain text on the canvas.
		expect(html).not.toContain("bg-kumo-fill");
		expect(html).not.toContain("border-kumo-hairline bg-kumo-base");
		expect(html).not.toContain("whitespace-pre-wrap");
		expect(html).toContain("line one\nline two");
		expect(html).toContain('dateTime="2026-08-13T10:00:00.000Z"');
	});

	it("renders Markdown but preserves raw HTML as text", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ content: "<script>alert(1)</script> **bold**" })}
			/>,
		);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("<strong>bold</strong>");
	});

	it("links the run chip to the run detail route when a runId is present", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ runId: RUN_ID })}
				LinkComponent={StubLink}
			/>,
		);
		expect(html).toContain(`href="/work/executions/${RUN_ID}"`);
		expect(html).toContain("Details");
		expect(html).not.toContain(`run ${RUN_ID.slice(0, 8)}`);
	});

	it("keeps execution details compact without repeating the prompt", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ runId: RUN_ID })}
				LinkComponent={StubLink}
			/>,
		);
		expect(html).toContain(`href="/work/executions/${RUN_ID}"`);
		expect(html).toContain(">Details<");
		expect(html).not.toContain("Run:");
		expect(html).not.toContain("rounded-full border");
	});

	it("shows one execution action on the latest message of each run", () => {
		const rows = [
			message({ id: "user", role: "user", runId: RUN_ID }),
			message({ id: "ack", runId: RUN_ID }),
			message({ id: "other", runId: "other-run" }),
			message({
				id: "failure",
				runId: RUN_ID,
				status: "failed",
				content: "Facets currently cannot set alarms.",
			}),
		];
		const links = executionLinkMessageIds(rows);
		expect([...links]).toEqual(["failure", "other"]);
		const html = renderToStaticMarkup(
			<ul>
				{rows.map((row) => (
					<ChatMessageBubble
						key={row.id}
						message={row}
						showExecutionLink={links.has(row.id)}
						LinkComponent={StubLink}
					/>
				))}
			</ul>,
		);
		expect(
			html.match(new RegExp(`href="/work/executions/${RUN_ID}"`, "g")),
		).toHaveLength(1);
		expect(html).toContain("Facets currently cannot set alarms.");
		expect(html).toContain("failed");
		expect(executionLinkMessageIds([message()]).size).toBe(0);
	});

	it("omits the repeated current workspace badge but preserves a different attachment", () => {
		const context = {
			kind: "workspace",
			id: "workspace-1",
			label: "Reddit",
		} as const;
		const row = message({
			role: "user",
			content: encodeChatContext(context, "Tell me more"),
		});
		const html = renderToStaticMarkup(
			<ChatMessageBubble message={row} context={context} />,
		);
		expect(html).toContain("Tell me more");
		expect(html).not.toContain("workspace: Reddit");
		const withDocument = renderToStaticMarkup(
			<ChatMessageBubble
				message={row}
				workspaceId={context.id}
				context={{ kind: "output", id: "output-1", label: "Operating brief" }}
			/>,
		);
		expect(withDocument).not.toContain("Reddit");
		const other = renderToStaticMarkup(
			<ChatMessageBubble
				message={row}
				context={{ ...context, id: "workspace-2" }}
			/>,
		);
		expect(other).toContain("Reddit");
	});

	it("omits the run chip when the message carries no runId", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble message={message()} LinkComponent={StubLink} />,
		);
		expect(html).not.toContain("run-chip");
	});

	it("labels attachment-only turns instead of rendering an empty bubble", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({
					content: "",
					attachments: [
						{
							content: "…",
							fileName: "note.ogg",
							mimeType: "audio/ogg",
							type: "audio",
						},
					],
				})}
			/>,
		);
		expect(html).toContain("1 attachment");
	});

	it("uses a human empty-response label instead of implementation residue", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble message={message({ content: "", runId: RUN_ID })} />,
		);
		expect(html).toContain("Execution completed without a written response");
		expect(html).not.toContain("(no text)");
	});

	it("names non-prose durable payloads from typed metadata", () => {
		const structured = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({
					content: "",
					metadata: { directReadResult: { count: 2 } },
				})}
			/>,
		);
		const runtime = renderToStaticMarkup(
			<ChatMessageBubble message={message({ content: "", role: "runtime" })} />,
		);
		expect(structured).toContain("Connected app result attached");
		expect(runtime).toContain("Execution update recorded");
	});

	it("marks failed messages", () => {
		const html = renderToStaticMarkup(
			<ChatMessageBubble message={message({ status: "failed" })} />,
		);
		expect(html).toContain("failed");
		expect(html).toContain("text-kumo-danger");
	});
});

describe("RunLinkChip", () => {
	it("renders through an injected link component", () => {
		const html = renderToStaticMarkup(
			<RunLinkChip runId={RUN_ID} LinkComponent={StubLink} />,
		);
		expect(html).toContain(`href="/work/runs/${RUN_ID}"`);
	});
});

describe("RunningIndicator", () => {
	it("renders the default working label", () => {
		const html = renderToStaticMarkup(<RunningIndicator />);
		expect(html).toContain('data-slot="running-indicator"');
		expect(html).toContain("type-tedix-body");
		expect(html).toContain("Working on it…");
	});

	it("prefers a run progress label when provided", () => {
		const html = renderToStaticMarkup(
			<RunningIndicator label="Delegating to CTO" />,
		);
		expect(html).toContain("Delegating to CTO");
	});
});

describe("ApprovalInputGate", () => {
	it("owns the input lane while a delegation decision is pending", () => {
		const html = renderToStaticMarkup(<ApprovalInputGate count={2} />);
		expect(html).toContain('data-slot="chat-approval-gate"');
		expect(html).toContain(
			"Approval required before the conversation can continue",
		);
		expect(html).toContain("cannot be mistaken for that decision");
		expect(html).toContain("2 pending");
		expect(html).not.toContain("chat-composer");
	});
});

describe("nextSessionAutoApproval", () => {
	const approval = (id: string, scope: string) => ({
		approvalId: id,
		runId: `${id}-run`,
		summary: "Approve delegation",
		status: "pending" as const,
		sessionScopeKey: scope,
	});

	it("matches only the allowed delegation target and skips attempted cards", () => {
		const cards = [
			approval("cmo-1", "delegate:cmo"),
			approval("cto-1", "delegate:cto"),
			approval("cmo-2", "delegate:cmo"),
		];
		expect(
			nextSessionAutoApproval(
				cards,
				new Set(["delegate:cmo"]),
				new Set(["cmo-1"]),
			)?.approvalId,
		).toBe("cmo-2");
		expect(
			nextSessionAutoApproval(cards, new Set(["delegate:ceo"]), new Set()),
		).toBeNull();
	});
});

describe("terminal delegation proposal gates", () => {
	function cards(
		status: "completed" | "failed" | "canceled" | "requires_approval",
	) {
		return approvalsFromRunSet({
			runs: [
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: "home:main",
					status,
					createdAt: "2026-10-05T10:00:00.000Z",
					metadata: {
						homeDelegation: {
							decision: { mode: "needs_approval", reason: "target not active" },
							workOrder: { targetTediId: "cto", status: "draft" },
						},
					},
				},
			],
			approvalMirrors: {},
		});
	}
	it.each(["completed", "failed", "canceled"] as const)(
		"keeps a %s proposal in history without blocking composition or auto-approving",
		(status) => {
			const history = cards(status);
			expect(history).toHaveLength(1);
			expect(history.filter(isBlockingApprovalCard)).toEqual([]);
			expect(
				nextSessionAutoApproval(history, new Set(["delegate:cto"]), new Set()),
			).toBeNull();
		},
	);
	it("retains a live approval gate and exact-scope session allowance", () => {
		const pending = cards("requires_approval");
		expect(pending.filter(isBlockingApprovalCard)).toHaveLength(1);
		expect(
			nextSessionAutoApproval(pending, new Set(["delegate:cto"]), new Set()),
		).toBe(pending[0]);
	});
	it("rejects no-action and expired cards even if a session scope is present", () => {
		const pending = cards("requires_approval")[0]!;
		for (const card of [
			{ ...pending, decisionMode: "no_action" as const },
			{ ...pending, expired: true },
		]) {
			expect(
				nextSessionAutoApproval([card], new Set(["delegate:cto"]), new Set()),
			).toBeNull();
		}
	});
});

describe("SendFailureBanner", () => {
	it("does not call an unknown outcome a hard failure when the overlay is already gone", () => {
		// The durable row can land BEFORE the enqueue promise rejects, which
		// retires the overlay first. Deriving "unknown" only from the overlay
		// then rendered "Message not sent" beside the message sitting durably on
		// screen — and promised a held draft next to an empty composer.
		const html = renderToStaticMarkup(
			<SendFailureBanner
				message="Connection lost."
				outcomeUnknown={true}
				draftHeld={false}
			/>,
		);
		expect(html).toContain("Message may not have been sent");
		expect(html).not.toContain("Message not sent<");
		expect(html).not.toContain("draft is intact");
	});

	it("renders the failure with an intact-draft hint and a Retry action", () => {
		const html = renderToStaticMarkup(
			<SendFailureBanner message="Network unreachable." />,
		);
		expect(html).toContain("Message not sent");
		expect(html).toContain("Network unreachable.");
		expect(html).toContain("draft is intact");
		expect(html).toContain("Retry");
	});

	it("states an unknown outcome as unknown, never as failure", () => {
		const html = renderToStaticMarkup(
			<SendFailureBanner message="The socket died." outcomeUnknown draftHeld />,
		);
		expect(html).toContain("Message may not have been sent");
		expect(html).not.toContain("Message not sent");
		// The draft is in the unconfirmed bubble, so the banner must not send the
		// operator looking for it in an empty composer.
		expect(html).toContain("shown above as unconfirmed");
		expect(html).not.toContain("draft is intact");
	});

	it("disables Retry while a retry is in flight", () => {
		const html = renderToStaticMarkup(
			<SendFailureBanner message="Timeout." retrying />,
		);
		expect(html).toContain('disabled=""');
	});
});

describe("draft persistence", () => {
	it("keys drafts per conversation with a shared key for new threads", () => {
		expect(chatDraftKey("home:main")).toBe("tedix-os:chat-draft:home:main");
		expect(chatDraftKey(null)).toBe("tedix-os:chat-draft:new");
	});

	it("restores the stored draft for the conversation key", () => {
		const store = new Map([[chatDraftKey("home:main"), "half-typed thought"]]);
		const storage = { getItem: (key: string) => store.get(key) ?? null };
		expect(restoreChatDraft(storage, "home:main")).toBe("half-typed thought");
		expect(restoreChatDraft(storage, "home:other")).toBe("");
		expect(restoreChatDraft(storage, null)).toBe("");
	});

	it("reads as empty when storage throws", () => {
		const storage = {
			getItem: () => {
				throw new Error("denied");
			},
		};
		expect(restoreChatDraft(storage, "home:main")).toBe("");
	});
});

describe("nextIdempotencyKey", () => {
	it("mints a key for a fresh send and keeps it stable across a retry", () => {
		let minted = 0;
		const generate = () => {
			minted += 1;
			return `key-${minted}`;
		};
		const first = nextIdempotencyKey(null, generate);
		expect(first).toBe("key-1");
		// Simulated retry after a failure: the held key wins, nothing new mints.
		const retried = nextIdempotencyKey(first, generate);
		expect(retried).toBe("key-1");
		expect(minted).toBe(1);
		// Only after success clears the ref does a new send mint a new key.
		expect(nextIdempotencyKey(null, generate)).toBe("key-2");
	});

	it("defaults to a UUID generator", () => {
		expect(nextIdempotencyKey(null)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
	});
});

describe("mergeHomeMessages", () => {
	it("replaces a plain dispatch receipt with its canonical failure outcome", () => {
		const receipt = {
			...message({
				id: `${RUN_ID}:assistant`,
				content: "I delegated this Home turn.",
				runId: RUN_ID,
			}),
			childRunId: "child-1",
			metadata: {
				metadata: {
					homeSubject: true,
					homePlan: null,
					delegationWorkOrder: { kind: "tedi.delegate", status: "draft" },
					delegationError: null,
				},
			},
		};
		const failure = {
			...message({
				id: `${RUN_ID}:async-completion:assistant`,
				content: "Facets currently cannot set alarms.",
				runId: RUN_ID,
			}),
			childRunId: "child-1",
		};
		expect(applyDelegatedRunPreviews([receipt], [])).toEqual([receipt]);
		expect(applyDelegatedRunPreviews([receipt, failure], [])).toEqual([
			failure,
		]);
		for (const metadata of [
			{ delegationError: "Dispatch failed" },
			{ delegationWorkOrder: { status: "requires_approval" } },
			{
				delegationWorkOrder: {
					kind: "tedi.delegate",
					status: "requires_approval",
				},
			},
			{ approvalRequestId: "pending-approval" },
			{ homePlan: { rationale: "A meaningful plan" } },
		]) {
			const substantive = {
				...receipt,
				metadata: { metadata: { ...receipt.metadata.metadata, ...metadata } },
			};
			expect(applyDelegatedRunPreviews([substantive, failure], [])).toEqual([
				substantive,
				failure,
			]);
		}
	});

	it("renders the terminal delegated preview while the completion row is missing", () => {
		const original = message({ content: "", runId: RUN_ID });
		const [projected] = applyDelegatedRunPreviews(
			[original],
			[
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: "home:test",
					status: "completed",
					createdAt: "2026-09-03T00:00:00.000Z",
					metadata: { childRunPreview: "Verified child result." },
				},
			],
		);
		expect(projected?.content).toBe("Verified child result.");
		expect(original.content).toBe("");
	});

	it("does not expose a rolling preview while delegation is active", () => {
		const original = message({ content: "", runId: RUN_ID });
		const [projected] = applyDelegatedRunPreviews(
			[original],
			[
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: "home:test",
					status: "running",
					createdAt: "2026-09-03T00:00:00.000Z",
					metadata: { childRunPreview: "Still working." },
				},
			],
		);
		expect(projected?.content).toBe("");
		expect(projected?.status).toBe("streaming");
		expect(original.status).toBe("completed");
		const html = renderToStaticMarkup(
			<ChatMessageBubble message={projected!} />,
		);
		expect(html).toContain("Response is still being prepared");
		expect(html).not.toContain("Execution completed");
	});

	it("drops a stale blank delegation carrier once the canonical answer exists", () => {
		const staleCarrier = message({
			id: `${RUN_ID}:assistant`,
			content: "",
			runId: RUN_ID,
		});
		const canonical = message({
			id: `${RUN_ID}:async-completion:assistant`,
			content: "Verified child result.",
			runId: RUN_ID,
		});
		const projected = applyDelegatedRunPreviews(
			[staleCarrier, canonical],
			[
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: "home:test",
					status: "completed",
					createdAt: "2026-09-03T00:00:00.000Z",
					metadata: { childRunPreview: "Verified child result." },
				},
			],
		);
		expect(projected).toEqual([canonical]);
	});

	it("preserves other blank assistant rows that may carry structured UI", () => {
		const structured = message({
			id: `${RUN_ID}:widget:assistant`,
			content: "",
			runId: RUN_ID,
		});
		const canonical = message({
			id: `${RUN_ID}:async-completion:assistant`,
			content: "Verified child result.",
			runId: RUN_ID,
		});
		expect(applyDelegatedRunPreviews([structured, canonical], [])).toEqual([
			structured,
			canonical,
		]);
	});

	it("treats re-delivery as a no-op overwrite keyed by id", () => {
		const cache = new Map<string, HomeMessage>();
		const first = message({ id: "run-1:assistant", status: "streaming" });
		mergeHomeMessages(cache, [first]);
		const redelivered = message({ id: "run-1:assistant", status: "completed" });
		const merged = mergeHomeMessages(cache, [redelivered, redelivered]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.status).toBe("completed");
	});

	it("orders oldest-first with user-before-assistant on timestamp ties", () => {
		const cache = new Map<string, HomeMessage>();
		const merged = mergeHomeMessages(cache, [
			message({
				id: "run-2:assistant",
				createdAt: "2026-08-13T10:00:05.000Z",
			}),
			message({
				id: "run-2:input",
				role: "user",
				createdAt: "2026-08-13T10:00:05.000Z",
			}),
			message({
				id: "run-1:assistant",
				createdAt: "2026-08-13T09:59:00.000Z",
			}),
		]);
		expect(merged.map((m) => m.id)).toEqual([
			"run-1:assistant",
			"run-2:input",
			"run-2:assistant",
		]);
	});

	it("compareHomeMessages falls back to id order on full ties", () => {
		const a = message({ id: "a" });
		const b = message({ id: "b" });
		expect(compareHomeMessages(a, b)).toBeLessThan(0);
		expect(compareHomeMessages(b, a)).toBeGreaterThan(0);
		expect(compareHomeMessages(a, a)).toBe(0);
	});
});

/**
 * Regression: a delegated turn rendered [user] → [delegated result]
 * → [kernel ack], with the ack LAST although it was emitted minutes earlier.
 *
 * The ordering key was never the problem: both durable rows carry a causal
 * `createdAt` and `mergeHomeMessages` sorts on it. The ack was not a durable
 * bubble at all — it was its streamed OVERLAY, which renders below every
 * durable message and is retired only when its durable row lands in the
 * transcript. The server's narration collapse DROPS the dispatch-ack row
 * (`collapseHomeDelegationNarration`, "one delegation = one row"), so that row
 * never lands and the overlay was immortal.
 *
 * These tests drive the real seam functions in the same composition the thread
 * renders: durable rows first, then `visibleOverlays`.
 */
describe("delegated turn render order (a07fc196)", () => {
	const CHILD_RUN_ID = "child-run-af63be17";
	const ACK_MESSAGE_ID = `${RUN_ID}:assistant`;
	// `asyncCompletionAssistantMessageId` in apps/api run-store.ts.
	const RESULT_MESSAGE_ID = `${RUN_ID}:async-completion:assistant`;

	function streamEvent(
		overrides: Partial<RuntimeStreamEvent>,
	): RuntimeStreamEvent {
		return {
			id: "evt",
			kind: "message.delta",
			conversationId: "home:main",
			runId: RUN_ID,
			createdAt: "2026-08-27T20:02:00.000Z",
			...overrides,
		};
	}

	/** The kernel ack: streamed, then finalized as narration the read drops. */
	function foldDispatchAck() {
		const overlayState = createOverlayState();
		applyOverlayEvent(
			overlayState,
			streamEvent({
				kind: "message.delta",
				sequence: 0,
				delta: "On it — delegating to CTO now.",
			}),
		);
		applyOverlayEvent(
			overlayState,
			streamEvent({
				kind: "message.completed",
				messageId: ACK_MESSAGE_ID,
				payload: {
					role: "assistant",
					content: "On it — delegating to CTO now.",
					metadata: { homeNarration: "delegation_ack" },
				},
			}),
		);
		return overlayState;
	}

	/** Exactly what `readMessages` returns after the narration collapse. */
	const collapsedTranscript = [
		message({
			id: `${RUN_ID}:input`,
			role: "user",
			content: "validate the workspace",
			createdAt: "2026-08-27T20:02:00.000Z",
		}),
		message({
			id: RESULT_MESSAGE_ID,
			content: "9/9 workspace checks connected.",
			createdAt: "2026-08-27T20:05:00.000Z",
		}),
	];

	it("never renders the dispatch ack after the delegated result", () => {
		const overlayState = foldDispatchAck();
		const durable = mergeHomeMessages(
			new Map<string, HomeMessage>(),
			collapsedTranscript,
		);
		const durableIds = new Set(durable.map((row) => row.id));
		const rendered = [
			...durable.map((row) => row.id),
			...visibleOverlays(listOverlays(overlayState), durableIds).map(
				(overlay) => overlay.key,
			),
		];
		expect(rendered).toEqual([`${RUN_ID}:input`, RESULT_MESSAGE_ID]);
		expect(rendered[rendered.length - 1]).not.toBe(ACK_MESSAGE_ID);
	});

	it("keeps a RENDERED ack before its delegated result on the durable key", () => {
		// A delegation that renders its ack (an unstamped row — e.g. one still
		// awaiting approval) must stay causal on the ordering key alone, including
		// the worst case the item hypothesised: identical timestamps. The ids are
		// deterministic and `${runId}:assistant` sorts before
		// `${runId}:async-completion:assistant`, so the tie-break is causal too.
		const sameInstant = "2026-08-27T20:02:00.000Z";
		const merged = mergeHomeMessages(new Map<string, HomeMessage>(), [
			message({ id: RESULT_MESSAGE_ID, createdAt: sameInstant }),
			message({ id: ACK_MESSAGE_ID, createdAt: sameInstant }),
		]);
		expect(merged.map((row) => row.id)).toEqual([
			ACK_MESSAGE_ID,
			RESULT_MESSAGE_ID,
		]);
	});

	it("shows in-flight chrome for the whole gap between ack and result", () => {
		const overlayState = foldDispatchAck();
		const durable = mergeHomeMessages(
			new Map<string, HomeMessage>(),
			// Mid-delegation: the result has not landed yet.
			collapsedTranscript.slice(0, 1),
		);
		const overlays = visibleOverlays(
			listOverlays(overlayState),
			new Set(durable.map((row) => row.id)),
		);
		// The ack overlay is gone (its durable row is dropped, so it can never be
		// swapped) — which is exactly what un-suppresses the running indicator.
		expect(overlays).toHaveLength(0);
		expect(
			shouldShowRunningIndicator({
				showRunning: true,
				overlayCount: overlays.length,
			}),
		).toBe(true);
		// …and the delegation itself is named by the run set's own live chrome.
		expect(
			activeDelegations([
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: "home:main",
					status: "queued",
					delegatedTediId: "tedi-cto",
					childRunId: CHILD_RUN_ID,
					createdAt: "2026-08-27T20:02:00.000Z",
				},
			]),
		).toEqual([expect.objectContaining({ childRunId: CHILD_RUN_ID })]);
	});
});

describe("userMessageFromEnqueue", () => {
	it("derives the deterministic input-message row from the enqueue echo", () => {
		const output: EnqueueHomeMessageOutput = {
			idempotencyKey: RUN_ID,
			conversationId: "home:os:new-thread",
			status: "queued",
			run: {
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: "home:os:new-thread",
				status: "queued",
				createdAt: "2026-08-13T11:00:00.000Z",
			},
		};
		const user = userMessageFromEnqueue(output, "hello there");
		expect(user.id).toBe(`${RUN_ID}:input`);
		expect(user.runId).toBe(RUN_ID);
		expect(user.conversationId).toBe("home:os:new-thread");
		expect(user.role).toBe("user");
		expect(user.content).toBe("hello there");
		expect(user.createdAt).toBe("2026-08-13T11:00:00.000Z");
	});

	it("mirrors the read's own status rule instead of claiming completed", () => {
		// normalizeHomeMessage returns "pending" for a user row whose run is still
		// active and "completed" once terminal. Hardcoding "completed" made the
		// echo disagree with the very next refetch.
		const base: EnqueueHomeMessageOutput = {
			idempotencyKey: RUN_ID,
			conversationId: "home:main",
			status: "queued",
			run: {
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: "home:main",
				status: "running",
				createdAt: "2026-08-13T11:00:00.000Z",
			},
		};
		expect(userMessageFromEnqueue(base, "x").status).toBe("pending");
		expect(
			userMessageFromEnqueue(
				{ ...base, run: { ...base.run, status: "completed" } },
				"x",
			).status,
		).toBe("completed");
	});
});

describe("ProvisionalUserBubble", () => {
	function provisional(
		overrides: Partial<ProvisionalSend> = {},
	): ProvisionalSend {
		return {
			idempotencyKey: RUN_ID,
			messageId: `${RUN_ID}:input`,
			conversationId: "home:main",
			content: "Ship the chat surface",
			state: "sending",
			attempts: 1,
			error: null,
			createdAt: "2026-08-13T11:00:00.000Z",
			...overrides,
		};
	}

	it("marks an in-flight send busy and says so in a live region", () => {
		const html = renderToStaticMarkup(
			<ProvisionalUserBubble send={provisional()} />,
		);
		expect(html).toContain('data-slot="provisional-user-message"');
		expect(html).toContain('data-provisional-state="sending"');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("type-tedix-body");
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain("Sending…");
		expect(html).toContain("Ship the chat surface");
	});

	it("renders an unknown outcome as unconfirmed — not sent, not failed", () => {
		const html = renderToStaticMarkup(
			<ProvisionalUserBubble
				send={provisional({ state: "outcome_unknown" })}
			/>,
		);
		expect(html).toContain('data-provisional-state="outcome_unknown"');
		expect(html).toContain("Delivery unconfirmed");
		// The claim must not harden in either direction while it is in flight.
		expect(html).not.toContain('aria-busy="true"');
		expect(html).not.toContain("Sent");
		expect(html).not.toContain("Failed");
	});

	it("names the attempt on a same-key retry", () => {
		const html = renderToStaticMarkup(
			<ProvisionalUserBubble send={provisional({ attempts: 2 })} />,
		);
		expect(html).toContain("attempt 2");
	});

	it("is visibly provisional rather than dressed as a durable bubble", () => {
		const durable = renderToStaticMarkup(
			<ChatMessageBubble
				message={message({ id: `${RUN_ID}:input`, role: "user" })}
			/>,
		);
		const pending = renderToStaticMarkup(
			<ProvisionalUserBubble send={provisional()} />,
		);
		expect(durable).toContain("bg-kumo-fill");
		expect(pending).not.toContain("bg-kumo-fill");
		expect(pending).toContain("border-dashed");
	});
});

function streamEvent(
	overrides: Partial<RuntimeStreamEvent> = {},
): RuntimeStreamEvent {
	return {
		id: "evt-1",
		kind: "message.delta",
		runId: RUN_ID,
		sequence: 0,
		delta: "partial ",
		createdAt: "2026-08-13T10:00:01.000Z",
		...overrides,
	};
}

describe("shouldHydrateRun (hydrate-once guard)", () => {
	it("grants hydration exactly once per run id", () => {
		const hydrated = new Set<string>();
		expect(shouldHydrateRun(hydrated, RUN_ID)).toBe(true);
		// The grant marks the run — a racing effect re-run never double-fetches.
		expect(hydrated.has(RUN_ID)).toBe(true);
		expect(shouldHydrateRun(hydrated, RUN_ID)).toBe(false);
	});

	it("tracks run ids independently", () => {
		const hydrated = new Set<string>();
		expect(shouldHydrateRun(hydrated, "run-a")).toBe(true);
		expect(shouldHydrateRun(hydrated, "run-b")).toBe(true);
		expect(shouldHydrateRun(hydrated, "run-a")).toBe(false);
		expect(shouldHydrateRun(hydrated, "run-b")).toBe(false);
	});

	it("re-arms when the guard set is recreated (conversation switch)", () => {
		let hydrated = new Set<string>();
		expect(shouldHydrateRun(hydrated, RUN_ID)).toBe(true);
		hydrated = new Set(); // what the per-conversation reset does
		expect(shouldHydrateRun(hydrated, RUN_ID)).toBe(true);
	});

	it("hydrates with a bounded tail", () => {
		expect(HYDRATE_RUN_EVENTS_TAIL).toBeGreaterThan(0);
		expect(HYDRATE_RUN_EVENTS_TAIL).toBeLessThanOrEqual(500);
	});
});

describe("appendHydrateEvents", () => {
	it("appends unseen events and dedupes re-delivery by id", () => {
		const first = streamEvent({ id: "evt-1" });
		const second = streamEvent({ id: "evt-2", sequence: 1, delta: "text" });
		const one = appendHydrateEvents([], [first]);
		const two = appendHydrateEvents(one, [first, second, second]);
		expect(two.map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
	});

	it("returns the previous array by reference when nothing new arrives", () => {
		const previous = appendHydrateEvents([], [streamEvent()]);
		const unchanged = appendHydrateEvents(previous, [streamEvent()]);
		// Same reference → the setState updater bails out, no extra render.
		expect(unchanged).toBe(previous);
	});
});

describe("invalidateOnFocus", () => {
	it("invalidates the run-set and transcript caches for the conversation", () => {
		const invalidated: unknown[] = [];
		const queryClient = {
			invalidateQueries: (filters?: { queryKey?: unknown }) => {
				invalidated.push(filters?.queryKey);
				return Promise.resolve();
			},
		};
		invalidateOnFocus(queryClient, "home:main");
		expect(invalidated).toEqual([
			homeRunSetQueryKey("home:main"),
			homeMessagesQueryKey("home:main"),
		]);
	});

	it("no-ops for a not-yet-created conversation", () => {
		const invalidated: unknown[] = [];
		const queryClient = {
			invalidateQueries: (filters?: { queryKey?: unknown }) => {
				invalidated.push(filters?.queryKey);
				return Promise.resolve();
			},
		};
		invalidateOnFocus(queryClient, null);
		expect(invalidated).toEqual([]);
	});
});

describe("ACTIVE_RUN_STATUSES", () => {
	it("matches the readRunSet activeRunIds definition", () => {
		expect([...ACTIVE_RUN_STATUSES].sort()).toEqual([
			"queued",
			"requires_approval",
			"running",
		]);
		expect(ACTIVE_RUN_STATUSES.has("completed")).toBe(false);
		expect(ACTIVE_RUN_STATUSES.has("failed")).toBe(false);
	});
});

describe("needsDelegationChoice", () => {
	function output(routeKind: string): EnqueueHomeMessageOutput {
		return {
			idempotencyKey: RUN_ID,
			conversationId: "home:main",
			status: "needs_delegation",
			run: {
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: "home:main",
				status: "completed",
				createdAt: "2026-08-17T12:00:00.000Z",
				metadata: { kernelRoute: { routeKind } },
			},
		};
	}

	it("suppresses the legacy sentinel for a completed Home answer", () => {
		expect(needsDelegationChoice(output("answer_in_home"))).toBe(false);
	});

	it("keeps the notice for a real delegation recommendation", () => {
		expect(needsDelegationChoice(output("delegate_tedi"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Reconnect reconciliation for approval cards
// ---------------------------------------------------------------------------

const CHILD_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPROVAL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function recordingClient() {
	const invalidated: unknown[] = [];
	return {
		invalidated,
		queryClient: {
			invalidateQueries: (filters?: { queryKey?: unknown }) => {
				invalidated.push(filters?.queryKey);
				return Promise.resolve();
			},
		},
	};
}

/** The run set as the server serves it while a delegated run is blocked. */
function blockedRunSet(): Pick<HomeRunSet, "runs" | "approvalMirrors"> {
	return {
		runs: [
			{
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: "home:main",
				status: "requires_approval",
				childRunId: CHILD_RUN_ID,
				delegatedTediId: "tedi-cto",
				createdAt: "2026-08-25T10:00:00.000Z",
			},
		],
		approvalMirrors: {
			[APPROVAL_ID]: {
				id: "mirror-1",
				parentConversationId: "home:main",
				childRunId: CHILD_RUN_ID,
				approvalRequestId: APPROVAL_ID,
				delegatedTediId: "tedi-cto",
				status: "pending",
				blockedAt: "2026-08-25T10:00:01.000Z",
				escalateAt: 900,
			},
		},
	};
}

describe("shouldReconcileApprovalsOnStreamOpen", () => {
	it("reconciles mount, first-connect, and reconnect opens", () => {
		expect(shouldReconcileApprovalsOnStreamOpen("idle", "open")).toBe(true);
		expect(shouldReconcileApprovalsOnStreamOpen("connecting", "open")).toBe(
			true,
		);
		expect(shouldReconcileApprovalsOnStreamOpen("reconnecting", "open")).toBe(
			true,
		);
	});

	it("ignores states that have not just become usable", () => {
		expect(shouldReconcileApprovalsOnStreamOpen("open", "reconnecting")).toBe(
			false,
		);
		expect(shouldReconcileApprovalsOnStreamOpen("open", "open")).toBe(false);
	});
});

describe("reconcileApprovalsAfterReconnect", () => {
	it("re-reads the run set for a card still rendered pending", () => {
		const { invalidated, queryClient } = recordingClient();
		const cards = approvalsFromRunSet(blockedRunSet());
		expect(cards).toHaveLength(1);
		expect(
			reconcileApprovalsAfterReconnect(queryClient, "home:main", cards),
		).toBe(true);
		expect(invalidated).toEqual([homeRunSetQueryKey("home:main")]);
	});

	it("costs no read when nothing is pending, and never touches the transcript", () => {
		const { invalidated, queryClient } = recordingClient();
		expect(reconcileApprovalsAfterReconnect(queryClient, "home:main", [])).toBe(
			false,
		);
		expect(
			reconcileApprovalsAfterReconnect(queryClient, "home:main", [
				{
					approvalId: APPROVAL_ID,
					runId: RUN_ID,
					summary: "Expired request",
					status: "pending",
					expired: true,
				},
			]),
		).toBe(false);
		expect(invalidated).toEqual([]);
		expect(invalidated).not.toContain(homeMessagesQueryKey("home:main"));
	});

	it("no-ops for a not-yet-created conversation", () => {
		const { invalidated, queryClient } = recordingClient();
		expect(
			reconcileApprovalsAfterReconnect(
				queryClient,
				null,
				approvalsFromRunSet(blockedRunSet()),
			),
		).toBe(false);
		expect(invalidated).toEqual([]);
	});

	it("a card pending at disconnect and resolved during the outage shows resolved after reconnect", () => {
		// 1. Pending when the connection dies.
		const beforeOutage = approvalsFromRunSet(blockedRunSet());
		expect(beforeOutage.map((card) => card.approvalId)).toEqual([APPROVAL_ID]);
		expect(beforeOutage.every(isUnresolvedApprovalCard)).toBe(true);

		// 2. The stream is live-only: the `approval.resolved` published while the
		//    socket was down never reaches this client, so without the reconcile
		//    the card below would stay exactly as it is.
		const { invalidated, queryClient } = recordingClient();
		reconcileApprovalsAfterReconnect(queryClient, "home:main", beforeOutage);
		expect(invalidated).toEqual([homeRunSetQueryKey("home:main")]);

		// 3. What that re-read returns: the mirror is gone and the parent run is
		//    completed, so the card is no longer rendered pending — with no
		//    manual refresh anywhere in the sequence.
		const afterReconnect = approvalsFromRunSet({
			runs: blockedRunSet().runs.map((run) => ({
				...run,
				status: "completed" as const,
			})),
			approvalMirrors: {},
		});
		expect(afterReconnect).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Image attachments are gated on model capability, not MIME type
// ---------------------------------------------------------------------------

const VISION_REF = "azure-openai/gpt-5.6-sol";
const TEXT_ONLY_REF = "workers-ai/@cf/meta/llama-3.2-3b-instruct";

function catalogModel(
	ref: string,
	imageInput: ModelCatalogModel["imageInput"],
): ModelCatalogModel {
	return {
		ref,
		provider: ref.startsWith("azure") ? "azure-openai" : "workers-ai",
		modelId: ref.split("/").slice(1).join("/"),
		label: `Label for ${ref}`,
		reasoning: true,
		tier: "frontier",
		imageInput,
		governance: ref.startsWith("azure")
			? {
					weightAccess: "closed-weights",
					residencyControl: "customer-provider",
					routingMode: "fixed",
				}
			: {
					weightAccess: "open-weights",
					residencyControl: "cloudflare-network",
					routingMode: "fixed",
				},
		lifecycle: "active",
		selectable: true,
		allowed: true,
		checks: [
			{
				filter: "provider_wired",
				verdict: "allow",
				reason: "provider_wired",
				detail: "Wired on the certified runtime path",
				input: {
					source: "test",
					configured: true,
					expected: null,
					observed: null,
				},
			},
		],
		deniedBy: null,
	};
}

describe("selectedModelImageInput", () => {
	it("uses the org's evaluated catalog row when the ref is listed", () => {
		expect(
			selectedModelImageInput(
				[catalogModel(VISION_REF, "supported")],
				VISION_REF,
			),
		).toBe("supported");
		expect(
			selectedModelImageInput(
				[catalogModel(TEXT_ONLY_REF, "unsupported")],
				TEXT_ONLY_REF,
			),
		).toBe("unsupported");
	});

	it("falls back to the static catalog for a ref the projection did not list", () => {
		expect(selectedModelImageInput([], VISION_REF)).toBe("supported");
		expect(selectedModelImageInput([], TEXT_ONLY_REF)).toBe("unsupported");
	});

	it("is unknown for a custom/uncatalogued deployment and for no selection", () => {
		// An org-configured deployment or the ungated env default: nothing in the
		// repo declares its image support either way.
		expect(selectedModelImageInput([], "azure-openai/acme-private-gpt")).toBe(
			"unknown",
		);
		expect(selectedModelImageInput([], "")).toBe("unknown");
		expect(selectedModelImageInput([], null)).toBe("unknown");
	});

	it("keeps a declared unknown from the projection as unknown", () => {
		const custom = "azure-openai/acme-private-gpt";
		expect(
			selectedModelImageInput([catalogModel(custom, "unknown")], custom),
		).toBe("unknown");
	});
});

describe("imageAttachmentRefusal", () => {
	it("allows an image only when support is DECLARED supported", () => {
		expect(imageAttachmentRefusal("supported", "GPT-5.6 Sol")).toBeNull();
	});

	it("refuses an unsupported model by name, saying the file would be dropped", () => {
		const reason = imageAttachmentRefusal("unsupported", "Llama 3.2 3B");
		expect(reason).toContain("Llama 3.2 3B");
		expect(reason).toContain("cannot read images");
		expect(reason).toContain("never reach the model");
	});

	it("REFUSES unknown with a named reason rather than attach-and-hope", () => {
		// An image the model rejects stays in the durable turn and replays on
		// every later request — the conversation wedges with no client recovery.
		const reason = imageAttachmentRefusal(
			"unknown",
			"acme-private-gpt (custom)",
		);
		expect(reason).not.toBeNull();
		expect(reason).toContain("acme-private-gpt (custom)");
		expect(reason).toContain("does not declare image support");
		expect(reason).toContain("replays");
	});

	it("names the model in all three verdicts an operator can act on", () => {
		const custom = "azure-openai/acme-private-gpt";
		const verdicts = [VISION_REF, TEXT_ONLY_REF, custom].map((ref) =>
			imageAttachmentRefusal(selectedModelImageInput([], ref), ref),
		);
		expect(verdicts[0]).toBeNull();
		expect(verdicts[1]).toContain(TEXT_ONLY_REF);
		expect(verdicts[2]).toContain(custom);
	});
});

describe("composerImageRefusal", () => {
	it("defers to the model verdict once a ref is resolved", () => {
		expect(
			composerImageRefusal({
				models: [catalogModel(VISION_REF, "supported")],
				selectedRef: VISION_REF,
				modelLabel: "Sol",
				selectionPending: false,
			}),
		).toBeNull();
		const refused = composerImageRefusal({
			models: [catalogModel(TEXT_ONLY_REF, "unsupported")],
			selectedRef: TEXT_ONLY_REF,
			modelLabel: "Llama 3.2 3B",
			selectionPending: false,
		});
		expect(refused).toContain("Llama 3.2 3B");
		expect(refused).toContain("cannot read images");
	});

	it("says it is still LOADING while the catalog is in flight", () => {
		const reason = composerImageRefusal({
			models: [],
			selectedRef: null,
			modelLabel: "The selected model",
			selectionPending: true,
		});
		// Fails closed, but does not claim a verdict about a model nobody picked.
		expect(reason).not.toBeNull();
		expect(reason).toContain("still loading");
		expect(reason).not.toContain("does not declare image support");
		expect(reason).not.toContain("The selected model");
	});

	it("says NO MODEL IS RESOLVED when the catalog settled on nothing", () => {
		// The permanent state: the query failed, or the org allows no model. The
		// send would fall through to the server default, and this says so.
		const reason = composerImageRefusal({
			models: [],
			selectedRef: null,
			modelLabel: "The selected model",
			selectionPending: false,
		});
		expect(reason).toContain("No model is resolved");
		expect(reason).toContain("server's default");
		expect(reason).not.toContain("still loading");
		expect(reason).not.toContain("The selected model");
	});
});

// ---------------------------------------------------------------------------
// MOUNTED coverage: the composer wiring itself
//
// Everything above this line is a pure helper. The defects these cover lived
// in the WIRING — which refusal string reaches the alert, which stream drives
// the reconnect reconcile — so they are asserted against a real <ChatThread>.
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "home:main";

function runSetPayload(runSet: Partial<HomeRunSet> = {}) {
	return {
		runSet: {
			organizationId: ORG_ID,
			conversationId: CONVERSATION_ID,
			activeRunIds: [],
			runs: [],
			approvalMirrors: {},
			...runSet,
		} satisfies HomeRunSet,
	};
}

function catalogPayload(models: ModelCatalogModel[], routedRef?: string) {
	return {
		models,
		routing: {
			modelRef: routedRef ?? models[0]?.ref ?? null,
		},
	};
}

const cleanups: Array<() => void> = [];

function mountThread(props: Partial<ComponentProps<typeof ChatThread>> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<ChatThread conversationId={CONVERSATION_ID} {...props} />
			</QueryClientProvider>,
		);
	});
	const rerender = () => {
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<ChatThread conversationId={CONVERSATION_ID} {...props} />
				</QueryClientProvider>,
			);
		});
	};
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return { client, container, rerender };
}

/** One macrotask tick is occasionally not enough for a query to settle. */
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

/**
 * Picks files in the composer's hidden input. `files` is read-only on the
 * element, so it is defined on the instance the way a browser would populate
 * it, then the change event React listens for is dispatched.
 */
function pickFiles(container: Element, files: File[]) {
	const input = container.querySelector('input[aria-label="Attach files"]');
	if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
	Object.defineProperty(input, "files", { value: files, configurable: true });
	act(() => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

function sendButton(container: Element): HTMLButtonElement {
	const button = container.querySelector('button[aria-label="Send message"]');
	if (!(button instanceof HTMLButtonElement)) throw new Error("no send button");
	return button;
}

function dragFiles(
	target: Element,
	type: string,
	files: File[] = [],
	types = ["Files"],
) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const dataTransfer = { files, types, dropEffect: "none" };
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	act(() => {
		target.dispatchEvent(event);
	});
	return { event, dataTransfer };
}

describe("<ChatThread> attachment dropzone", () => {
	it("names local Workers AI without sending an ignored model selection", async () => {
		const mode = vi
			.spyOn(localInference, "isLocalWorkersAi")
			.mockReturnValue(true);
		try {
			const { container } = mountThread();
			await flush();
			expect(container.textContent).toContain("Workers AI · local config");
			pickFiles(container, [imageFile()]);
			await flush();
			expect(attachmentAlert(container)).toContain(
				"image support is not verified",
			);
			typeDraft(container, "Draft an agenda");
			await flush();
			act(() => sendButton(container).click());
			await flush();
			expect(transport.actions.enqueueMessage).toHaveBeenCalledWith(
				expect.objectContaining({ modelRef: undefined }),
			);
		} finally {
			mode.mockRestore();
		}
	});

	it("explains offline mode and blocks button and Enter before preparing a workspace", async () => {
		const mode = vi
			.spyOn(localInference, "isLocalAiUnavailable")
			.mockReturnValue(true);
		try {
			const prepareNewConversation = vi.fn();
			const { container } = mountThread({
				conversationId: null,
				prepareNewConversation,
			});
			await flush();
			typeDraft(container, "Draft an agenda");
			await flush();
			expect(container.textContent).toContain("AI replies are off");
			expect(sendButton(container).disabled).toBe(true);
			pressKey(container, "Enter");
			await flush();
			expect(prepareNewConversation).not.toHaveBeenCalled();
		} finally {
			mode.mockRestore();
		}
	});

	it("restores human text without its transport context after a known rejection", async () => {
		transport.actions.enqueueMessage.mockReset();
		transport.actions.enqueueMessage.mockResolvedValue({
			status: "failed",
			error: "Unavailable",
		});
		const { container } = mountThread({
			context: {
				kind: "workspace",
				id: "44444444-4444-4444-8444-444444444444",
				label: "Audit",
			},
		});
		await flush();
		typeDraft(container, "Draft an agenda");
		await flush();
		act(() => sendButton(container).click());
		await flush();
		expect(
			transport.actions.enqueueMessage.mock.calls[0]?.[0].content,
		).toContain("[[tedix-context:");
		expect(
			container.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Message"]',
			)?.value,
		).toBe("Draft an agenda");
		transport.actions.enqueueMessage.mockReset();
	});
	it("retries the identical contextual request after a dropped send", async () => {
		transport.actions.enqueueMessage.mockReset();
		transport.actions.enqueueMessage.mockRejectedValue(
			new Error("Connection dropped"),
		);
		window.localStorage.setItem(
			chatDraftKey("home:test"),
			"Read connection status",
		);
		const { container } = mountThread({
			conversationId: "home:test",
			context: {
				kind: "workspace",
				id: "44444444-4444-4444-8444-444444444444",
				label: "Audit",
			},
		});
		await flush();
		act(() => sendButton(container).click());
		await flush();
		expect(transport.actions.enqueueMessage).toHaveBeenCalledTimes(1);
		const original = transport.actions.enqueueMessage.mock.calls[0]?.[0];
		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Retry",
		);
		expect(retry).toBeDefined();
		act(() => retry!.click());
		await flush();
		expect(transport.actions.enqueueMessage).toHaveBeenCalledTimes(2);
		expect(transport.actions.enqueueMessage.mock.calls[1]?.[0]).toEqual(
			original,
		);
		expect(original.content.match(/\[\[tedix-context:/g)).toHaveLength(1);
		transport.actions.enqueueMessage.mockReset();
	});

	it("bounds long Workspace and model labels inside the narrow composer", async () => {
		const { container } = mountThread({
			context: {
				kind: "workspace",
				id: "44444444-4444-4444-8444-444444444444",
				label:
					"A deliberately long workspace label that must not collide with the model selector",
			},
		});
		await flush();
		const boundedButtons = [...container.querySelectorAll("button.max-w-32")];
		expect(boundedButtons).toHaveLength(2);
		expect(boundedButtons[0]?.textContent).toContain(
			"A deliberately long workspace label",
		);
		expect(boundedButtons[1]?.textContent).toContain("Label for");
	});

	it("prepares a Workspace before the first general-chat send and carries it into Home", async () => {
		const prepareNewConversation = vi.fn().mockResolvedValue({
			workspaceId: "44444444-4444-4444-8444-444444444444",
		});
		const onConversationCreated = vi.fn();
		const onConversationPrepared = vi.fn();
		transport.actions.enqueueMessage.mockResolvedValueOnce({
			idempotencyKey: RUN_ID,
			conversationId: "home:os:workspace-first",
			status: "queued",
			run: {
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: "home:os:workspace-first",
				status: "queued",
				createdAt: "2026-08-30T18:00:00.000Z",
			},
		} satisfies EnqueueHomeMessageOutput);
		window.localStorage.setItem(
			chatDraftKey(null),
			"Investigate the launch plan",
		);
		const { container } = mountThread({
			conversationId: null,
			prepareNewConversation,
			onConversationCreated,
			onConversationPrepared,
		});
		await flush();
		act(() => sendButton(container).click());
		await flush();
		expect(prepareNewConversation).toHaveBeenCalledWith(
			"Investigate the launch plan",
		);
		expect(transport.actions.enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "Investigate the launch plan",
				workspaceContext: {
					workspaceId: "44444444-4444-4444-8444-444444444444",
				},
			}),
		);
		const preparedConversationId = onConversationPrepared.mock.calls[0]?.[0];
		expect(preparedConversationId).toMatch(/^home:os:/);
		expect(onConversationPrepared).toHaveBeenCalledWith(
			preparedConversationId,
			"44444444-4444-4444-8444-444444444444",
		);
		expect(transport.actions.enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: preparedConversationId }),
		);
		expect(onConversationCreated).toHaveBeenCalledWith(
			"home:os:workspace-first",
			"44444444-4444-4444-8444-444444444444",
		);
	});

	it("stages a dropped image for a vision model without submitting the draft", async () => {
		modelCatalogApi.list.mockResolvedValue(
			catalogPayload([catalogModel(VISION_REF, "supported")]),
		);
		const { container } = mountThread();
		await flush();
		const composer = container.querySelector('[data-slot="chat-composer"]')!;
		const previousSends = transport.actions.enqueueMessage.mock.calls.length;
		dragFiles(composer, "drop", [imageFile()]);
		await flush();
		expect(attachmentAlert(container)).toBeNull();
		expect(container.textContent).toContain("chart.png");
		expect(transport.actions.enqueueMessage.mock.calls.length).toBe(
			previousSends,
		);
		dragFiles(composer, "dragenter");
		dragFiles(composer, "dragend");
		expect(
			container.querySelector('[data-slot="attachment-dropzone"]'),
		).toBeNull();
	});
	it("shows an overlay through nested drag events, stages a dropped file, and sends its bytes", async () => {
		const { container } = mountThread();
		await flush();
		const composer = container.querySelector('[data-slot="chat-composer"]')!;
		const textarea = composer.querySelector("textarea")!;
		expect(dragFiles(composer, "dragenter").event.defaultPrevented).toBe(true);
		expect(container.textContent).toContain("Drop files to attach");
		dragFiles(textarea, "dragenter");
		dragFiles(textarea, "dragleave");
		expect(
			container.querySelector('[data-slot="attachment-dropzone"]'),
		).not.toBeNull();
		expect(dragFiles(composer, "dragover").dataTransfer.dropEffect).toBe(
			"copy",
		);
		dragFiles(composer, "drop", [
			new File(["Hello"], "drop.txt", { type: "text/plain" }),
		]);
		expect(
			container.querySelector('[data-slot="attachment-dropzone"]'),
		).toBeNull();
		expect(sendButton(container).disabled).toBe(true);
		await flush();
		expect(container.textContent).toContain("drop.txt");
		act(() => sendButton(container).click());
		await flush();
		expect(transport.actions.enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				attachments: [
					expect.objectContaining({
						fileName: "drop.txt",
						content: "data:text/plain;base64,SGVsbG8=",
					}),
				],
			}),
		);
	});

	it("leaves text drags alone and clears the overlay when files leave", async () => {
		const { container } = mountThread();
		await flush();
		const composer = container.querySelector('[data-slot="chat-composer"]')!;
		for (const type of ["dragenter", "dragover", "drop"]) {
			expect(
				dragFiles(composer, type, [], ["text/plain"]).event.defaultPrevented,
			).toBe(false);
		}
		expect(
			container.querySelector('[data-slot="attachment-dropzone"]'),
		).toBeNull();
		dragFiles(composer, "dragenter");
		dragFiles(composer, "dragleave");
		expect(
			container.querySelector('[data-slot="attachment-dropzone"]'),
		).toBeNull();
	});

	it("uses the same image-capability and unsupported-file checks as the picker", async () => {
		const { container } = mountThread();
		await flush();
		const composer = container.querySelector('[data-slot="chat-composer"]')!;
		dragFiles(composer, "drop", [imageFile()]);
		expect(attachmentAlert(container)).toContain("cannot read images");
		dragFiles(composer, "drop", [
			new File(["%PDF"], "report.pdf", { type: "application/pdf" }),
		]);
		await flush();
		expect(attachmentAlert(container)).toContain("not supported yet");
	});

	it("enforces five attachments and prevents concurrent picks during preparation", async () => {
		const { container } = mountThread();
		await flush();
		const composer = container.querySelector('[data-slot="chat-composer"]')!;
		const files = Array.from(
			{ length: 6 },
			(_, index) =>
				new File(["text"], `file-${index}.txt`, { type: "text/plain" }),
		);
		dragFiles(composer, "drop", files);
		dragFiles(composer, "dragenter");
		expect(container.textContent).toContain("Preparing attachments");
		expect(dragFiles(composer, "dragover").dataTransfer.dropEffect).toBe(
			"none",
		);
		pickFiles(container, [
			new File(["extra"], "concurrent.txt", { type: "text/plain" }),
		]);
		await flush();
		expect(attachmentAlert(container)).toContain("extra files were not added");
		expect(container.textContent).not.toContain("file-5.txt");
		expect(container.textContent).not.toContain("concurrent.txt");
		expect(container.textContent).toContain(
			"Messages are limited to 5 attachments",
		);
		expect(dragFiles(composer, "dragover").dataTransfer.dropEffect).toBe(
			"none",
		);
		dragFiles(composer, "drop", [files[5]!]);
		expect(
			container.querySelector('[data-slot="attachment-dropzone"]'),
		).toBeNull();
		expect(container.textContent).not.toContain("file-5.txt");
	});
});

function attachmentAlert(container: Element): string | null {
	return (
		container.querySelector('[data-slot="attachment-error"]')?.textContent ??
		null
	);
}

function imageFile(): File {
	return new File(["binary"], "chart.png", { type: "image/png" });
}

beforeEach(() => {
	capabilitiesApi.list.mockReset();
	capabilitiesApi.list.mockResolvedValue({ data: [] });
	skillsApi.listByOrg.mockReset();
	skillsApi.listByOrg.mockResolvedValue({ entries: [], total: 0 });
	tedisApi.list.mockReset();
	tedisApi.list.mockResolvedValue({ data: [] });
	transport.status = "idle";
	kernelRuntimeApi.readMessages.mockReset();
	kernelRuntimeApi.listConversationArtifactPins.mockReset();
	kernelRuntimeApi.listConversationCapabilities.mockReset();
	kernelRuntimeApi.readRunSet.mockReset();
	kernelRuntimeApi.retryRun.mockReset();
	modelCatalogApi.list.mockReset();
	userSettingsApi.getContext.mockReset();
	directReadApi.kernelRuntime.listReadOnlyTools.mockReset();
	kernelRuntimeApi.readMessages.mockResolvedValue({
		messages: [],
		nextCursor: null,
	});
	kernelRuntimeApi.listConversationCapabilities.mockResolvedValue({
		capabilities: [],
	});
	kernelRuntimeApi.listConversationArtifactPins.mockResolvedValue({ pins: [] });
	kernelRuntimeApi.readRunSet.mockResolvedValue(runSetPayload());
	userSettingsApi.getContext.mockResolvedValue({
		organization: { id: ORG_ID },
	});
	modelCatalogApi.list.mockResolvedValue(
		catalogPayload([catalogModel(TEXT_ONLY_REF, "unsupported")]),
	);
	// This runner's happy-dom exposes no localStorage, and the composer reads a
	// draft from it on every mount. A per-test memory store keeps drafts isolated.
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
			clear: () => store.clear(),
			key: (index: number) => [...store.keys()][index] ?? null,
			get length() {
				return store.size;
			},
		},
	});
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("<ChatThread> MCP Apps", () => {
	it("sends a widget follow-up once into the owning conversation", async () => {
		transport.actions.enqueueMessage.mockReset();
		transport.actions.enqueueMessage.mockImplementation(
			() => new Promise(() => {}),
		);
		kernelRuntimeApi.readMessages.mockResolvedValue({
			messages: [
				message({
					metadata: {
						delegatedResult: {
							widgets: [
								{
									resourceUri:
										"ui://widgets/mcp-app/tedix-unified/r/comparison.html",
									toolResult: { items: [{ title: "Bun" }] },
								},
							],
						},
					},
				}),
			],
			nextCursor: null,
		});
		const { container } = mountThread();
		await flush();
		const button = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Widget follow-up",
		);
		expect(button).toBeDefined();
		act(() => button!.click());
		await flush();
		expect(transport.actions.enqueueMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				conversationId: CONVERSATION_ID,
				content: "Tell me more about Bun",
			}),
		);
		transport.actions.enqueueMessage.mockReset();
	});
});

describe("<ChatThread> delegation names", () => {
	it("resolves the recipient through the shared tedi directory", async () => {
		const payload = runSetPayload();
		payload.runSet.activeRunIds = [RUN_ID];
		payload.runSet.runs = [
			{
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: CONVERSATION_ID,
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-run",
				createdAt: "2026-08-26T10:00:00Z",
			},
		];
		kernelRuntimeApi.readRunSet.mockResolvedValue(payload);
		tedisApi.list.mockResolvedValue({
			data: [
				{
					id: "tedi-cto",
					name: "cto",
					displayName: "Chief Technology Officer",
				},
			],
		});
		const { container } = mountThread();
		await flush();
		const card = container.querySelector('[data-slot="delegation-work-card"]');
		expect(card?.textContent).toContain(
			"Delegated to Chief Technology Officer",
		);
		expect(card?.textContent).not.toContain("tedi-cto");
	});
});

describe("<ChatThread> image capability gate", () => {
	it("surfaces unsupported file errors without an unconfirmed send", async () => {
		const { container } = mountThread();
		await flush();
		pickFiles(container, [
			new File(["%PDF"], "report.pdf", { type: "application/pdf" }),
		]);
		expect(sendButton(container).disabled).toBe(true);
		await flush();
		expect(attachmentAlert(container)).toContain("not supported yet");
		expect(container.textContent).not.toContain(
			"Message may not have been sent",
		);
	});

	it("waits for file preparation and retains actual text bytes", async () => {
		const { container } = mountThread();
		await flush();
		pickFiles(container, [
			new File(["Hello"], "notes.txt", { type: "text/plain" }),
		]);
		expect(sendButton(container).disabled).toBe(true);
		await flush();
		expect(sendButton(container).disabled).toBe(false);
		act(() => sendButton(container).click());
		await flush();
		expect(transport.actions.enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				attachments: [
					expect.objectContaining({
						fileName: "notes.txt",
						content: "data:text/plain;base64,SGVsbG8=",
					}),
				],
			}),
		);
	});

	it("refuses an image for the resolved text-only model, by name", async () => {
		const { container } = mountThread();
		await flush();
		pickFiles(container, [imageFile()]);
		const alert = attachmentAlert(container);
		expect(alert).toContain(`Label for ${TEXT_ONLY_REF}`);
		expect(alert).toContain("cannot read images");
		// Filtered at the pick, so nothing rides along into the turn.
		expect(container.textContent).not.toContain("chart.png");
	});

	it("attaches the image when the resolved model DECLARES support", async () => {
		modelCatalogApi.list.mockResolvedValue(
			catalogPayload([catalogModel(VISION_REF, "supported")]),
		);
		const { container } = mountThread();
		await flush();
		pickFiles(container, [imageFile()]);
		await flush();
		expect(attachmentAlert(container)).toBeNull();
		expect(container.textContent).toContain("chart.png");
	});

	it("keeps a non-image attachment even while images are refused", async () => {
		const { container } = mountThread();
		await flush();
		pickFiles(container, [
			imageFile(),
			new File(["notes"], "notes.txt", { type: "text/plain" }),
		]);
		await flush();
		expect(attachmentAlert(container)).toContain("cannot read images");
		expect(container.textContent).toContain("notes.txt");
		expect(container.textContent).not.toContain("chart.png");
	});

	it("says NO MODEL IS RESOLVED — not 'the selected model' — when the catalog fails", async () => {
		// The fail-closed direction is right; the copy was not. With no selection
		// there is nothing the sentence "the selected model does not declare
		// image support" could truthfully be about.
		modelCatalogApi.list.mockRejectedValue(new Error("catalog unavailable"));
		const { container } = mountThread();
		await flush();
		pickFiles(container, [imageFile()]);
		const alert = attachmentAlert(container);
		expect(alert).toContain("No model is resolved");
		expect(alert).not.toContain("The selected model does not declare");
		expect(container.textContent).not.toContain("chart.png");
	});

	it("says it is still loading while the catalog query is in flight", () => {
		// No flush: this is the first paint, the state an operator actually meets.
		const { container } = mountThread();
		pickFiles(container, [imageFile()]);
		expect(attachmentAlert(container)).toContain("still loading");
	});

	it("blocks the send when an ATTACHED image stops being allowed", async () => {
		// The pick-time filter cannot catch this one: the image was attached
		// while the model declared support, and a later catalog evaluation says
		// otherwise. Sending anyway wedges the conversation, so Send goes down
		// and the same named reason is shown.
		modelCatalogApi.list.mockResolvedValue(
			catalogPayload([catalogModel(VISION_REF, "supported")]),
		);
		const { client, container } = mountThread();
		await flush();
		pickFiles(container, [imageFile()]);
		await flush();
		expect(container.textContent).toContain("chart.png");
		expect(sendButton(container).disabled).toBe(false);

		modelCatalogApi.list.mockResolvedValue(
			catalogPayload([catalogModel(VISION_REF, "unsupported")]),
		);
		await act(async () => {
			await client.invalidateQueries();
		});
		await flush();
		expect(attachmentAlert(container)).toContain("cannot read images");
		expect(sendButton(container).disabled).toBe(true);
	});
});

describe("<ChatThread> reconnect reconciliation", () => {
	function mountWithPendingApproval() {
		kernelRuntimeApi.readRunSet.mockResolvedValue(
			runSetPayload(blockedRunSet()),
		);
		return mountThread();
	}

	it("re-reads the run set when THIS conversation's stream comes back", async () => {
		const { rerender } = mountWithPendingApproval();
		await flush();
		const before = kernelRuntimeApi.readRunSet.mock.calls.length;
		transport.status = "reconnecting";
		rerender();
		await flush();
		transport.status = "open";
		rerender();
		await flush();
		// The aggregate is pinned to `connecting` for every test in this file, so
		// this can only have fired off the conversation's own stream status.
		expect(REALTIME_AGGREGATE.status).toBe("connecting");
		expect(kernelRuntimeApi.readRunSet.mock.calls.length).toBeGreaterThan(
			before,
		);
	});

	it("re-reads a cached pending card on the FIRST connect", async () => {
		const { rerender } = mountWithPendingApproval();
		await flush();
		const before = kernelRuntimeApi.readRunSet.mock.calls.length;
		transport.status = "connecting";
		rerender();
		await flush();
		transport.status = "open";
		rerender();
		await flush();
		// The query can be retained from an earlier visit while the decision is
		// resolved by the CLI or another tab. First-open is therefore a
		// convergence boundary too, not proof that the cached row is current.
		expect(kernelRuntimeApi.readRunSet.mock.calls.length).toBeGreaterThan(
			before,
		);
	});
});

// ---------------------------------------------------------------------------
// Composer skill picker
//
// The pure trigger/scope/draft-editing rules live in
// `src/lib/chat-skill-picker.test.ts`. What is asserted here is the WIRING: that
// a slash opens the picker, that plain slash text still submits, that a pill
// removes its own durable reference, and that the catalog is re-read per open
// rather than cached for the life of the conversation.
// ---------------------------------------------------------------------------

function composerTextarea(container: Element): HTMLTextAreaElement {
	const textarea = container.querySelector("textarea");
	if (!(textarea instanceof HTMLTextAreaElement))
		throw new Error("no composer");
	return textarea;
}

/** Type as a browser does: React listens for `input` on the native setter. */
function typeDraft(container: Element, value: string) {
	const textarea = composerTextarea(container);
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(textarea, value);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function pressKey(
	container: Element,
	key: string,
	init: KeyboardEventInit = {},
) {
	act(() => {
		composerTextarea(container).dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key, ...init }),
		);
	});
}

function pickerOptions(container: Element): HTMLElement[] {
	return [...container.querySelectorAll('[role="option"]')].filter(
		(node): node is HTMLElement => node instanceof HTMLElement,
	);
}

const REACHABLE_SKILL = {
	id: "skill-deploy",
	organizationId: ORG_ID,
	title: "Deploy runbook",
	slug: "deploy-runbook",
	summary: "How a surface ships.",
	content: "…",
	tediId: null,
	visibility: "org" as const,
	lifecycleState: "active" as const,
	paceLayer: "differentiation" as const,
	successCount: 0,
	failureCount: 0,
	revision: 1,
};

describe("<ChatThread> skill picker", () => {
	it("opens on a slash and offers only skills the turn can reach", async () => {
		skillsApi.listByOrg.mockResolvedValue({
			entries: [
				REACHABLE_SKILL,
				// The admin lens returns these; a Home turn resolves neither.
				{ ...REACHABLE_SKILL, id: "p", slug: "secret", visibility: "private" },
				{ ...REACHABLE_SKILL, id: "t", slug: "owned", tediId: "tedi-cto" },
			],
			total: 3,
		});
		const { container } = mountThread();
		await flush();
		expect(pickerOptions(container)).toHaveLength(0);

		typeDraft(container, "/");
		await flush();
		const options = pickerOptions(container);
		expect(options).toHaveLength(1);
		expect(options[0]?.textContent).toContain("Deploy runbook");
	});

	it("submits plain slash text instead of confirming a pick", async () => {
		skillsApi.listByOrg.mockResolvedValue({
			entries: [REACHABLE_SKILL],
			total: 1,
		});
		transport.actions.enqueueMessage.mockReset();
		transport.actions.enqueueMessage.mockResolvedValue({
			message: message({ id: "m-plain" }),
		});
		const { container } = mountThread();
		await flush();

		// A slash token that happens to match. Enter has not been preceded by any
		// explicit highlight, so it is a send, not a confirmation.
		typeDraft(container, "/deploy");
		await flush();
		expect(pickerOptions(container)).toHaveLength(1);
		pressKey(container, "Enter");
		await flush();

		expect(transport.actions.enqueueMessage).toHaveBeenCalledTimes(1);
		expect(transport.actions.enqueueMessage.mock.calls[0]?.[0]?.content).toBe(
			"/deploy",
		);
	});

	it("confirms a highlighted skill into a durable reference and a pill", async () => {
		skillsApi.listByOrg.mockResolvedValue({
			entries: [REACHABLE_SKILL],
			total: 1,
		});
		const { container } = mountThread();
		await flush();

		typeDraft(container, "ship it\n/dep");
		await flush();
		pressKey(container, "ArrowDown");
		pressKey(container, "Enter");
		await flush();

		expect(composerTextarea(container).value).toBe(
			"/skill deploy-runbook\n\nship it",
		);
		const pills = container.querySelector('[data-slot="skill-pills"]');
		expect(pills?.textContent).toContain("Deploy runbook");
	});

	it("removes the reference when its pill is removed", async () => {
		skillsApi.listByOrg.mockResolvedValue({
			entries: [REACHABLE_SKILL],
			total: 1,
		});
		const { container } = mountThread();
		await flush();
		typeDraft(container, "/dep");
		await flush();
		pressKey(container, "ArrowDown");
		pressKey(container, "Enter");
		await flush();
		expect(composerTextarea(container).value).toContain(
			"/skill deploy-runbook",
		);

		const remove = container.querySelector(
			'button[aria-label="Remove Deploy runbook"]',
		);
		if (!(remove instanceof HTMLButtonElement))
			throw new Error("no pill button");
		act(() => remove.click());
		await flush();

		expect(composerTextarea(container).value).toBe("");
		expect(container.querySelector('[data-slot="skill-pills"]')).toBeNull();
	});

	it("re-reads the catalog on every open, so a new skill is not invisible", async () => {
		skillsApi.listByOrg.mockResolvedValue({ entries: [], total: 0 });
		const { container } = mountThread();
		await flush();

		typeDraft(container, "/");
		await flush();
		expect(skillsApi.listByOrg).toHaveBeenCalledTimes(1);
		expect(pickerOptions(container)).toHaveLength(0);

		// A skill recorded between the two opens.
		skillsApi.listByOrg.mockResolvedValue({
			entries: [REACHABLE_SKILL],
			total: 1,
		});
		typeDraft(container, "");
		await flush();
		typeDraft(container, "/");
		await flush();

		expect(skillsApi.listByOrg).toHaveBeenCalledTimes(2);
		expect(pickerOptions(container)).toHaveLength(1);
	});

	it("shows a failed read as a failure, never as an empty library", async () => {
		skillsApi.listByOrg.mockRejectedValue(new Error("D1 unavailable"));
		const { container } = mountThread();
		await flush();

		typeDraft(container, "/");
		await flush();

		const picker = container.querySelector('[data-slot="skill-picker"]');
		expect(picker?.textContent).toContain("Couldn't load skills");
		expect(pickerOptions(container)).toHaveLength(0);
	});
});

/**
 * Stick-to-bottom follows EVERY source of transcript height. It once listed
 * only durable messages and overlays, so a provisional send or an approval
 * card grew the column without re-running it, leaving a pinned reader above
 * their own optimistic bubble. happy-dom lays nothing out, so the transcript's
 * scrollHeight is supplied by the test and scrollTop is recorded.
 */
describe("<ChatThread> first-send reveal", () => {
	it("adopts the confirmed conversation without losing or duplicating the first turn", async () => {
		transport.actions.enqueueMessage.mockReset();
		let resolveSend!: (value: EnqueueHomeMessageOutput) => void;
		transport.actions.enqueueMessage.mockReturnValue(
			new Promise((resolve) => {
				resolveSend = resolve;
			}),
		);
		const props: Partial<ComponentProps<typeof ChatThread>> = {
			conversationId: null,
			composerOnly: true,
			onConversationCreated: vi.fn(),
		};
		const { container, rerender } = mountThread(props);
		await flush();
		typeDraft(container, "One first turn");
		act(() => sendButton(container).click());
		await flush();
		props.composerOnly = false;
		rerender();
		await flush();
		const input = transport.actions.enqueueMessage.mock.calls[0]![0];
		const output: EnqueueHomeMessageOutput = {
			idempotencyKey: input.idempotencyKey,
			conversationId: input.conversationId,
			status: "queued",
			run: {
				id: input.idempotencyKey,
				organizationId: ORG_ID,
				conversationId: input.conversationId,
				status: "queued",
				createdAt: "2026-10-03T10:00:00.000Z",
			},
		};
		act(() => resolveSend(output));
		await flush();
		expect(props.onConversationCreated).toHaveBeenCalledWith(
			input.conversationId,
			undefined,
		);
		props.conversationId = input.conversationId;
		rerender();
		await flush();
		expect(
			container.querySelector('[data-slot="provisional-user-message"]'),
		).toBeNull();
		expect(container.querySelectorAll('li[data-role="user"]')).toHaveLength(1);
		expect(
			container.querySelector('li[data-role="user"]')?.textContent,
		).toContain("One first turn");
		expect(transport.actions.enqueueMessage).toHaveBeenCalledOnce();
		transport.actions.enqueueMessage.mockReset();
	});
	it("keeps the optimistic turn and rejection state when revealing the list composer", async () => {
		transport.actions.enqueueMessage.mockReset();
		let resolveSend!: (value: unknown) => void;
		transport.actions.enqueueMessage.mockReturnValue(
			new Promise((resolve) => {
				resolveSend = resolve;
			}),
		);
		const props: Partial<ComponentProps<typeof ChatThread>> = {
			conversationId: null,
			composerOnly: true,
			context: {
				kind: "workspace",
				id: "44444444-4444-4444-8444-444444444444",
				label: "Audit",
			},
			onSendStarted: vi.fn(),
		};
		const { container, rerender } = mountThread(props);
		await flush();
		typeDraft(container, "First message stays visible");
		act(() => sendButton(container).click());
		await flush();
		expect(props.onSendStarted).toHaveBeenCalledOnce();
		props.composerOnly = false;
		rerender();
		await flush();
		expect(
			container.querySelector('[data-provisional-state="sending"]')
				?.textContent,
		).toContain("First message stays visible");
		expect(container.textContent).not.toContain("[[tedix-context:");
		expect(transport.actions.enqueueMessage).toHaveBeenCalledOnce();
		act(() => resolveSend({ status: "failed", error: "Unavailable" }));
		await flush();
		expect(container.textContent).toContain("Unavailable");
		expect(
			container.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Message"]',
			)?.value,
		).toBe("First message stays visible");
		expect(
			container.querySelector('[data-slot="provisional-user-message"]'),
		).toBeNull();
		transport.actions.enqueueMessage.mockReset();
	});
});

describe("<ChatThread> autoscroll", () => {
	const metrics = { scrollHeight: 0 };
	const scrollTops = new WeakMap<Element, number>();
	const originals = (["scrollHeight", "scrollTop"] as const).map(
		(key) =>
			[key, Object.getOwnPropertyDescriptor(Element.prototype, key)] as const,
	);
	beforeEach(() => {
		Object.defineProperty(Element.prototype, "scrollHeight", {
			configurable: true,
			get: () => metrics.scrollHeight,
		});
		Object.defineProperty(Element.prototype, "scrollTop", {
			configurable: true,
			get(this: Element) {
				return scrollTops.get(this) ?? 0;
			},
			set(this: Element, value: number) {
				scrollTops.set(this, value);
			},
		});
	});
	afterEach(() => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(Element.prototype, key, descriptor);
		}
		metrics.scrollHeight = 0;
	});
	const transcript = (container: Element) =>
		container.querySelector('[data-slot="conversation-transcript"]')!;

	it("follows a provisional send", async () => {
		transport.actions.enqueueMessage.mockReturnValue(new Promise(() => {}));
		const { container } = mountThread();
		await flush();
		metrics.scrollHeight = 1200;
		typeDraft(container, "Where are we on launch prep?");
		act(() => sendButton(container).click());
		await flush();
		expect(container.textContent).toContain("Where are we on launch prep?");
		expect(transcript(container).scrollTop).toBe(1200);
	});

	it("follows an approval card derived from the run set", async () => {
		const { client, container } = mountThread();
		await flush();
		metrics.scrollHeight = 2400;
		kernelRuntimeApi.readRunSet.mockResolvedValue(
			runSetPayload(blockedRunSet()),
		);
		await act(async () => {
			await client.invalidateQueries();
		});
		await flush();
		expect(transcript(container).scrollTop).toBe(2400);
	});

	it("re-observes transcript resizes per conversation and cleans up", async () => {
		const observers: Array<{ observed: Element[]; disconnected: boolean }> = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				record = { observed: [] as Element[], disconnected: false };
				constructor() {
					observers.push(this.record);
				}
				observe(element: Element) {
					this.record.observed.push(element);
				}
				disconnect() {
					this.record.disconnected = true;
				}
				unobserve() {}
			},
		);
		try {
			const first = mountThread();
			await flush();
			const transcriptObservers = () =>
				observers.filter((observer) =>
					observer.observed.some(
						(element) =>
							element.getAttribute("data-slot") === "conversation-transcript",
					),
				);
			expect(transcriptObservers()).toHaveLength(1);
			cleanups.splice(0).forEach((cleanup) => cleanup());
			expect(transcriptObservers()[0]?.disconnected).toBe(true);
			expect(first.container.isConnected).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
