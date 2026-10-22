import type {
	HomeChildRunStatus,
	HomeChildRunTree,
	HomeChildRunTreeNode,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	listTediRuntimeEvents,
	type TediRuntimeEventRow,
} from "@tedix/db/queries/kernel-runtime-events";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { type FanoutSlotRecord, readFanoutSlots } from "@tedix/provisioning";
import type { BaseContext } from "../../orpc";
import { getProvisioningConfig } from "../tedis/helpers";
import {
	isToolErrorString,
	structuredResultValue,
	summarizeChildRuntimeEvents,
} from "./child-run-events";
import {
	childRunStatusFromSummary,
	latestIso,
	nonNullRecord,
	stringFromPayload,
} from "./runtime-shared";

/** Char cap for the promoted final assistant message (well under the 24k transcript budget). */
export const FINAL_ASSISTANT_MESSAGE_CHAR_CAP = 8_192;

/** Keep delegated MCP UI state small enough for one durable Home event row. */
const DELEGATED_WIDGET_RESULT_BYTE_CAP = 24_000;
const DELEGATED_WIDGET_VALUE_DEPTH_CAP = 8;
const DELEGATED_WIDGET_COLLECTION_CAP = 100;
const DELEGATED_WIDGET_STRING_CAP = 4_096;
const MAX_DELEGATED_WIDGETS = 3;
const MCP_APP_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SENSITIVE_RESULT_KEYS = new Set([
	"api_key",
	"apikey",
	"authorization",
	"bearer",
	"cookie",
	"credential",
	"credentials",
	"password",
	"refresh_token",
	"secret",
	"set-cookie",
	"token",
	"access_token",
]);

export type DelegatedWidgetProjection = {
	resourceUri: string;
	toolInput?: Record<string, unknown>;
	toolResult?: Record<string, unknown>;
	/**
	 * The app whose tool actually produced this result, derived from the tool
	 * NAME on the `tool.completed` event — never from the payload, which is the
	 * untrusted side. A result can declare any `ui://widgets/mcp-app/<slug>/…`
	 * it likes; `widgetTargetFromResourceUri` validates the URI's SHAPE and puts
	 * no constraint on which slug appears, so without this the transcript would
	 * render app B's UI inside a turn where only app A ran. Renderers compare
	 * the two and refuse a mismatch.
	 *
	 * Absent when the tool name is missing or carries no namespace — in that
	 * case provenance is UNKNOWN and must not be fabricated.
	 */
	producedByAppSlug?: string;
};

export type ChildRunFinalAssistantResult = {
	content: string | null;
	widgets: DelegatedWidgetProjection[];
};

function validatedMcpAppResourceUri(value: unknown): string | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const resourceUri = value.trim();
	let parsed: URL;
	try {
		parsed = new URL(resourceUri);
	} catch {
		return null;
	}
	const [namespace, appSlug, ...resourcePath] = parsed.pathname
		.split("/")
		.filter(Boolean);
	if (
		parsed.protocol !== "ui:" ||
		parsed.hostname !== "widgets" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.port !== "" ||
		namespace !== "mcp-app" ||
		!appSlug ||
		!MCP_APP_SLUG_PATTERN.test(appSlug) ||
		resourcePath.length === 0
	) {
		return null;
	}
	return resourceUri;
}

function sanitizedDelegatedWidgetValue(value: unknown, depth = 0): unknown {
	if (depth > DELEGATED_WIDGET_VALUE_DEPTH_CAP) return undefined;
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return value;
	}
	if (typeof value === "string") {
		return value.length > DELEGATED_WIDGET_STRING_CAP
			? value.slice(0, DELEGATED_WIDGET_STRING_CAP)
			: value;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, DELEGATED_WIDGET_COLLECTION_CAP)
			.map((item) => sanitizedDelegatedWidgetValue(item, depth + 1))
			.filter((item) => item !== undefined);
	}
	const record = nonNullRecord(value);
	if (!record) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(record).slice(
		0,
		DELEGATED_WIDGET_COLLECTION_CAP,
	)) {
		const normalizedKey = key.toLowerCase();
		if (
			SENSITIVE_RESULT_KEYS.has(normalizedKey) ||
			(normalizedKey.endsWith("token") && normalizedKey !== "tokenscope")
		) {
			continue;
		}
		const sanitized = sanitizedDelegatedWidgetValue(nested, depth + 1);
		if (sanitized !== undefined) result[key] = sanitized;
	}
	return result;
}

function boundedDelegatedWidgetRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	const sanitized = sanitizedDelegatedWidgetValue(value);
	const record = nonNullRecord(sanitized);
	if (!record) return undefined;
	try {
		return new TextEncoder().encode(JSON.stringify(record)).byteLength <=
			DELEGATED_WIDGET_RESULT_BYTE_CAP
			? record
			: undefined;
	} catch {
		return undefined;
	}
}

function widgetResourceUriFromRecord(
	record: Record<string, unknown>,
): string | null {
	return validatedMcpAppResourceUri(
		nonNullRecord(nonNullRecord(record._meta)?.ui)?.resourceUri,
	);
}

/**
 * Project only validated MCP UI targets and their bounded initial result from
 * delegated child tool events. Arbitrary child metadata never crosses into the
 * durable Home transcript.
 */
export function delegatedWidgetProjectionFromEvents(
	rows: TediRuntimeEventRow[],
): DelegatedWidgetProjection[] {
	const widgets: DelegatedWidgetProjection[] = [];
	const seenUris = new Set<string>();

	const visit = (
		value: unknown,
		toolInput: Record<string, unknown> | undefined,
		producedByAppSlug: string | undefined,
		depth = 0,
	): void => {
		if (
			depth > DELEGATED_WIDGET_VALUE_DEPTH_CAP ||
			widgets.length >= MAX_DELEGATED_WIDGETS
		) {
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value)
				visit(item, toolInput, producedByAppSlug, depth + 1);
			return;
		}
		const record = nonNullRecord(value);
		if (!record) return;
		const resourceUri = widgetResourceUriFromRecord(record);
		if (resourceUri) {
			if (!seenUris.has(resourceUri)) {
				seenUris.add(resourceUri);
				const toolResult = boundedDelegatedWidgetRecord(record);
				widgets.push({
					resourceUri,
					...(toolInput ? { toolInput } : {}),
					...(toolResult ? { toolResult } : {}),
					...(producedByAppSlug ? { producedByAppSlug } : {}),
				});
			}
			return;
		}
		for (const nested of Object.values(record)) {
			visit(nested, toolInput, producedByAppSlug, depth + 1);
		}
	};

	for (const row of rows) {
		if (row.kind !== "tool.completed") continue;
		const payload = nonNullRecord(row.payload);
		const candidate = structuredResultValue(
			payload?.resultProjection ?? payload?.data ?? payload?.result,
		);
		if (candidate === null || isToolErrorString(candidate)) continue;
		const toolInput = boundedDelegatedWidgetRecord(
			payload?.input ?? payload?.arguments,
		);
		// Provenance comes from the EVENT, not the result body.
		const toolName = typeof payload?.name === "string" ? payload.name : null;
		// Only app-qualified MCP names attest an app. Harness wrappers such as
		// tedix_mcp_call_tool can execute any authorized app through Code Mode.
		const producedByAppSlug = toolName?.includes("__")
			? toolName.split("__")[0] || undefined
			: undefined;
		visit(candidate, toolInput, producedByAppSlug);
		if (widgets.length >= MAX_DELEGATED_WIDGETS) break;
	}
	return widgets;
}

function homeChildRunTreeStatus(run: HomeRun): HomeChildRunStatus {
	const metadataStatus = nonNullRecord(run.metadata)?.childRunStatus;
	if (
		metadataStatus === "queued" ||
		metadataStatus === "running" ||
		metadataStatus === "streaming" ||
		metadataStatus === "requires_approval" ||
		metadataStatus === "partial" ||
		metadataStatus === "completed" ||
		metadataStatus === "failed" ||
		metadataStatus === "canceled"
	) {
		return metadataStatus;
	}
	if (
		run.status === "queued" ||
		run.status === "running" ||
		run.status === "requires_approval" ||
		run.status === "completed" ||
		run.status === "failed" ||
		run.status === "canceled"
	) {
		return run.status;
	}
	return "queued";
}

