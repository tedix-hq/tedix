import type {
	TedixHomeClient,
	McpCallOptions,
	ReadHomeMessagesInput,
	ReadHomeRunSetInput,
	ListHomeConversationsInput,
	ListKernelTraceBundlesInput,
	ReadChildRunEvidenceInput,
	ReadChildRunTreeInput,
	ReadHomeRunEventsInput,
} from "./home-client";
import {
	normalizeCodeResult,
	resolveCodeResult as resolveGatewayCodeResult,
} from "./code-result";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	type HomeRunEventsPage,
	HOME_RUN_EVENTS_START,
	HOME_RUN_EVENTS_PAGE,
	HOME_MESSAGES_PAGE,
	HOME_RUN_SET_PAGE,
	HOME_RUN_SET_RUN_KEYS,
	HOME_RUN_SET_METADATA_KEYS,
	HOME_CHILD_TREE_NODE_KEYS,
	parseHomeRunEventsPage,
} from "./home-payload";

type CodeReadClient = Pick<TedixHomeClient, "callTool">;

export async function callHomeTool(
	this: CodeReadClient,
	toolName: string,
	args: Record<string, unknown>,
	options: McpCallOptions = {},
): Promise<unknown> {
	if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
		throw new Error(`Invalid Home tool name: ${toolName}`);
	}
	return this.callTool(
		"code",
		{
			code: `async () => await home.${toolName}(${JSON.stringify(args)})`,
		},
		options,
	);
}

/**
 * Normalize a gateway payload, paging a handle-kept result back in full.
 * Only a result the gateway could not keep stays `truncated: true`, and the
 * callers above then shrink their page as before.
 */
async function resolveCodeResult(this: CodeReadClient, payload: unknown) {
	return resolveGatewayCodeResult(
		(source) => this.callTool("code", { code: source }, { retryable: true }),
		payload,
	);
}

export async function readHomeRun(
	this: CodeReadClient,
	homeRunId: string,
	signal?: AbortSignal,
): Promise<unknown> {
	return callHomeTool.call(
		this,
		"read_home_run",
		{ runId: homeRunId },
		{ retryable: true, signal },
	);
}

/**
 * Read Home transcript messages, projected to the fields the CLI renders.
 *
 * A raw `read_home_messages` row carries its whole `runtime.metadata` — the
 * delegation work order, execution requirement, usage — so even TWO rows
 * exceed the Code Mode gateway's result budget and come back as a truncation
 * preview with no messages in it. Project inside the gateway program so the
 * result is small by construction, and halve the page when it still does not
 * fit (one message with a very long answer can be over budget on its own).
 */
export async function readHomeMessages(
	this: CodeReadClient,
	input: ReadHomeMessagesInput,
): Promise<unknown> {
	let limit = Math.max(1, input.limit ?? HOME_MESSAGES_PAGE);
	while (true) {
		const args = {
			conversationId: input.conversationId,
			...(input.cursor ? { cursor: input.cursor } : {}),
			limit,
		};
		const payload = await this.callTool(
			"code",
			{
				code: readHomeMessagesProgram(args),
			},
			{ retryable: true },
		);
		const normalized = await resolveCodeResult.call(this, payload);
		if (!normalized.truncated) return normalized.value;
		if (limit <= 1) {
			throw new Error(
				`Home message page is too large for the Code Mode gateway to return${
					normalized.truncationHint ? `: ${normalized.truncationHint}` : "."
				}`,
			);
		}
		limit = Math.max(1, Math.floor(limit / 2));
	}
}

/**
 * Read the conversation's run set, projected to the fields the CLI renders.
 *
 * A raw run row carries its whole `runtime.metadata` (execution requirement,
 * redrive input, work orders) so a page of twenty real runs is several times
 * the Code Mode gateway's result budget and comes back as a truncation
 * preview with no runs in it. `tedix status` used to read that preview as an
 * empty conversation. Project inside the gateway program so the result is
 * small by construction, halve the page while it still does not fit, and
 * return the unwrapped `{ runSet }` payload rather than the gateway envelope.
 */
export async function readHomeRunSet(
	this: CodeReadClient,
	input: ReadHomeRunSetInput,
): Promise<unknown> {
	let limit = Math.max(1, input.limit ?? HOME_RUN_SET_PAGE);
	while (true) {
		const args = { conversationId: input.conversationId, limit };
		const payload = await this.callTool(
			"code",
			{
				code: readHomeRunSetProgram(args),
			},
			{ retryable: true },
		);
		const normalized = await resolveCodeResult.call(this, payload);
		if (!normalized.truncated) return normalized.value;
		if (limit <= 1) {
			throw new Error(
				`Home run set is too large for the Code Mode gateway to return${
					normalized.truncationHint ? `: ${normalized.truncationHint}` : "."
				}`,
			);
		}
		limit = Math.max(1, Math.floor(limit / 2));
	}
}

