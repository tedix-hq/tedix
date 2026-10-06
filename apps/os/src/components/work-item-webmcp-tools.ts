import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { WorkFactoryProjectionCursorSchema } from "@tedix/api-contract/schemas/work-items";
import * as z from "zod";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
	WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";
import { deriveToolSchema } from "@/lib/webmcp/derive-schema";

/**
 * Context-bound WebMCP tools for the work-item detail page: the tools close
 * over the item the human is currently looking at, so an in-page agent reads
 * and comments on exactly that item without ever taking an id argument. The
 * scope key includes the id, so navigating between items replaces the scope.
 *
 * Read-only except for comments; there is no accept/start/settle/decide tool.
 *
 * `@/lib/api` reads `window.location` at module scope, so it (and
 * `@/lib/os-query-options`, which imports it) is loaded lazily at execute
 * time. This keeps the component tree importable in a node test environment.
 */

type ApiModule = typeof import("@/lib/api");
type OptionsModule = typeof import("@/lib/os-query-options");

interface WorkItemWebMcpRuntime {
	api: ApiModule;
	options: OptionsModule;
}

let runtime: Promise<WorkItemWebMcpRuntime> | null = null;

const clientOptions = (options?: WebMcpToolExecuteOptions) =>
	options?.signal ? ([{ signal: options.signal }] as const) : ([] as const);
const loadRuntime = (): Promise<WorkItemWebMcpRuntime> =>
	(runtime ??= Promise.all([
		import("@/lib/api"),
		import("@/lib/os-query-options"),
	]).then(([api, options]) => ({ api, options })));

const EVENT_PAYLOAD_SUMMARY_LENGTH = 200;
const attemptPageSchema = z
	.object({ cursor: WorkFactoryProjectionCursorSchema.optional() })
	.strict();

export interface WorkItemWebMcpDeps {
	queryClient: QueryClient;
}

function summarizePayload(payload: unknown): string {
	const text = JSON.stringify(payload) ?? "";
	return text.length > EVENT_PAYLOAD_SUMMARY_LENGTH
		? `${text.slice(0, EVENT_PAYLOAD_SUMMARY_LENGTH)}…`
		: text;
}