function homeChildRunTreeLabel(run: HomeRun): string {
	const metadata = nonNullRecord(run.metadata) ?? {};
	const route = nonNullRecord(metadata.kernelRoute);
	const owner = stringFromPayload(route?.ownerLabel);
	return (
		owner ??
		stringFromPayload(metadata.delegatedTediSlug) ??
		run.delegatedTediId ??
		run.childRunId ??
		run.id
	);
}

/** Read live fan-out slots from the tedi-runtime DO for a delegation node. Fail-soft → []. */
async function readFanoutSlotsForNode(
	context: BaseContext,
	node: {
		delegatedTediId: string;
		childRunId: string;
		metadata?: Record<string, unknown> | null;
	},
): Promise<FanoutSlotRecord[]> {
	try {
		const slug =
			typeof node.metadata?.delegatedTediSlug === "string"
				? node.metadata.delegatedTediSlug
				: null;
		if (!slug) return [];
		const config = getProvisioningConfig({ slug }, context.env);
		// Skip when no service-binding fetcher (test env or misconfigured API).
		if (!config?.fetcher) return [];
		const result = await readFanoutSlots(config, {
			parentRunId: node.childRunId,
			limit: 20,
		});
		return result.slots ?? [];
	} catch {
		return [];
	}
}

/**
 * Query tediRuntimeEvents for terminal fan-out child runs belonging to a
 * given tedi. Fan-out runIds follow the pattern `${tediId}:fanout:%`. Groups
 * by runId to derive per-child status. Fail-soft → empty map.
 */
async function readTerminalFanoutRuns(
	context: BaseContext,
	tediId: string,
): Promise<Map<string, "partial" | "completed" | "failed" | "canceled">> {
	try {
		const rows = await listTediRuntimeEvents(context.db, {
			tediId,
			runIdPrefix: `${tediId}:fanout:`,
			order: "desc",
			limit: 200,
		});
		const byRunId = new Map<string, TediRuntimeEventRow[]>();
		for (const row of rows) {
			if (!row.runId) continue;
			const existing = byRunId.get(row.runId) ?? [];
			existing.push(row);
			byRunId.set(row.runId, existing);
		}
		const result = new Map<
			string,
			"partial" | "completed" | "failed" | "canceled"
		>();
		for (const [runId, runRows] of byRunId) {
			const summary = summarizeChildRuntimeEvents(runRows);
			const childStatus = childRunStatusFromSummary(summary);
			if (
				childStatus === "partial" ||
				childStatus === "completed" ||
				childStatus === "failed" ||
				childStatus === "canceled"
			) {
				result.set(runId, childStatus);
			}
		}
		return result;
	} catch {
		return new Map();
	}
}

/**
 * Build `HomeChildRunTreeNode` children for a delegation node by merging live
 * fan-out slots (from the DO) with terminal statuses (from tediRuntimeEvents).
 */
export function buildFanoutChildNodes(input: {
	homeRunId: string;
	conversationId: string;
	delegatedTediId: string;
	liveSlots: FanoutSlotRecord[];
	terminalByRunId: Map<string, "partial" | "completed" | "failed" | "canceled">;
}): HomeChildRunTreeNode[] {
	const seen = new Set<string>();
	const children: HomeChildRunTreeNode[] = [];

	for (const slot of input.liveSlots) {
		if (!slot.childRunId || seen.has(slot.childRunId)) continue;
		seen.add(slot.childRunId);
		// If D1 says terminal, trust that over the slot's "queued" status.
		const terminalStatus = input.terminalByRunId.get(slot.childRunId);
		const status: HomeChildRunTreeNode["status"] = terminalStatus ?? "queued";
		const active =
			status !== "partial" &&
			status !== "completed" &&
			status !== "failed" &&
			status !== "canceled";
		children.push({
			id: `fanout:${input.delegatedTediId}:${slot.childRunId}`,
			homeRunId: input.homeRunId,
			conversationId: input.conversationId,
			delegatedTediId: input.delegatedTediId,
			childRunId: slot.childRunId,
			parentRunId: null,
			label: slot.ownerLabel || slot.objective || slot.childRunId,
			status,
			active,
			depth: 1,
			updatedAt: slot.dispatchedAt,
			children: [],
			metadata: { source: "fanout" },
		});
	}

	// Add terminal children not in the live-slot list.
	for (const [runId, terminalStatus] of input.terminalByRunId) {
		if (seen.has(runId)) continue;
		seen.add(runId);
		children.push({
			id: `fanout:${input.delegatedTediId}:${runId}`,
			homeRunId: input.homeRunId,
			conversationId: input.conversationId,
			delegatedTediId: input.delegatedTediId,
			childRunId: runId,
			parentRunId: null,
			label: `Fan-out ${runId.split(":fanout:").at(-1) ?? runId}`,
			status: terminalStatus,
			active: false,
			depth: 1,
			updatedAt: null,
			children: [],
			metadata: { source: "fanout" },
		});
	}

	return children;
}