export async function readHomeConversationTitle(
	this: CodeReadClient,
	conversationId: string,
): Promise<string | undefined> {
	let cursor: string | undefined;
	do {
		const args = {
			limit: 100,
			includeArchived: true,
			...(cursor ? { cursor } : {}),
		};
		const payload = await this.callTool(
			"code",
			{
				code: readHomeConversationTitleProgram(args, conversationId),
			},
			{ retryable: true },
		);
		const normalized = normalizeCodeResult(payload);
		if (normalized.truncated || !isRecord(normalized.value))
			throw new Error("Home conversation title read was truncated or invalid");
		const page = normalized.value;
		if (page.found)
			return typeof page.title === "string" ? page.title : undefined;
		cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
	} while (cursor);
	return undefined;
}

export async function listHomeConversations(
	this: CodeReadClient,
	input: ListHomeConversationsInput,
): Promise<unknown> {
	return callHomeTool.call(
		this,
		"list_conversations",
		{
			...(input.channel ? { channel: input.channel } : {}),
			...(input.cursor ? { cursor: input.cursor } : {}),
			...(input.includeArchived ? { includeArchived: true } : {}),
			...(input.limit ? { limit: input.limit } : {}),
			...(input.search ? { search: input.search } : {}),
		},
		{ retryable: true },
	);
}

export async function readDelegatedTediTraces(
	this: CodeReadClient,
	input: {
		tediId: string;
		runId?: string;
		limit?: number;
	},
): Promise<unknown> {
	return callHomeTool.call(
		this,
		"read_delegated_tedi_traces",
		{
			tediId: input.tediId,
			...(input.runId ? { runId: input.runId } : {}),
			...(input.limit ? { limit: input.limit } : {}),
		},
		{ retryable: true },
	);
}

export async function listKernelTraceBundles(
	this: CodeReadClient,
	input: ListKernelTraceBundlesInput,
): Promise<unknown> {
	return callHomeTool.call(
		this,
		"list_kernel_trace_bundles",
		{
			...(input.harnessVersionId
				? { harnessVersionId: input.harnessVersionId }
				: {}),
			...(input.limit ? { limit: input.limit } : {}),
			...(input.runId ? { runId: input.runId } : {}),
		},
		{ retryable: true },
	);
}

export async function readHomeTrace(
	this: CodeReadClient,
	homeRunId: string,
): Promise<unknown> {
	return callHomeTool.call(
		this,
		"read_home_trace",
		{ runId: homeRunId },
		{ retryable: true },
	);
}

export async function readChildRunEvidence(
	this: CodeReadClient,
	input: ReadChildRunEvidenceInput,
): Promise<unknown> {
	return callHomeTool.call(
		this,
		"read_child_run_evidence",
		{
			childRunId: input.childRunId,
			delegatedTediId: input.delegatedTediId,
			...(input.artifactLimit ? { artifactLimit: input.artifactLimit } : {}),
			...(input.limit ? { limit: input.limit } : {}),
		},
		{ retryable: true },
	);
}

/**
 * Read the conversation's delegated child-run tree, projected to the node
 * fields the CLI renders (a child's preview is the delegated tedi's whole
 * answer, so unprojected nodes overrun the gateway budget together). Returns
 * the unwrapped `{ tree }` payload rather than the gateway envelope, halving
 * the page while the gateway still truncates it.
 */
export async function readChildRunTree(
	this: CodeReadClient,
	input: ReadChildRunTreeInput,
): Promise<unknown> {
	let limit = input.limit ? Math.max(1, input.limit) : undefined;
	while (true) {
		const args = {
			conversationId: input.conversationId,
			...(limit ? { limit } : {}),
		};
		const payload = await this.callTool(
			"code",
			{
				code: readChildRunTreeProgram(args),
			},
			{ retryable: true },
		);
		const normalized = await resolveCodeResult.call(this, payload);
		if (!normalized.truncated) return normalized.value;
		if (limit !== undefined && limit <= 1) {
			throw new Error(
				`Home child-run tree is too large for the Code Mode gateway to return${
					normalized.truncationHint ? `: ${normalized.truncationHint}` : "."
				}`,
			);
		}
		limit = Math.max(1, Math.floor((limit ?? HOME_RUN_SET_PAGE) / 2));
	}
}