/** Build the work-item-scope WebMCP tool set. Pure so tests can drive execute(). */
export function buildWorkItemWebMcpTools(
	itemId: string,
	deps: WorkItemWebMcpDeps,
): WebMcpToolDef[] {
	const { queryClient } = deps;
	const deepLink = `/work/items/${itemId}`;

	const getCurrentWorkItem: WebMcpToolDef = {
		name: "get_current_work_item",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Read the work item currently open on this page — title, state, acceptance claims, readiness verdict, and the latest comments.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api } = await loadRuntime();
				const [{ workItem, comments }, readiness] = await Promise.all([
					api.osApi.workItems.getById(
						{ id: itemId },
						...clientOptions(executeOptions),
					),
					api.osApi.workItems.getReadiness(
						{ id: itemId },
						...clientOptions(executeOptions),
					),
				]);
				return webMcpResult(
					{
						id: workItem.id,
						title: workItem.title,
						disposition: workItem.disposition,
						workKind: workItem.workKind,
						workClass: workItem.workClass,
						doneLooksLike: workItem.acceptanceContract?.doneLooksLike ?? null,
						readiness: {
							state: readiness.state,
							ready: readiness.ready,
							reasons: readiness.reasons.map((reason) => ({
								code: reason.code,
								detail: reason.detail,
							})),
						},
						commentsCount: comments.length,
						latestComments: comments.slice(-3).map((comment) => ({
							authorType: comment.authorType,
							body:
								comment.body.length > 300
									? `${comment.body.slice(0, 300)}…`
									: comment.body,
							createdAt: comment.createdAt,
						})),
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const commentCurrentWorkItem: WebMcpToolDef = {
		name: "comment_current_work_item",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Add a comment to the work item currently open on this page; it appears immediately in the thread the human is reading.",
		inputSchema: {
			type: "object",
			properties: {
				body: {
					type: "string",
					minLength: 1,
					maxLength: 10000,
					description: "Comment text.",
				},
			},
			required: ["body"],
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const body =
					typeof args["body"] === "string" && args["body"].length > 0
						? args["body"]
						: undefined;
				if (!body) return webMcpError("body is required");
				const { api, options } = await loadRuntime();
				const comment = await api.osApi.workItems.addComment(
					{ id: itemId, body },
					...clientOptions(executeOptions),
				);
				await queryClient.invalidateQueries({
					queryKey: options.workItemDetailQueryOptions(itemId).queryKey,
				});
				return webMcpResult(
					{ commentId: comment.id, workItemId: itemId },
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const listCurrentWorkItemEvidence: WebMcpToolDef = {
		name: "list_current_work_item_evidence",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List the evidence submitted against the acceptance claims of the work item currently open on this page.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api } = await loadRuntime();
				const result = await api.osApi.workItems.listEvidence(
					{ id: itemId, limit: 50 },
					...clientOptions(executeOptions),
				);
				return webMcpResult(
					{
						evidence: result.data.map((row) => ({
							id: row.id,
							claimKey: row.claimKey,
							kind: row.kind,
							uri: row.uri,
							disposition: row.disposition,
							submittedByType: row.submittedByType,
							submittedById: row.submittedById,
							reviewedByType: row.reviewedByType,
							reviewedById: row.reviewedById,
							reviewReason: row.reviewReason,
						})),
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const listCurrentWorkItemEvents: WebMcpToolDef = {
		name: "list_current_work_item_events",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List the immutable event ledger of the work item currently open on this page, so an agent can explain what happened — who did what, and when.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api } = await loadRuntime();
				const result = await api.osApi.workItems.listEvents(
					{ id: itemId, limit: 100 },
					...clientOptions(executeOptions),
				);
				return webMcpResult(
					{
						events: result.events.map((event) => ({
							sequence: event.sequence,
							eventType: event.eventType,
							actorType: event.actorType,
							actorId: event.actorId,
							occurredAt: event.occurredAt,
							payloadSummary: summarizePayload(event.payload),
						})),
						nextSequence: result.nextSequence,
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const listCurrentWorkItemAttempts: WebMcpToolDef = {
		name: "list_current_work_item_attempts",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List the execution attempts of the work item currently open on this page — which executor ran, its runtime state, and how each run ended. Heartbeat and expiry are recorded updates and reservations, not live host status. Pass nextCursor as cursor to read an earlier page.",
		inputSchema: deriveToolSchema(attemptPageSchema, { pick: ["cursor"] }),
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const parsed = attemptPageSchema.safeParse(args);
				if (!parsed.success) return webMcpError("Invalid attempt page cursor.");
				const { api } = await loadRuntime();
				const result = await api.osApi.workItems.listAttempts(
					{ id: itemId, limit: 50, ...parsed.data },
					...clientOptions(executeOptions),
				);
				return webMcpResult(
					{
						attempts: result.data.map((attempt) => ({
							id: attempt.id,
							executorType: attempt.executorType,
							executorId: attempt.executorId,
							runtimeState: attempt.runtimeState,
							outcome: attempt.outcome,
							attemptNumber: attempt.attemptNumber,
							startedAt: attempt.startedAt,
							heartbeatAt: attempt.heartbeatAt,
							expiresAt: attempt.expiresAt,
							finishedAt: attempt.finishedAt,
							summary: attempt.summary,
						})),
						nextCursor: result.nextCursor,
						hasMore: result.nextCursor !== null,
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	return [
		getCurrentWorkItem,
		commentCurrentWorkItem,
		listCurrentWorkItemEvidence,
		listCurrentWorkItemEvents,
		listCurrentWorkItemAttempts,
	];
}

/** Register the context-bound tools for as long as this item's page is open. */
export function useWorkItemWebMcpTools(itemId: string): void {
	const queryClient = useQueryClient();
	useWebMcpTools(
		`work-item:${itemId}`,
		() => buildWorkItemWebMcpTools(itemId, { queryClient }),
		[itemId, queryClient],
	);
}
