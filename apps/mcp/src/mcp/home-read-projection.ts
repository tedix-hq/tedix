import { isRecord } from "@tedix/api-contract/utils/is-record";

export type HomeReadProjection = "messages" | "runSet" | "tree" | "title";

/** Run-row fields the CLI reads (summaries, latest-run recovery, HomeRunSchema). */
const HOME_RUN_SET_RUN_KEYS = [
	"id",
	"organizationId",
	"conversationId",
	"status",
	"inputMessageId",
	"outputMessageId",
	"delegatedTediId",
	"childRunId",
	"startedAt",
	"completedAt",
	"timeoutAt",
	"createdAt",
	"updatedAt",
	"progress",
	"usage",
];

/** `run.metadata` keys `summarizeHomePayload` and its helpers consume. */
const HOME_RUN_SET_METADATA_KEYS = [
	"source",
	"approvalRequestId",
	"cancelReason",
	"childRunId",
	"childTaskOutcome",
	"clientSubmissionId",
	"delegatedTediId",
	"delegationError",
	"delegationWorkOrder",
	"homeDelegation",
	"kernelWriteProposalDeclined",
	"workItemId",
];

/** Child-tree node fields the CLI renders; `metadata` keeps progress and a clipped preview. */
const HOME_CHILD_TREE_NODE_KEYS = [
	"id",
	"homeRunId",
	"conversationId",
	"delegatedTediId",
	"childRunId",
	"parentRunId",
	"label",
	"status",
	"active",
	"depth",
	"updatedAt",
];

function pick(source: unknown, keys: string[]): Record<string, unknown> {
	if (!isRecord(source)) return {};
	return Object.fromEntries(
		keys
			.filter((key) => source[key] !== undefined)
			.map((key) => [key, source[key]]),
	);
}
function clip(value: unknown, max: number): unknown {
	return typeof value === "string" && value.length > max
		? value.slice(0, max) + "…"
		: value;
}
function projectRun(value: unknown) {
	const run = isRecord(value) ? value : {};
	const metadata = isRecord(run.metadata) ? run.metadata : {};
	const route = isRecord(metadata.kernelRoute)
		? metadata.kernelRoute
		: undefined;
	const body = isRecord(metadata.bodyExecutionResult)
		? metadata.bodyExecutionResult
		: undefined;
	return {
		...pick(run, HOME_RUN_SET_RUN_KEYS),
		metadata: {
			...pick(metadata, HOME_RUN_SET_METADATA_KEYS),
			...(route
				? { kernelRoute: { ...route, answer: clip(route.answer, 2000) } }
				: {}),
			...(body
				? { bodyExecutionResult: { summary: clip(body.summary, 2000) } }
				: {}),
			...(metadata.childRunPreview !== undefined
				? { childRunPreview: clip(metadata.childRunPreview, 500) }
				: {}),
		},
	};
}
function projectNode(node: unknown): unknown {
	if (!isRecord(node)) return node;
	const metadata = isRecord(node.metadata) ? node.metadata : {};
	return {
		...pick(node, HOME_CHILD_TREE_NODE_KEYS),
		metadata: {
			...pick(metadata, ["progress"]),
			...(metadata.preview !== undefined
				? { preview: clip(metadata.preview, 300) }
				: {}),
		},
		children: (Array.isArray(node.children) ? node.children : []).map(
			projectNode,
		),
	};
}

/** Compact Home reads before the gateway applies its result budget. */
export function projectHomeRead(
	kind: unknown,
	payload: unknown,
	input: Record<string, unknown>,
): unknown {
	if (!isRecord(payload)) return payload;
	switch (kind) {
		case "messages":
			return {
				messages: (Array.isArray(payload.messages) ? payload.messages : []).map(
					(m: Record<string, unknown>) => ({
						id: m.id,
						role: m.role,
						content: typeof m.content === "string" ? m.content : "",
						runId: m.runId ?? undefined,
						createdAt: m.createdAt ?? undefined,
					}),
				),
				nextCursor: payload.nextCursor ?? undefined,
			};
		case "runSet": {
			const runSet = isRecord(payload.runSet) ? payload.runSet : payload;
			return {
				runSet: {
					...pick(runSet, [
						"organizationId",
						"conversationId",
						"activeRunIds",
						"approvalMirrors",
						"updatedAt",
					]),
					runs: (Array.isArray(runSet.runs) ? runSet.runs : []).map(projectRun),
				},
			};
		}
		case "tree": {
			if (!isRecord(payload.tree)) return payload;
			const tree = payload.tree;
			return {
				tree: {
					...pick(tree, [
						"organizationId",
						"conversationId",
						"activeNodeId",
						"updatedAt",
					]),
					nodes: (Array.isArray(tree.nodes) ? tree.nodes : []).map(projectNode),
				},
			};
		}
		case "title": {
			const conversation = (
				Array.isArray(payload.conversations) ? payload.conversations : []
			).find((row) => isRecord(row) && row.id === input.conversationId);
			return {
				found: Boolean(conversation),
				title: conversation?.title ?? null,
				nextCursor: payload.nextCursor ?? null,
			};
		}
		default:
			return payload;
	}
}
