import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
// Contract modules are pure zod/oRPC metadata — safe at module scope (the
// import-inertness rule bans only the app-bootstrap modules).
import { workItemsContract } from "@tedix/api-contract/contracts/work-items";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
	WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import {
	contractInputSchema,
	deriveToolSchema,
} from "@/lib/webmcp/derive-schema";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";

/**
 * WebMCP tools for the Work board: an in-page browser agent can read the same
 * work items the human is looking at, and file proposals/comments that appear
 * live in the UI because every write invalidates through the app's generated
 * query keys (one-namespace rule — never a hand-written key array).
 *
 * Deliberately human-gated: there is no accept/start/settle tool. A created
 * item lands as `proposed` and waits for a human to accept it on the board.
 *
 * `@/lib/api` reads `window.location` at module scope, so it (and
 * `@/lib/os-query-options`, which imports it) is loaded lazily at execute
 * time. This keeps `work-shell.tsx` importable in a node test environment.
 */

type ApiModule = typeof import("@/lib/api");
type OptionsModule = typeof import("@/lib/os-query-options");
type OsApi = ApiModule["osApi"];

interface WorkWebMcpRuntime {
	api: ApiModule;
	options: OptionsModule;
}

let runtime: Promise<WorkWebMcpRuntime> | null = null;
const loadRuntime = (): Promise<WorkWebMcpRuntime> =>
	(runtime ??= Promise.all([
		import("@/lib/api"),
		import("@/lib/os-query-options"),
	]).then(([api, options]) => ({ api, options })));

const clientOptions = (options?: WebMcpToolExecuteOptions) =>
	options?.signal ? ([{ signal: options.signal }] as const) : ([] as const);

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 50;

/**
 * Derived from the contract's list input: filter enums (disposition,
 * workKind) and string bounds track the contract automatically. `limit` is
 * declared as a tool-only extra because the contract's pagination `limit` is
 * a coerced field and the tool deliberately pins a tighter cap
 * (MAX_LIST_LIMIT) than the contract's 100.
 */
const LIST_WORK_ITEMS_SCHEMA = deriveToolSchema(
	contractInputSchema(workItemsContract.list),
	{
		pick: ["disposition", "workKind", "projectId", "titleContains"],
		override: {
			disposition: { description: "Filter by lifecycle disposition." },
			workKind: { description: "Filter by kind of work." },
			projectId: { description: "Filter to one project." },
			titleContains: { description: "Case-insensitive title substring." },
		},
		extra: {
			limit: {
				type: "integer",
				minimum: 1,
				maximum: MAX_LIST_LIMIT,
				description: `Rows to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`,
			},
		},
	},
);

/**
 * Derived from CreateWorkItemInputSchema: required keys (`title`), caps, the
 * workKind vocabulary (with its contract default), and the workClass enum all
 * track the contract. The pick list is the tool's deliberate exposure subset
 * — ownership/steward/reviewer routing stays server-side.
 */
const CREATE_WORK_ITEM_SCHEMA = deriveToolSchema(CreateWorkItemInputSchema, {
	pick: [
		"title",
		"description",
		"workKind",
		"workClass",
		"objectiveId",
		"projectId",
		"purposeExceptionExpiresAt",
	],
	override: {
		title: { description: "Short outcome-focused title." },
		description: {
			description: "What done looks like, context, and constraints.",
		},
		workKind: { description: "Kind of work (defaults to other)." },
		workClass: {
			description:
				"Purpose class. `objective` requires objectiveId; the exception classes require purposeExceptionExpiresAt.",
		},
		objectiveId: {
			description: "Objective this item serves (workClass `objective`).",
		},
		projectId: { description: "Project to file the item under." },
		purposeExceptionExpiresAt: {
			description:
				"ISO expiry for a maintenance/incident/hygiene exception item.",
		},
	},
});

type WorkItemsListInput = NonNullable<
	Parameters<OsApi["workItems"]["list"]>[0]
>;
type CreateWorkItemInput = Parameters<OsApi["workItems"]["create"]>[0];

