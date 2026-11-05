import { and, asc, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { tediRuntimeEvents } from "../../schema/cognitive-runtime";
import { mcpPaymentEvents } from "../../schema/mcp-payments";
import { tediRationaleRecords } from "../../schema/rationale-records";
import { workItems } from "../../schema/work-items";
import { extractFactIdsFromFlywheelEvidence } from "./evidence-fact-ids";

interface FlywheelAccess {
	tediId: string;
	orgId: string;
}

function rate(count: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(1, Math.round((count / total) * 1000) / 1000);
}

export interface DecisionEpisodeProjection {
	decisionId: string;
	action: string;
	category: string;
	outcomeStatus: string;
	confidence: number;
	createdAt: string;
	completedAt: string | null;
	objectiveId: string | null;
	approvalRequestId: string | null;
	/** WS1 execution link: the runtime run this decision belongs to. */
	runId: string | null;
	/** WS1 execution links: tool-call refs stored on the record at write time. */
	toolCallRefs: string[];
	/** WS1: span-checkable proof stored with the outcome claim. */
	proofRef: { kind: string; ref: string } | null;
	factIds: string[];
	workItemIds: string[];
	toolCallCount: number;
	paymentEventCount: number;
	nodes: Array<{
		id: string;
		type:
			| "decision"
			| "fact"
			| "outcome"
			| "run"
			| "work_item"
			| "tool_call"
			| "payment"
			| "objective"
			| "approval_request";
		label: string;
		properties: Record<string, unknown>;
	}>;
	edges: Array<{
		source: string;
		target: string;
		type: string;
		properties: Record<string, unknown>;
	}>;
}

export interface DecisionEpisodeQuality {
	episodeCount: number;
	decisionsWithoutFacts: number;
	pendingOutcomes: number;
	episodesWithoutWorkItems: number;
	episodesWithoutToolCalls: number;
	/** WS1 proof gate: episodes with NO runId, work item, or tool-call ref. */
	episodesWithoutExecutionLinks: number;
	/** WS1 proof gate: completed-success episodes carrying a proof ref. */
	episodesWithProofRefs: number;
	episodesWithPayments: number;
	averageEdgesPerEpisode: number;
	gaps: string[];
}

type DecisionEpisodeRow = {
	id: string;
	action: string;
	category: string;
	confidence: number;
	outcomeStatus: string;
	evidence: unknown;
	createdAt: string;
	completedAt: string | null;
	objectiveId: string | null;
	approvalRequestId: string | null;
	runId: string | null;
	workItemId: string | null;
	toolCallRefs: unknown;
	proofRef: unknown;
};

/** Parse a raw JSON TEXT column holding a string array (fail-soft to []). */
function parseStringArrayColumn(value: unknown): string[] {
	const parsed =
		typeof value === "string" && value.length > 0
			? (() => {
					try {
						return JSON.parse(value) as unknown;
					} catch {
						return null;
					}
				})()
			: value;
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((item): item is string => typeof item === "string");
}

/** Parse a raw JSON TEXT column holding a proof ref (fail-soft to null). */
function parseProofRefColumn(
	value: unknown,
): { kind: string; ref: string } | null {
	const parsed =
		typeof value === "string" && value.length > 0
			? (() => {
					try {
						return JSON.parse(value) as unknown;
					} catch {
						return null;
					}
				})()
			: value;
	if (
		parsed &&
		typeof parsed === "object" &&
		typeof (parsed as { kind?: unknown }).kind === "string" &&
		typeof (parsed as { ref?: unknown }).ref === "string"
	) {
		return parsed as { kind: string; ref: string };
	}
	return null;
}

type EpisodeLinkedRow = {
	id: string;
	label: string;
	createdAt: string | null;
	objectiveId: string | null;
	provenance: unknown;
	metadata: unknown;
};

type EpisodeRuntimeLinkRow = {
	id: string;
	runId: string;
	kind: "tool.completed" | "tool.failed" | "memory.retrieved";
	toolCallId: string | null;
	payload: unknown;
};

function serializedJson(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return "";
	}
}