/**
 * Augment a `HomeChildRunTree` with within-tedi fan-out children for each
 * delegation node. Reads live slots from the tedi-runtime DO and terminal
 * statuses from `tediRuntimeEvents`. Fail-soft: any per-node failure returns
 * the node with `children: []` (today's behavior) — never throws.
 */
export async function augmentTreeWithFanoutChildren(
	context: BaseContext,
	tree: HomeChildRunTree,
	rows: KernelRuntimeRun[],
): Promise<HomeChildRunTree> {
	// Only process delegation nodes that are not already terminal on the kernel side.
	const activeDelegationNodes = tree.nodes.filter(
		(node) =>
			node.delegatedTediId &&
			node.childRunId &&
			(node.status === "queued" ||
				node.status === "running" ||
				node.status === "streaming" ||
				node.status === "requires_approval"),
	);
	if (activeDelegationNodes.length === 0) return tree;

	// Cap parallel DO calls to 5 to avoid overloading in wide conversations.
	const cappedNodes = activeDelegationNodes.slice(0, 5);

	// Build a slug lookup from the raw rows (metadata.delegatedTediSlug).
	const slugByChildRunId = new Map<string, string>();
	for (const row of rows) {
		if (!row.childRunId) continue;
		const slug =
			typeof (row.metadata as Record<string, unknown> | null)
				?.delegatedTediSlug === "string"
				? (row.metadata as Record<string, unknown>).delegatedTediSlug
				: null;
		if (typeof slug === "string") slugByChildRunId.set(row.childRunId, slug);
	}

	// Parallel: fetch live slots + terminal events for each active delegation node.
	const augmented = await Promise.all(
		cappedNodes.map(async (node) => {
			if (!node.delegatedTediId || !node.childRunId) {
				return { nodeId: node.id, children: [] as HomeChildRunTreeNode[] };
			}
			try {
				const slug = slugByChildRunId.get(node.childRunId) ?? null;
				const [liveSlots, terminalByRunId] = await Promise.all([
					readFanoutSlotsForNode(context, {
						delegatedTediId: node.delegatedTediId,
						childRunId: node.childRunId,
						metadata: slug ? { delegatedTediSlug: slug } : null,
					}),
					readTerminalFanoutRuns(context, node.delegatedTediId),
				]);
				const children = buildFanoutChildNodes({
					homeRunId: node.homeRunId,
					conversationId: node.conversationId,
					delegatedTediId: node.delegatedTediId,
					liveSlots,
					terminalByRunId,
				});
				return { nodeId: node.id, children };
			} catch {
				return { nodeId: node.id, children: [] as HomeChildRunTreeNode[] };
			}
		}),
	);

	if (augmented.every(({ children }) => children.length === 0)) return tree;

	const childrenByNodeId = new Map<string, HomeChildRunTreeNode[]>();
	for (const { nodeId, children } of augmented) {
		if (children.length > 0) childrenByNodeId.set(nodeId, children);
	}

	const augmentedNodes = tree.nodes.map((node) => {
		const fanoutChildren = childrenByNodeId.get(node.id);
		if (!fanoutChildren || fanoutChildren.length === 0) return node;
		return { ...node, children: fanoutChildren };
	});

	return { ...tree, nodes: augmentedNodes };
}