export interface WorkWebMcpDeps {
	queryClient: QueryClient;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function workItemDeepLink(id: string): string {
	return `/work/items/${id}`;
}

/** Build the Work-scope WebMCP tool set. Pure so tests can drive execute(). */
export function buildWorkWebMcpTools(deps: WorkWebMcpDeps): WebMcpToolDef[] {
	const { queryClient } = deps;

	async function invalidateWorkCaches(options: OptionsModule): Promise<void> {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: options.workReadinessProjectionQueryOptions().queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey: options.osQuery.workItems.key({ type: "query" }),
			}),
		]);
	}

	const listWorkItems: WebMcpToolDef = {
		name: "list_work_items",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List Tedix work items — bounded tasks executed by the organization's digital workers — as the compact rows the human sees on the Work queue.",
		inputSchema: LIST_WORK_ITEMS_SCHEMA,
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api } = await loadRuntime();
				const rawLimit =
					typeof args["limit"] === "number"
						? args["limit"]
						: DEFAULT_LIST_LIMIT;
				const limit = Math.min(
					Math.max(Math.trunc(rawLimit), 1),
					MAX_LIST_LIMIT,
				);
				const input = {
					limit,
					...(optionalString(args["disposition"])
						? { disposition: args["disposition"] }
						: {}),
					...(optionalString(args["workKind"])
						? { workKind: args["workKind"] }
						: {}),
					...(optionalString(args["projectId"])
						? { projectId: args["projectId"] }
						: {}),
					...(optionalString(args["titleContains"])
						? { titleContains: args["titleContains"] }
						: {}),
				} as WorkItemsListInput;
				const result = await api.osApi.workItems.list(
					input,
					...clientOptions(executeOptions),
				);
				return webMcpResult({
					items: result.data.map((item) => ({
						id: item.id,
						title: item.title,
						disposition: item.disposition,
						workKind: item.workKind,
						workClass: item.workClass,
						deepLink: workItemDeepLink(item.id),
					})),
					pagination: result.pagination,
				});
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const getWorkItem: WebMcpToolDef = {
		name: "get_work_item",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Read one Tedix work item in the detail the human sees on its Work board page: title, state, acceptance claims, and the latest comments.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					format: "uuid",
					description: "Work item id.",
				},
			},
			required: ["id"],
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const id = optionalString(args["id"]);
				if (!id) return webMcpError("id is required");
				const { api } = await loadRuntime();
				const { workItem, comments } = await api.osApi.workItems.getById(
					{ id },
					...clientOptions(executeOptions),
				);
				return webMcpResult(
					{
						id: workItem.id,
						title: workItem.title,
						description: workItem.description,
						disposition: workItem.disposition,
						workKind: workItem.workKind,
						workClass: workItem.workClass,
						priority: workItem.priority,
						riskLevel: workItem.riskLevel,
						projectId: workItem.projectId,
						objectiveId: workItem.objectiveId,
						doneLooksLike: workItem.acceptanceContract?.doneLooksLike ?? null,
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
					workItemDeepLink(workItem.id),
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const createWorkItem: WebMcpToolDef = {
		name: "create_work_item",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Propose a new Tedix work item that appears on the human's Work queue as `proposed` and waits for a human to accept it before any digital worker can execute it.",
		inputSchema: CREATE_WORK_ITEM_SCHEMA,
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const title = optionalString(args["title"]);
				if (!title) return webMcpError("title is required");
				const { api, options } = await loadRuntime();
				const input = {
					title,
					...(optionalString(args["description"])
						? { description: args["description"] }
						: {}),
					...(optionalString(args["workKind"])
						? { workKind: args["workKind"] }
						: {}),
					...(optionalString(args["workClass"])
						? { workClass: args["workClass"] }
						: {}),
					...(optionalString(args["objectiveId"])
						? { objectiveId: args["objectiveId"] }
						: {}),
					...(optionalString(args["projectId"])
						? { projectId: args["projectId"] }
						: {}),
					...(optionalString(args["purposeExceptionExpiresAt"])
						? { purposeExceptionExpiresAt: args["purposeExceptionExpiresAt"] }
						: {}),
				} as CreateWorkItemInput;
				const created = await api.osApi.workItems.create(
					input,
					...clientOptions(executeOptions),
				);
				await invalidateWorkCaches(options);
				return webMcpResult(
					{
						id: created.id,
						title: created.title,
						disposition: created.disposition,
					},
					workItemDeepLink(created.id),
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const commentWorkItem: WebMcpToolDef = {
		name: "comment_work_item",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Add a comment to a Tedix work item; it appears immediately in the comment thread the human sees on the item's Work board page.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					format: "uuid",
					description: "Work item id.",
				},
				body: {
					type: "string",
					minLength: 1,
					maxLength: 10000,
					description: "Comment text.",
				},
			},
			required: ["id", "body"],
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const id = optionalString(args["id"]);
				const body = optionalString(args["body"]);
				if (!id) return webMcpError("id is required");
				if (!body) return webMcpError("body is required");
				const { api, options } = await loadRuntime();
				const comment = await api.osApi.workItems.addComment(
					{ id, body },
					...clientOptions(executeOptions),
				);
				await queryClient.invalidateQueries({
					queryKey: options.workItemDetailQueryOptions(id).queryKey,
				});
				return webMcpResult(
					{ commentId: comment.id, workItemId: id },
					workItemDeepLink(id),
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const listPendingApprovals: WebMcpToolDef = {
		name: "list_pending_approvals",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List Work approval proposals waiting on the HUMAN to decide on the Approvals page — the agent cannot approve or reject them; deciding is deliberately human-only.",
		inputSchema: {
			type: "object",
			properties: {
				workItemId: {
					type: "string",
					format: "uuid",
					description: "Optional filter to approvals for one work item.",
				},
			},
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api } = await loadRuntime();
				const workItemId = optionalString(args["workItemId"]);
				const result = await api.osApi.workApprovals.listInbox(
					{
						limit: 50,
						...(workItemId ? { workItemId } : {}),
					},
					...clientOptions(executeOptions),
				);
				const approvals = result.data
					.filter((row) => row.effectiveStatus === "pending" && row.canDecide)
					.map((row) => ({
						proposalId: row.proposal.id,
						action: row.proposal.action,
						workItemId: row.workItem.id,
						workItemTitle: row.workItem.title,
						requestRationale: row.proposal.requestRationale,
						approverType: row.proposal.approverType,
						approverId: row.proposal.approverId,
						expiresAt: row.proposal.expiresAt,
					}));
				return webMcpResult({ approvals }, "/work/approvals");
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	return [
		listWorkItems,
		getWorkItem,
		createWorkItem,
		commentWorkItem,
		listPendingApprovals,
	];
}

/** Register the Work-scope WebMCP tools for the lifetime of the Work shell. */
export function useWorkWebMcpTools(): void {
	const queryClient = useQueryClient();
	useWebMcpTools("work", () => buildWorkWebMcpTools({ queryClient }), [
		queryClient,
	]);
}