export async function getDecisionEpisodeProjections(
	db: DbClient,
	access: FlywheelAccess,
	limit = 10,
): Promise<DecisionEpisodeProjection[]> {
	const records = tediRationaleRecords;
	// JSON columns stay raw TEXT: the parsers below fail soft on bad rows.
	const decisions: DecisionEpisodeRow[] = await db
		.select({
			id: records.id,
			action: records.action,
			category: records.category,
			confidence: records.confidence,
			outcomeStatus: records.outcomeStatus,
			evidence: sql<unknown>`${records.evidence}`.as("evidence"),
			objectiveId: records.objectiveId,
			approvalRequestId: records.approvalRequestId,
			runId: records.runId,
			workItemId: records.workItemId,
			toolCallRefs: sql<unknown>`${records.toolCallRefs}`.as("toolCallRefs"),
			proofRef: sql<unknown>`${records.proofRef}`.as("proofRef"),
			createdAt: records.createdAt,
			completedAt: records.completedAt,
		})
		.from(records)
		.where(
			and(eq(records.tediId, access.tediId), eq(records.orgId, access.orgId)),
		)
		.orderBy(desc(records.createdAt))
		.limit(limit);
	if (decisions.length === 0) return [];

	const decisionIds = decisions.map((decision) => decision.id);
	const runIds = decisions
		.map((decision) => decision.runId)
		.filter((runId): runId is string => Boolean(runId));
	const storedWorkItemIds = decisions
		.map((decision) => decision.workItemId)
		.filter((workItemId): workItemId is string => Boolean(workItemId));
	const objectiveIds = decisions
		.map((decision) => decision.objectiveId)
		.filter((objectiveId): objectiveId is string => Boolean(objectiveId));
	// Two statements keep each under D1's 100 bound parameters at the API's
	// 25-decision cap (ids + objectives ≤ 50, LIKE pairs ≤ 50).
	const idPredicates = [
		...(storedWorkItemIds.length > 0
			? // bound-params: the decisions page is capped at 25.
				[inArray(workItems.id, storedWorkItemIds)]
			: []),
		...(objectiveIds.length > 0
			? // bound-params: the decisions page is capped at 25.
				[inArray(workItems.objectiveId, objectiveIds)]
			: []),
	];
	const mentionPredicates = decisionIds.flatMap((decisionId) => [
		sql`${workItems.provenance} LIKE ${`%${decisionId}%`}`,
		sql`${workItems.metadata} LIKE ${`%${decisionId}%`}`,
	]);
	const selectLinkedWorkItems = (predicates: SQL[]) =>
		db
			.select({
				id: workItems.id,
				label: workItems.title,
				createdAt: workItems.createdAt,
				objectiveId: workItems.objectiveId,
				provenance: sql<unknown>`${workItems.provenance}`.as("provenance"),
				metadata: sql<unknown>`${workItems.metadata}`.as("metadata"),
			})
			.from(workItems)
			.where(and(eq(workItems.orgId, access.orgId), or(...predicates)))
			.orderBy(desc(workItems.createdAt));
	const [workItemRows, runtimeLinkRows, paymentRows] = await Promise.all([
		Promise.all(
			[idPredicates, mentionPredicates]
				.filter((predicates) => predicates.length > 0)
				.map(selectLinkedWorkItems),
		).then((groups) => {
			const byId = new Map<string, EpisodeLinkedRow>();
			for (const row of groups.flat()) byId.set(row.id, row);
			return [...byId.values()].sort(
				(a, b) => Number(b.createdAt) - Number(a.createdAt),
			);
		}),
		runIds.length > 0
			? db
					.select({
						id: tediRuntimeEvents.id,
						runId: sql<string>`${tediRuntimeEvents.runId}`.as("runId"),
						kind: sql<
							EpisodeRuntimeLinkRow["kind"]
						>`${tediRuntimeEvents.kind}`.as("kind"),
						toolCallId: tediRuntimeEvents.toolCallId,
						payload: sql<unknown>`${tediRuntimeEvents.payload}`.as("payload"),
					})
					.from(tediRuntimeEvents)
					.where(
						and(
							eq(tediRuntimeEvents.tediId, access.tediId),
							eq(tediRuntimeEvents.organizationId, access.orgId),
							// bound-params: run ids come from the decisions page, capped at 25.
							inArray(tediRuntimeEvents.runId, runIds),
							inArray(tediRuntimeEvents.kind, [
								"tool.completed",
								"tool.failed",
								"memory.retrieved",
							]),
						),
					)
					.orderBy(asc(tediRuntimeEvents.createdAt))
			: Promise.resolve([] as EpisodeRuntimeLinkRow[]),
		db
			.select({
				decisionId: sql<string>`${mcpPaymentEvents.rationaleRecordId}`.as(
					"decisionId",
				),
				cnt: sql<number>`count(*)`.as("cnt"),
			})
			.from(mcpPaymentEvents)
			.where(
				and(
					eq(mcpPaymentEvents.organizationId, access.orgId),
					eq(mcpPaymentEvents.tediId, access.tediId),
					// bound-params: the decisions page is capped at 25.
					inArray(mcpPaymentEvents.rationaleRecordId, decisionIds),
				),
			)
			.groupBy(mcpPaymentEvents.rationaleRecordId),
	]);
	const runtimeLinksByRun = new Map<string, EpisodeRuntimeLinkRow[]>();
	for (const row of runtimeLinkRows) {
		const rows = runtimeLinksByRun.get(row.runId) ?? [];
		rows.push(row);
		runtimeLinksByRun.set(row.runId, rows);
	}
	const paymentCountByDecision = new Map(
		paymentRows.map((row) => [row.decisionId, row.cnt]),
	);

	return decisions.map((decision) => {
		const runtimeLinks = decision.runId
			? (runtimeLinksByRun.get(decision.runId) ?? [])
			: [];
		const runtimeFactIds = runtimeLinks
			.filter((row) => row.kind === "memory.retrieved")
			.flatMap((row) => extractFactIdsFromFlywheelEvidence(row.payload));
		const factIds = [
			...new Set([
				...extractFactIdsFromFlywheelEvidence(decision.evidence),
				...runtimeFactIds,
			]),
		];
		const storedToolCallRefs = parseStringArrayColumn(decision.toolCallRefs);
		const runtimeToolCallRefs = runtimeLinks
			.filter(
				(row) => row.kind === "tool.completed" || row.kind === "tool.failed",
			)
			.map((row) => row.toolCallId ?? row.id);
		const toolCallRefs = [
			...new Set(
				storedToolCallRefs.length > 0
					? storedToolCallRefs
					: runtimeToolCallRefs,
			),
		];
		const proofRef = parseProofRefColumn(decision.proofRef);
		const workItemsRows = workItemRows.filter((row) => {
			if (row.id === decision.workItemId) return true;
			if (decision.objectiveId && row.objectiveId === decision.objectiveId) {
				return true;
			}
			return `${serializedJson(row.provenance)} ${serializedJson(row.metadata)}`.includes(
				decision.id,
			);
		});
		const paymentEventCount = paymentCountByDecision.get(decision.id) ?? 0;
		const nodes: DecisionEpisodeProjection["nodes"] = [
			{
				id: decision.id,
				type: "decision",
				label: decision.action,
				properties: {
					category: decision.category,
					confidence: decision.confidence,
					createdAt: decision.createdAt,
				},
			},
			...factIds.map((factId) => ({
				id: factId,
				type: "fact" as const,
				label: factId,
				properties: { source: "rationale.evidence.factIds" },
			})),
			{
				id: `${decision.id}:outcome`,
				type: "outcome",
				label: decision.outcomeStatus,
				properties: { completedAt: decision.completedAt },
			},
			...workItemsRows.map((item) => ({
				id: item.id,
				type: "work_item" as const,
				label: item.label,
				properties: { createdAt: item.createdAt },
			})),
		];
		if (
			decision.workItemId &&
			!workItemsRows.some((row) => row.id === decision.workItemId)
		) {
			nodes.push({
				id: decision.workItemId,
				type: "work_item",
				label: "Linked work item",
				properties: { source: "rationale.workItemId" },
			});
		}
		if (decision.runId) {
			nodes.push({
				id: decision.runId,
				type: "run",
				label: "Run",
				properties: { source: "rationale.runId" },
			});
		}
		if (decision.objectiveId) {
			nodes.push({
				id: decision.objectiveId,
				type: "objective",
				label: "Objective",
				properties: { source: "rationale.objectiveId" },
			});
		}
		if (decision.approvalRequestId) {
			nodes.push({
				id: decision.approvalRequestId,
				type: "approval_request",
				label: "Approval request",
				properties: { source: "rationale.approvalRequestId" },
			});
		}
		const toolCallCount = toolCallRefs.length;
		if (toolCallCount) {
			nodes.push({
				id: `${decision.id}:tool_calls`,
				type: "tool_call",
				label: `${toolCallCount} tool calls`,
				properties: {
					count: toolCallCount,
					refs: toolCallRefs,
					source:
						storedToolCallRefs.length > 0
							? "rationale.toolCallRefs"
							: "tedi_runtime_events.runId",
				},
			});
		}
		if (paymentEventCount) {
			nodes.push({
				id: `${decision.id}:payments`,
				type: "payment",
				label: `${paymentEventCount} payment events`,
				properties: { count: paymentEventCount },
			});
		}
		const edges: DecisionEpisodeProjection["edges"] = [
			...factIds.map((factId) => ({
				source: decision.id,
				target: factId,
				type: "CITES",
				properties: {},
			})),
			{
				source: decision.id,
				target: `${decision.id}:outcome`,
				type: "COMPLETED_AS",
				properties: { outcomeStatus: decision.outcomeStatus },
			},
			...workItemsRows.map((item) => ({
				source: item.id,
				target: decision.id,
				type: "EXPLAINED_BY",
				properties: {},
			})),
		];
		if (
			decision.workItemId &&
			!workItemsRows.some((row) => row.id === decision.workItemId)
		) {
			edges.push({
				source: decision.workItemId,
				target: decision.id,
				type: "EXPLAINED_BY",
				properties: { source: "rationale.workItemId" },
			});
		}
		if (decision.runId) {
			edges.push({
				source: decision.id,
				target: decision.runId,
				type: "EXECUTED_IN",
				properties: {},
			});
		}
		if (decision.objectiveId) {
			edges.push({
				source: decision.id,
				target: decision.objectiveId,
				type: "SERVES_OBJECTIVE",
				properties: {},
			});
		}
		if (decision.approvalRequestId) {
			edges.push({
				source: decision.id,
				target: decision.approvalRequestId,
				type: "GATED_BY",
				properties: {},
			});
		}
		if (toolCallCount) {
			edges.push({
				source: decision.id,
				target: `${decision.id}:tool_calls`,
				type: "EXECUTED",
				properties: {},
			});
		}
		if (paymentEventCount) {
			edges.push({
				source: decision.id,
				target: `${decision.id}:payments`,
				type: "SPENT_OR_REQUESTED",
				properties: {},
			});
		}
		const workItemIds = [
			...(decision.workItemId &&
			!workItemsRows.some((row) => row.id === decision.workItemId)
				? [decision.workItemId]
				: []),
			...workItemsRows.map((row) => row.id),
		];
		return {
			decisionId: decision.id,
			action: decision.action,
			category: decision.category,
			outcomeStatus: decision.outcomeStatus,
			confidence: decision.confidence,
			createdAt: decision.createdAt,
			completedAt: decision.completedAt,
			objectiveId: decision.objectiveId,
			approvalRequestId: decision.approvalRequestId,
			runId: decision.runId,
			toolCallRefs,
			proofRef,
			factIds,
			workItemIds,
			toolCallCount,
			paymentEventCount,
			nodes,
			edges,
		};
	});
}

