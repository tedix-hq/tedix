import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";
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

type EpisodePaymentCountRow = { decisionId: string; cnt: number };

function sqlValueList(values: readonly string[]) {
	return sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	);
}

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
	const decisions = await db.all<DecisionEpisodeRow>(
		sql`SELECT id, action, category, confidence, outcome_status as outcomeStatus,
				evidence, objective_id as objectiveId, approval_request_id as approvalRequestId,
				run_id as runId, work_item_id as workItemId,
				tool_call_refs as toolCallRefs, proof_ref as proofRef,
				created_at as createdAt, completed_at as completedAt
			FROM tedi_rationale_records
			WHERE tedi_id = ${access.tediId} AND org_id = ${access.orgId}
			ORDER BY created_at DESC
			LIMIT ${limit}`,
	);
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
	const workItemPredicates = [
		...(storedWorkItemIds.length > 0
			? [sql`id IN (${sqlValueList(storedWorkItemIds)})`]
			: []),
		...(objectiveIds.length > 0
			? [sql`objective_id IN (${sqlValueList(objectiveIds)})`]
			: []),
		...decisionIds.flatMap((decisionId) => [
			sql`provenance LIKE ${`%${decisionId}%`}`,
			sql`metadata LIKE ${`%${decisionId}%`}`,
		]),
	];
	const [workItemRows, runtimeLinkRows, paymentRows] = await Promise.all([
		workItemPredicates.length > 0
			? db.all<EpisodeLinkedRow>(
					sql`SELECT id, title as label, created_at as createdAt,
							objective_id as objectiveId, provenance, metadata
						FROM work_items
						WHERE org_id = ${access.orgId}
							AND (${sql.join(workItemPredicates, sql` OR `)})
						ORDER BY created_at DESC`,
				)
			: Promise.resolve([]),
		runIds.length > 0
			? db.all<EpisodeRuntimeLinkRow>(
					sql`SELECT id, run_id as runId, kind, tool_call_id as toolCallId,
							payload
						FROM tedi_runtime_events
						WHERE tedi_id = ${access.tediId}
							AND organization_id = ${access.orgId}
							AND run_id IN (${sqlValueList(runIds)})
							AND kind IN ('tool.completed', 'tool.failed', 'memory.retrieved')
						ORDER BY created_at ASC`,
				)
			: Promise.resolve([]),
		db.all<EpisodePaymentCountRow>(
			sql`SELECT rationale_record_id as decisionId, count(*) as cnt
				FROM mcp_payment_events
				WHERE organization_id = ${access.orgId}
					AND tedi_id = ${access.tediId}
					AND rationale_record_id IN (${sqlValueList(decisionIds)})
				GROUP BY rationale_record_id`,
		),
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
