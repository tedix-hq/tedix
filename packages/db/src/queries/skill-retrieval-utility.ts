import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { DbClient } from "../client";
import { skillRuns, skillUsageEvents } from "../schema/cognitive";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";

const MAX_INJECTIONS = 50;
const MAX_COMPLETIONS = 1_000;
const MAX_WORKFLOW_IDS = 200;
const MAX_SKILLS_PER_INJECTION = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillRetrievalUtilityRow {
	injectionEventId: string;
	turnRunId: string;
	conversationId: string | null;
	skillId: string;
	injectedAt: string;
	/** A completion and canonical run/usage agree on all identities. */
	status: "unknown" | "success" | "failure";
	skillRunId: string | null;
}

export interface SkillRetrievalUtilityResult {
	rows: SkillRetrievalUtilityRow[];
	truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function workflowRunIds(payload: unknown): string[] {
	const value = record(payload);
	if (!value) return [];
	const identity = record(value.resultIdentity);
	if (!identity) return [];
	const name = value.name;
	if (typeof name !== "string") return [];
	if (name.endsWith("run_skill_workflow")) {
		const direct = identity.runId;
		return typeof direct === "string" && UUID.test(direct) ? [direct] : [];
	}
	if (name !== "tedix_mcp_code" && name !== "code") return [];
	const runs = identity.skillWorkflowRuns;
	return Array.isArray(runs)
		? runs.filter((id): id is string => typeof id === "string" && UUID.test(id))
		: [];
}

/**
 * Tenant-scoped, bounded evidence join. Injection alone proves only prompt
 * placement. A retrieved skill counts as used only after an exact same-turn
 * tool completion identifies a workflow run, that canonical run pins the same
 * origin turn and skill, and its terminal usage ledger records an outcome.
 * Missing events remain unknown; timestamps constrain scans, never attribution.
 */
export async function listSkillRetrievalUtility(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		from: string;
		to: string;
		limit?: number;
	},
): Promise<SkillRetrievalUtilityResult> {
	const limit = Math.min(Math.max(input.limit ?? 20, 1), MAX_INJECTIONS);
	const injectionEvents = await db
		.select({
			id: tediRuntimeEvents.id,
			runId: tediRuntimeEvents.runId,
			conversationId: tediRuntimeEvents.conversationId,
			payload: tediRuntimeEvents.payload,
			createdAt: tediRuntimeEvents.createdAt,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.kind, "context.injected"),
				gte(tediRuntimeEvents.createdAt, input.from),
				lte(tediRuntimeEvents.createdAt, input.to),
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt), desc(tediRuntimeEvents.id))
		.limit(limit + 1);
	let truncated = injectionEvents.length > limit;
	const rows: SkillRetrievalUtilityRow[] = [];
	for (const event of injectionEvents.slice(0, limit)) {
		const payload = record(event.payload);
		if (
			!event.runId ||
			payload?.source !== "skill-retrieval" ||
			payload.phase !== "pre-turn-injection" ||
			!Array.isArray(payload.skills)
		)
			continue;
		if (payload.skills.length > MAX_SKILLS_PER_INJECTION) truncated = true;
		const seen = new Set<string>();
		for (const value of payload.skills.slice(0, MAX_SKILLS_PER_INJECTION)) {
			const skillId = record(value)?.skillId;
			if (
				typeof skillId !== "string" ||
				!UUID.test(skillId) ||
				seen.has(skillId)
			)
				continue;
			seen.add(skillId);
			rows.push({
				injectionEventId: event.id,
				turnRunId: event.runId,
				conversationId: event.conversationId,
				skillId,
				injectedAt: event.createdAt,
				status: "unknown",
				skillRunId: null,
			});
		}
	}
	if (rows.length === 0) return { rows, truncated };
	const turnRunIds = [...new Set(rows.map((row) => row.turnRunId))];
	// The run/kind index bounds this read to the injected turns. The cap means a
	// missing completion is unknown rather than an inferred non-use.
	const completions = await db
		.select({
			runId: tediRuntimeEvents.runId,
			payload: tediRuntimeEvents.payload,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.kind, "tool.completed"),
				inArray(tediRuntimeEvents.runId, turnRunIds),
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt))
		.limit(MAX_COMPLETIONS + 1);
	if (completions.length > MAX_COMPLETIONS) truncated = true;
	const completionByTurn = new Map<string, Set<string>>();
	for (const event of completions.slice(0, MAX_COMPLETIONS)) {
		if (!event.runId) continue;
		const ids = workflowRunIds(event.payload);
		if (!ids.length) continue;
		const set = completionByTurn.get(event.runId) ?? new Set<string>();
		for (const id of ids) set.add(id);
		completionByTurn.set(event.runId, set);
	}
	const workflowIds = [
		...new Set([...completionByTurn.values()].flatMap((ids) => [...ids])),
	];
	if (workflowIds.length > MAX_WORKFLOW_IDS) truncated = true;
	const selectedIds = workflowIds.slice(0, MAX_WORKFLOW_IDS);
	if (!selectedIds.length) return { rows, truncated };
	const runs = [] as Array<{
		id: string;
		skillId: string;
		originTediRunId: string | null;
	}>;
	const usages = [] as Array<{
		runId: string;
		skillId: string;
		outcome: "success" | "failure";
	}>;
	for (let start = 0; start < selectedIds.length; start += 50) {
		const ids = selectedIds.slice(start, start + 50);
		const [runChunk, usageChunk] = await Promise.all([
			db
				.select({
					id: skillRuns.id,
					skillId: skillRuns.skillId,
					originTediRunId: skillRuns.originTediRunId,
				})
				.from(skillRuns)
				.where(
					and(
						eq(skillRuns.organizationId, input.organizationId),
						eq(skillRuns.tediId, input.tediId),
						inArray(skillRuns.id, ids),
					),
				),
			db
				.select({
					runId: skillUsageEvents.runId,
					skillId: skillUsageEvents.skillId,
					outcome: skillUsageEvents.outcome,
				})
				.from(skillUsageEvents)
				.where(
					and(
						eq(skillUsageEvents.organizationId, input.organizationId),
						eq(skillUsageEvents.tediId, input.tediId),
						eq(skillUsageEvents.source, "workflow_run"),
						inArray(skillUsageEvents.runId, ids),
					),
				),
		]);
		runs.push(...runChunk);
		usages.push(...usageChunk);
	}
	const usageByRun = new Map(usages.map((usage) => [usage.runId, usage]));
	for (const row of rows) {
		const exact = runs.find(
			(run) =>
				run.originTediRunId === row.turnRunId &&
				run.skillId === row.skillId &&
				completionByTurn.get(row.turnRunId)?.has(run.id),
		);
		if (!exact) continue;
		const usage = usageByRun.get(exact.id);
		if (!usage || usage.skillId !== row.skillId) continue;
		row.status = usage.outcome;
		row.skillRunId = exact.id;
	}
	return { rows, truncated };
}