export function buildDecisionEpisodeQuality(
	episodes: DecisionEpisodeProjection[],
): DecisionEpisodeQuality {
	const episodeCount = episodes.length;
	const decisionsWithoutFacts = episodes.filter(
		(episode) => episode.factIds.length === 0,
	).length;
	const pendingOutcomes = episodes.filter(
		(episode) => episode.outcomeStatus === "pending",
	).length;
	const episodesWithoutWorkItems = episodes.filter(
		(episode) => episode.workItemIds.length === 0,
	).length;
	const episodesWithoutToolCalls = episodes.filter(
		(episode) => episode.toolCallCount === 0,
	).length;
	// WS1 proof gate: the write-time invariant is observable here — fresh
	// episodes must all carry >=1 execution link.
	const episodesWithoutExecutionLinks = episodes.filter(
		(episode) =>
			!episode.runId &&
			episode.workItemIds.length === 0 &&
			episode.toolCallRefs.length === 0,
	).length;
	const episodesWithProofRefs = episodes.filter(
		(episode) => episode.proofRef !== null,
	).length;
	const episodesWithPayments = episodes.filter(
		(episode) => episode.paymentEventCount > 0,
	).length;
	const averageEdgesPerEpisode =
		episodeCount === 0
			? 0
			: Math.round(
					(episodes.reduce((sum, episode) => sum + episode.edges.length, 0) /
						episodeCount) *
						100,
				) / 100;
	const rateFor = (count: number) => rate(count, Math.max(episodeCount, 1));
	const gaps = [
		episodeCount === 0 ? "no recent decision episodes" : null,
		rateFor(decisionsWithoutFacts) > 0.3
			? "many decisions lack cited facts"
			: null,
		rateFor(pendingOutcomes) > 0.5
			? "many decisions are still missing outcomes"
			: null,
		rateFor(episodesWithoutWorkItems) > 0.8
			? "decision episodes rarely link to Work Items"
			: null,
		rateFor(episodesWithoutToolCalls) > 0.8
			? "decision episodes rarely link to tool execution"
			: null,
		episodesWithoutExecutionLinks > 0
			? "some decision episodes carry NO execution link (predate the WS1 write invariant)"
			: null,
		averageEdgesPerEpisode < 2 && episodeCount > 0
			? "episode graph is thin"
			: null,
	].filter((gap): gap is string => Boolean(gap));

	return {
		episodeCount,
		decisionsWithoutFacts,
		pendingOutcomes,
		episodesWithoutWorkItems,
		episodesWithoutToolCalls,
		episodesWithoutExecutionLinks,
		episodesWithProofRefs,
		episodesWithPayments,
		averageEdgesPerEpisode,
		gaps,
	};
}
