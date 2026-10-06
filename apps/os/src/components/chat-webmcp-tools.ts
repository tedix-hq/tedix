import {
	isLocalAiUnavailable,
	LOCAL_AI_UNAVAILABLE,
} from "@/lib/local-inference";
// The schema module is pure zod — safe at module scope (the import-inertness
// rule bans only the app-bootstrap modules).
import { EnqueueHomeMessageInputSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import type {
	EnqueueHomeMessageInput,
	EnqueueHomeMessageOutput,
	HomeConversation,
	HomePlanAssignmentApprovalResult,
	HomeRun,
	RespondHomeApprovalInput,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { TediType } from "@tedix/api-contract/schemas/tedi";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import { deriveToolSchema } from "@/lib/webmcp/derive-schema";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";

/**
 * WebMCP tools for the OS Chat surface: kernel Home conversations plus
 * explicit delegation to a tedi. A browser agent gets the same verbs the
 * visible UI has (send, list) plus one it does not — `delegateToTediId` is in
 * the enqueue contract but has no UI affordance yet, so
 * `delegate_task_to_tedi` is the only way to route a turn straight to a
 * worker.
 *
 * Reads go through `osApi` directly (no cache writes); the one cache touch is
 * invalidating the sidebar's conversations key after a successful send, so the
 * human watches the thread appear live. Deep links land on `/chat`.
 */

const CHAT_DEEP_LINK = "/chat";

/**
 * Derived from the enqueue contract: `content` stays required and every
 * exposed key tracks the contract shape. The pick list is the tool's
 * deliberate exposure subset — model routing, attachments, and workspace
 * context stay UI-only.
 */
const SEND_CHAT_MESSAGE_SCHEMA = deriveToolSchema(
	EnqueueHomeMessageInputSchema,
	{
		pick: ["content", "conversationId", "delegateToTediId", "idempotencyKey"],
		override: {
			content: { description: "The message text to send." },
			conversationId: {
				description:
					"Existing conversation id (see list_conversations). Omit to start a NEW conversation; use 'home:main' for the org's main Home thread.",
			},
			delegateToTediId: {
				description:
					"Optional tedi id (see list_tedis) to route this turn to that digital worker.",
			},
			idempotencyKey: {
				description:
					"Optional stable retry key. Reuse the same value after an uncertain timeout to prevent duplicate sends.",
			},
		},
		additionalProperties: false,
	},
);

const executeArgs = (options?: WebMcpToolExecuteOptions) =>
	options?.signal ? ([options] as const) : ([] as const);

/**
 * Mint an OS-owned conversation id for a new thread. Mirrors
 * `newHomeConversationId` in chat-thread.tsx (not imported: that module drags
 * the whole thread UI into every consumer). An OMITTED id is meaningful to the
 * API — it selects the caller's default Home thread — so "start a new
 * conversation" must always send an explicit fresh id.
 */
function mintConversationId(randomUuid: () => string): string {
	return `home:os:${randomUuid()}`;
}

/** Injectable seams; production uses the app singletons via {@link useChatWebMcpTools}. */
export interface ChatWebMcpDeps {
	enqueueMessage: (
		input: EnqueueHomeMessageInput,
		options?: WebMcpToolExecuteOptions,
	) => Promise<EnqueueHomeMessageOutput>;
	listTedis: (
		options?: WebMcpToolExecuteOptions,
	) => Promise<{ data: TediType[] }>;
	listConversations: (
		input: {
			limit?: number;
		},
		options?: WebMcpToolExecuteOptions,
	) => Promise<{ conversations: HomeConversation[] }>;
	readRun: (
		input: { runId: string },
		options?: WebMcpToolExecuteOptions,
	) => Promise<{ run: HomeRun }>;
	respondApproval: (
		input: RespondHomeApprovalInput,
		options?: WebMcpToolExecuteOptions,
	) => Promise<{
		run: HomeRun;
		assignments: HomePlanAssignmentApprovalResult[];
	}>;
	/** Called after a successful send so the sidebar list refetches. */
	invalidateConversations: () => void;
	randomUuid: () => string;
}

/**
 * Memoized loader for the production singletons. Deliberately dynamic:
 * `@/lib/api` reads `window.location` at module scope (breaks node-env tests
 * that reach this module through a host component), and `@/router` /
 * `@/components/chat-sidebar` drag the route tree and sidebar UI into any
 * narrowly-mocked suite. Loading them on first tool execution keeps this
 * module import-inert; `vi.mock` still intercepts the dynamic imports.
 */
let defaultDepsPromise: Promise<ChatWebMcpDeps> | null = null;
function loadDefaultDeps(): Promise<ChatWebMcpDeps> {
	defaultDepsPromise ??= Promise.all([
		import("@/lib/api"),
		import("@/router"),
		import("@/components/chat-sidebar"),
	]).then(([api, router, sidebar]) => ({
		enqueueMessage: (input, options) =>
			api.osChatMutationApi.kernelRuntime.enqueueMessage(
				input,
				...executeArgs(options),
			),
		listTedis: (options) =>
			api.osChatReadApi.tedis.list({}, ...executeArgs(options)),
		listConversations: (input, options) =>
			api.osChatReadApi.kernelRuntime.listConversations(
				input,
				...executeArgs(options),
			),
		readRun: (input, options) =>
			api.osChatReadApi.kernelRuntime.readRun(input, ...executeArgs(options)),
		respondApproval: (input, options) =>
			api.osChatMutationApi.kernelRuntime.respondApproval(
				input,
				...executeArgs(options),
			),
		invalidateConversations: () => {
			void router.osQueryClient.invalidateQueries({
				queryKey: sidebar.CHAT_CONVERSATIONS_QUERY_KEY,
			});
		},
		randomUuid: () => crypto.randomUUID(),
	}));
	return defaultDepsPromise;
}

function tediRosterRow(tedi: TediType) {
	return {
		id: tedi.id,
		slug: tedi.slug,
		name: tedi.name,
		displayName: tedi.displayName,
		status: tedi.status,
	};
}

async function availableTedis(
	deps: ChatWebMcpDeps,
	options?: WebMcpToolExecuteOptions,
) {
	const { data } = await deps.listTedis(...executeArgs(options));
	return data.map(tediRosterRow);
}

async function sendHomeMessage(
	deps: ChatWebMcpDeps,
	args: {
		content: string;
		conversationId?: string;
		delegateToTediId?: string;
		idempotencyKey?: string;
	},
	options?: WebMcpToolExecuteOptions,
) {
	if (isLocalAiUnavailable()) return webMcpError(LOCAL_AI_UNAVAILABLE);
	const conversationId =
		args.conversationId ?? mintConversationId(deps.randomUuid);
	const output = await deps.enqueueMessage(
		{
			conversationId,
			content: args.content,
			idempotencyKey: args.idempotencyKey ?? deps.randomUuid(),
			delegateToTediId: args.delegateToTediId,
		},
		...executeArgs(options),
	);
	if (output.status === "failed" || output.run.status === "failed") {
		return webMcpError(
			output.error ?? "The kernel could not accept the message.",
		);
	}
	// The enqueue contract also uses needs_delegation for terminal Home turns.
	// The durable run status distinguishes an answer from a worker selection.
	const terminal =
		output.run.status === "completed" || output.run.status === "canceled";
	if (output.status === "needs_delegation" && !terminal) {
		// Not an error: the kernel wants an explicit worker. Hand the agent the
		// roster so it can retry with delegateToTediId (or delegate_task_to_tedi).
		return webMcpResult(
			{
				conversationId: output.conversationId,
				status: output.status,
				hint: "Pick a tedi and re-send with delegateToTediId, or call delegate_task_to_tedi with its slug.",
				availableTedis: await availableTedis(deps),
			},
			CHAT_DEEP_LINK,
		);
	}
	deps.invalidateConversations();
	return webMcpResult(
		{
			conversationId: output.conversationId,
			idempotencyKey: output.idempotencyKey,
			status: terminal ? output.run.status : output.status,
			runId: output.run.id,
			...(terminal && output.assistantMessage
				? { content: output.assistantMessage.content }
				: {}),
		},
		CHAT_DEEP_LINK,
	);
}

/**
 * Pure tool-set builder, exported for tests. Every `execute` resolves — API
 * failures come back as `webMcpError`, never as a thrown rejection.
 */
export function buildChatWebMcpTools(
	explicitDeps?: ChatWebMcpDeps,
): WebMcpToolDef[] {
	const resolveDeps = (): Promise<ChatWebMcpDeps> =>
		explicitDeps ? Promise.resolve(explicitDeps) : loadDefaultDeps();
	return [
		{
			name: "respond_home_approval",
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			description:
				"Approve or reject the action, delegation, workstation attachment, or plan that a Tedix Home run is waiting on. The server resolves the pending target from the run and applies the decision exactly once.",
			inputSchema: {
				type: "object",
				properties: {
					runId: {
						type: "string",
						description: "Parent Home run id shown by the approval card.",
					},
					decision: {
						type: "string",
						enum: ["approve", "reject"],
					},
					assignmentIds: {
						type: "array",
						items: { type: "string" },
						description:
							"Optional subset of assignment ids when responding to a proposed Home plan.",
					},
					note: {
						type: "string",
						description: "Optional operator note, up to 2000 characters.",
					},
				},
				required: ["runId", "decision"],
				additionalProperties: false,
			},
			execute: async (args, executeOptions) => {
				try {
					const runId = args["runId"];
					const decision = args["decision"];
					if (typeof runId !== "string" || runId.trim() === "") {
						return webMcpError(
							"runId is required and must be a non-empty string.",
						);
					}
					if (decision !== "approve" && decision !== "reject") {
						return webMcpError("decision must be either approve or reject.");
					}
					const assignmentIds = args["assignmentIds"];
					if (
						assignmentIds !== undefined &&
						(!Array.isArray(assignmentIds) ||
							assignmentIds.some((id) => typeof id !== "string" || id === ""))
					) {
						return webMcpError(
							"assignmentIds must be an array of non-empty strings.",
						);
					}
					const note = args["note"];
					if (note !== undefined && typeof note !== "string") {
						return webMcpError("note must be a string.");
					}
					const output = await (
						await resolveDeps()
					).respondApproval(
						{
							runId,
							decision,
							assignmentIds: assignmentIds as string[] | undefined,
							note,
						},
						...executeArgs(executeOptions),
					);
					return webMcpResult(
						{
							runId: output.run.id,
							conversationId: output.run.conversationId,
							status: output.run.status,
							childRunId: output.run.childRunId ?? null,
							delegatedTediId: output.run.delegatedTediId ?? null,
							assignments: output.assignments,
						},
						CHAT_DEEP_LINK,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "send_chat_message",
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			description:
				"Send a message into a Tedix Home chat conversation — the org's kernel routes it, and the human sees the conversation update live in the Chat page. Omit conversationId to start a new conversation; tedis (the org's durable AI digital workers) can be targeted via delegateToTediId.",
			inputSchema: SEND_CHAT_MESSAGE_SCHEMA,
			execute: async (args, executeOptions) => {
				try {
					const content = args["content"];
					if (typeof content !== "string" || content.trim() === "") {
						return webMcpError(
							"content is required and must be a non-empty string.",
						);
					}
					return await sendHomeMessage(
						await resolveDeps(),
						{
							content,
							conversationId:
								typeof args["conversationId"] === "string"
									? args["conversationId"]
									: undefined,
							delegateToTediId:
								typeof args["delegateToTediId"] === "string"
									? args["delegateToTediId"]
									: undefined,
							idempotencyKey:
								typeof args["idempotencyKey"] === "string" &&
								args["idempotencyKey"].trim() !== ""
									? args["idempotencyKey"]
									: undefined,
						},
						...executeArgs(executeOptions),
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "delegate_task_to_tedi",
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			description:
				"Delegate a task to one of the org's tedis (durable AI digital workers) by slug — the task is sent as a chat turn routed to that worker, and the human sees the conversation update live in the Chat page.",
			inputSchema: {
				type: "object",
				properties: {
					task: {
						type: "string",
						description: "The task to hand to the tedi, as plain text.",
					},
					tediSlug: {
						type: "string",
						description: "Slug of the tedi to delegate to (see list_tedis).",
					},
					conversationId: {
						type: "string",
						description:
							"Existing conversation id to continue in. Omit to start a NEW conversation for this task.",
					},
					idempotencyKey: {
						type: "string",
						description:
							"Optional stable retry key. Reuse the same value after an uncertain timeout to prevent duplicate delegations.",
					},
				},
				required: ["task", "tediSlug"],
				additionalProperties: false,
			},
			execute: async (args, executeOptions) => {
				try {
					const task = args["task"];
					const tediSlug = args["tediSlug"];
					if (typeof task !== "string" || task.trim() === "") {
						return webMcpError(
							"task is required and must be a non-empty string.",
						);
					}
					if (typeof tediSlug !== "string" || tediSlug.trim() === "") {
						return webMcpError("tediSlug is required (see list_tedis).");
					}
					const deps = await resolveDeps();
					const { data } = await deps.listTedis(...executeArgs(executeOptions));
					const tedi = data.find((t) => t.slug === tediSlug);
					if (!tedi) {
						const slugs = data.map((t) => t.slug).join(", ");
						return webMcpError(
							`Unknown tedi slug "${tediSlug}". Valid slugs: ${slugs || "(none — this organization has no live tedis)"}.`,
						);
					}
					return await sendHomeMessage(
						deps,
						{
							content: task,
							conversationId:
								typeof args["conversationId"] === "string"
									? args["conversationId"]
									: undefined,
							delegateToTediId: tedi.id,
							idempotencyKey:
								typeof args["idempotencyKey"] === "string" &&
								args["idempotencyKey"].trim() !== ""
									? args["idempotencyKey"]
									: undefined,
						},
						...executeArgs(executeOptions),
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "get_chat_run_status",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			description:
				"Read the durable outcome of a Home chat or delegated tedi run after send_chat_message or delegate_task_to_tedi returns its runId.",
			inputSchema: {
				type: "object",
				properties: {
					runId: {
						type: "string",
						description: "Run id returned by a Chat mutation.",
					},
				},
				required: ["runId"],
				additionalProperties: false,
			},
			execute: async (args, executeOptions) => {
				try {
					const runId = args["runId"];
					if (typeof runId !== "string" || runId.trim() === "") {
						return webMcpError(
							"runId is required and must be a non-empty string.",
						);
					}
					const { run } = await (
						await resolveDeps()
					).readRun({ runId }, ...executeArgs(executeOptions));
					return webMcpResult(
						{
							runId: run.id,
							conversationId: run.conversationId,
							status: run.status,
							progress: run.progress ?? null,
							childRunId: run.childRunId ?? null,
							delegatedTediId: run.delegatedTediId ?? null,
							completedAt: run.completedAt ?? null,
						},
						CHAT_DEEP_LINK,
					);
				} catch (error) {
					return webMcpError(
						error instanceof Error ? error.message : String(error),
					);
				}
			},
		},
		{
			name: "list_tedis",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			description:
				"List the organization's live tedis — its durable AI digital workers — with the slug and id used to delegate chat turns to them.",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async (_args, executeOptions) => {
				try {
					return webMcpResult({
						tedis: await availableTedis(await resolveDeps(), executeOptions),
					});
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "list_conversations",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			description:
				"List the organization's Home chat conversations so an existing thread can be continued in the Chat page.",
			inputSchema: {
				type: "object",
				properties: {
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 500,
						description: "Maximum conversations to return.",
					},
				},
				additionalProperties: false,
			},
			execute: async (args, executeOptions) => {
				try {
					const limit =
						typeof args["limit"] === "number" ? args["limit"] : undefined;
					const deps = await resolveDeps();
					const { conversations } = await deps.listConversations(
						limit === undefined ? {} : { limit },
						...executeArgs(executeOptions),
					);
					return webMcpResult(
						{
							conversations: conversations.map((conversation) => ({
								conversationId: conversation.id,
								title: conversation.title ?? null,
								status: conversation.status,
								lastMessageAt: conversation.lastMessageAt ?? null,
								messageCount: conversation.messageCount ?? null,
							})),
						},
						CHAT_DEEP_LINK,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
	];
}

/** Register the Chat scope's WebMCP tools for the lifetime of the Chat page. */
export function useChatWebMcpTools(): void {
	// Deps are module singletons — nothing to re-register on.
	useWebMcpTools("chat", () => buildChatWebMcpTools(), []);
}