export function buildHomeChildRunTree(input: {
	organizationId: string;
	conversationId: string;
	runs: HomeRun[];
}): HomeChildRunTree {
	const nodes: HomeChildRunTreeNode[] = input.runs.flatMap(
		(run): HomeChildRunTreeNode[] => {
			const metadata = nonNullRecord(run.metadata);
			const plan = nonNullRecord(metadata?.homePlan);
			const assignments = Array.isArray(plan?.assignments)
				? plan.assignments.flatMap((value): HomeChildRunTreeNode[] => {
						const assignment = nonNullRecord(value);
						const delegatedTediId = stringFromPayload(assignment?.ownerTediId);
						const childRunId = stringFromPayload(assignment?.childRunId);
						if (!delegatedTediId && !childRunId) return [];
						const rawStatus = stringFromPayload(assignment?.status);
						const status: HomeChildRunStatus =
							rawStatus === "completed" ||
							rawStatus === "failed" ||
							rawStatus === "canceled" ||
							rawStatus === "queued" ||
							rawStatus === "running" ||
							rawStatus === "streaming"
								? rawStatus
								: "requires_approval";
						const active =
							status === "queued" ||
							status === "running" ||
							status === "streaming" ||
							status === "requires_approval";
						return [
							{
								id: childRunId
									? `child:${delegatedTediId ?? "unknown"}:${childRunId}`
									: `assignment:${run.id}:${stringFromPayload(assignment?.id) ?? delegatedTediId ?? "unknown"}`,
								homeRunId: run.id,
								conversationId: run.conversationId,
								delegatedTediId: delegatedTediId ?? null,
								childRunId: childRunId ?? null,
								parentRunId: run.id,
								label:
									stringFromPayload(assignment?.ownerLabel) ??
									stringFromPayload(assignment?.ownerSlug) ??
									"Tedi",
								status,
								active,
								depth: 1,
								updatedAt: run.updatedAt ?? null,
								children: [],
								metadata: {
									objective: stringFromPayload(assignment?.objective) ?? null,
									preview: stringFromPayload(assignment?.error) ?? null,
									workItemId: stringFromPayload(assignment?.workItemId) ?? null,
								},
							},
						];
					})
				: [];
			if (assignments.length > 0) {
				const status = homeChildRunTreeStatus(run);
				return [
					{
						id: `home:${run.id}`,
						homeRunId: run.id,
						conversationId: run.conversationId,
						delegatedTediId: null,
						childRunId: null,
						parentRunId: null,
						label: "Home plan",
						status,
						active: assignments.some((assignment) => assignment.active),
						depth: 0,
						updatedAt: run.updatedAt ?? null,
						children: assignments,
						metadata: { progress: run.progress },
					},
				];
			}
			if (!run.delegatedTediId && !run.childRunId) return [];
			const status = homeChildRunTreeStatus(run);
			const active =
				status === "queued" ||
				status === "running" ||
				status === "streaming" ||
				status === "requires_approval";
			const childRunId = run.childRunId ?? null;
			const id = childRunId
				? `child:${run.delegatedTediId ?? "unknown"}:${childRunId}`
				: `home:${run.id}`;
			return [
				{
					id,
					homeRunId: run.id,
					conversationId: run.conversationId,
					delegatedTediId: run.delegatedTediId ?? null,
					childRunId,
					parentRunId: null,
					label: homeChildRunTreeLabel(run),
					status,
					active,
					// Home delegations are single-level today; recursive schema stays for future nested delegation.
					depth: 0,
					updatedAt: run.updatedAt ?? null,
					children: [],
					metadata: {
						progress: run.progress,
						preview: nonNullRecord(run.metadata)?.childRunPreview ?? null,
					},
				},
			];
		},
	);
	const activeNodeId = nodes.find((node) => node.active)?.id ?? null;
	return {
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		nodes,
		activeNodeId,
		updatedAt: latestIso(nodes.map((node) => node.updatedAt)),
	};
}