export async function readHomeRunEvents(
	this: CodeReadClient,
	input: ReadHomeRunEventsInput,
	signal?: AbortSignal,
): Promise<HomeRunEventsPage> {
	const offset = input.offset ?? HOME_RUN_EVENTS_START;
	const parsedOffset = Number.parseInt(offset, 10);
	const start =
		Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
	// Home events carry full payloads — a delegation work order or a final
	// report is kilobytes on its own — and the Code Mode gateway replaces any
	// result over its token budget with a preview string. An unpaged read of a
	// real run is therefore truncated by default, which is why this used to
	// return nothing at all. Ask for a bounded slice, and halve it whenever the
	// gateway still says the answer did not fit.
	let limit = Math.max(1, input.limit ?? HOME_RUN_EVENTS_PAGE);
	let lastHint: string | undefined;
	while (true) {
		const payload = await callHomeTool.call(
			this,
			"read_home_run_events",
			{
				runId: input.homeRunId,
				offset: start,
				limit,
				...(typeof input.waitMs === "number" ? { waitMs: input.waitMs } : {}),
				...(input.childRunId ? { childRunId: input.childRunId } : {}),
				...(input.delegatedTediId
					? { delegatedTediId: input.delegatedTediId }
					: {}),
			},
			{ retryable: true, signal },
		);
		// `callHomeTool` runs the read as Code Mode, so `payload` is the gateway
		// envelope `{ executionId, result, logs }`; the page lives under `result`.
		const normalized = await resolveCodeResult.call(this, payload);
		if (!normalized.truncated) {
			return parseHomeRunEventsPage(normalized.value, offset);
		}
		lastHint = normalized.truncationHint;
		if (limit <= 1) {
			// One event that does not fit cannot be paged around. Fail loudly:
			// swallowing this is what turned `tedix tail` into silence.
			throw new Error(
				`Home run event at offset ${start} is too large for the Code Mode gateway to return${
					lastHint ? `: ${lastHint}` : "."
				}`,
			);
		}
		limit = Math.max(1, Math.floor(limit / 2));
	}
}

function readHomeMessagesProgram(args: Record<string, unknown>): string {
	return `async () => {
	const page = await home.read_home_messages(${JSON.stringify(args)});
	const rows = Array.isArray(page && page.messages) ? page.messages : [];
	return {
		messages: rows.map((m) => ({
			id: m.id,
			role: m.role,
			content: typeof m.content === "string" ? m.content : "",
			runId: m.runId ?? undefined,
			createdAt: m.createdAt ?? undefined,
		})),
		nextCursor: (page && page.nextCursor) ?? undefined,
	};
}`;
}

function readHomeRunSetProgram(args: Record<string, unknown>): string {
	return `async () => {
	const clip = (value, max) =>
		typeof value === "string" && value.length > max
			? value.slice(0, max) + "…"
			: value;
	const pick = (source, keys) => {
		const out = {};
		if (!source || typeof source !== "object") return out;
		for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
		return out;
	};
	const projectRun = (run) => {
		const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
		const route = metadata.kernelRoute && typeof metadata.kernelRoute === "object" ? metadata.kernelRoute : undefined;
		const body = metadata.bodyExecutionResult && typeof metadata.bodyExecutionResult === "object" ? metadata.bodyExecutionResult : undefined;
		return {
			...pick(run, ${JSON.stringify(HOME_RUN_SET_RUN_KEYS)}),
			metadata: {
				...pick(metadata, ${JSON.stringify(HOME_RUN_SET_METADATA_KEYS)}),
				...(route ? { kernelRoute: { ...route, answer: clip(route.answer, 2000) } } : {}),
				...(body ? { bodyExecutionResult: { summary: clip(body.summary, 2000) } } : {}),
				...(metadata.childRunPreview !== undefined ? { childRunPreview: clip(metadata.childRunPreview, 500) } : {}),
			},
		};
	};
	const payload = await home.read_home_run_set(${JSON.stringify(args)});
	const runSet = payload && typeof payload === "object" && payload.runSet && typeof payload.runSet === "object" ? payload.runSet : payload;
	if (!runSet || typeof runSet !== "object") return payload;
	return {
		runSet: {
			...pick(runSet, ["organizationId", "conversationId", "activeRunIds", "approvalMirrors", "updatedAt"]),
			runs: (Array.isArray(runSet.runs) ? runSet.runs : []).map(projectRun),
		},
	};
}`;
}

function readHomeConversationTitleProgram(
	args: Record<string, unknown>,
	conversationId: string,
): string {
	return `async () => {
const page = await home.list_conversations(${JSON.stringify(args)});
const conversation = page.conversations.find(row => row.id === ${JSON.stringify(conversationId)});
return { found: Boolean(conversation), title: conversation?.title ?? null, nextCursor: page.nextCursor ?? null };
}`;
}

function readChildRunTreeProgram(args: Record<string, unknown>): string {
	return `async () => {
	const clip = (value, max) =>
		typeof value === "string" && value.length > max
			? value.slice(0, max) + "…"
			: value;
	const pick = (source, keys) => {
		const out = {};
		if (!source || typeof source !== "object") return out;
		for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
		return out;
	};
	const projectNode = (node) => {
		if (!node || typeof node !== "object") return node;
		const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
		return {
			...pick(node, ${JSON.stringify(HOME_CHILD_TREE_NODE_KEYS)}),
			metadata: {
				...pick(metadata, ["progress"]),
				...(metadata.preview !== undefined ? { preview: clip(metadata.preview, 300) } : {}),
			},
			children: (Array.isArray(node.children) ? node.children : []).map(projectNode),
		};
	};
	const payload = await home.read_child_run_tree(${JSON.stringify(args)});
	const tree = payload && typeof payload === "object" && payload.tree && typeof payload.tree === "object" ? payload.tree : null;
	if (!tree) return payload;
	return {
		tree: {
			...pick(tree, ["organizationId", "conversationId", "activeNodeId", "updatedAt"]),
			nodes: (Array.isArray(tree.nodes) ? tree.nodes : []).map(projectNode),
		},
	};
}`;
}
