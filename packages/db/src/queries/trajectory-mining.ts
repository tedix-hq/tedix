/**
 * Trajectory pattern mining (WS2 — trace↔skill coupling).
 *
 * Skills are born from demonstrated routines: this module mines recurring
 * successful tool-call sequences from WS1 evidence-linked rationale episodes
 * (`tedi_rationale_records.tool_call_refs`) and composes Skill Workshop
 * `propose_skill` payloads from the qualifying patterns (Agent Workflow
 * Memory / Trace2Skill).
 *
 * Doctrine (PMAx: separate computation from interpretation):
 * - Detection is DETERMINISTIC SQL/TS — no LLM calls anywhere in this module.
 * - A pattern qualifies only with support >= 3 DISTINCT successful runs, and
 *   every run in the support set carries a WS1 proof ref (`proof_ref` present
 *   on a `success` rationale record).
 * - Proposals always populate `toolIds` and always flow through the Skill
 *   Workshop gate (`propose_skill` → draft) — never auto-applied. This is the
 *   explicit guard against the April-2026 auto-skill-bridge failure (~200
 *   toolId-less auto-skills, since removed).
 *
 * Pure functions live at the top; the two thin D1 reads live at the bottom.
 * Writers (proposal creation) stay in `apps/api` (`skills.mineCandidates`).
 */

import {
	and,
	desc,
	eq,
	exists,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import { skillEntries, skillRuns } from "../schema/cognitive";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { tediRationaleRecords } from "../schema/rationale-records";
import { appTools } from "../schema/tools";

// ============================================================================
// Constants
// ============================================================================

/** Tag stamped on every trajectory-mined proposal. */
export const TRAJECTORY_MINED_TAG = "trajectory-mined";

/** Tag prefix carrying the deterministic pattern key hash (dedupe anchor). */
export const TRAJECTORY_PATTERN_TAG_PREFIX = "trajectory:";

/** A routine must recur in at least this many DISTINCT successful runs. */
export const DEFAULT_MIN_SUPPORT = 3;

/** Minimum tool-call sequence length worth crystallizing. */
export const DEFAULT_MIN_SEQUENCE_LENGTH = 2;

/** Contiguous window ceiling — longer routines belong in skill workflows. */
export const DEFAULT_MAX_SEQUENCE_LENGTH = 8;

/**
 * A sequence must involve at least this many DISTINCT tools. Blocks the
 * degenerate `code, code` / `bash, bash` repetition patterns that carry no
 * routine structure.
 */
export const DEFAULT_MIN_DISTINCT_TOOLS = 2;

/** Delimiter for the human-readable pattern key. */
const KEY_DELIMITER = " > ";

// ============================================================================
// Types
// ============================================================================

/** Parsed WS1 tool-call ref: `{runId}:step:{stepNumber}[:{index}]:{toolName}`. */
export interface ParsedToolCallRef {
	runId: string;
	stepNumber: number;
	index: number;
	toolName: string;
}

/** The subset of a linked rationale episode the miner reads. */
export interface LinkedEpisodeRecord {
	runId: string | null;
	toolCallRefs: string[] | null;
}

/** One run's ordered tool-name sequence, rebuilt from its refs. */
export interface RunToolSequence {
	runId: string;
	tools: string[];
}

export interface MineOptions {
	minSupport?: number;
	minLength?: number;
	maxLength?: number;
	minDistinctTools?: number;
}

/** A recurring tool-call sequence with its supporting run evidence. */
export interface MinedToolSequencePattern {
	/** Ordered tool names of the routine. */
	tools: string[];
	/** Human-readable deterministic key: tools joined with " > ". */
	key: string;
	/** Number of DISTINCT runs the sequence occurred in. */
	support: number;
	/** The distinct run ids supporting the pattern (evidence citations). */
	supportRunIds: string[];
}

/** The subset of an existing skill row the dedupe check reads. */
export interface ExistingSkillForDedupe {
	id: string;
	title: string | null;
	toolIds: string[] | null;
	tags: string[] | null;
	lifecycleState: string | null;
}

export interface PatternDedupeResult {
	novel: MinedToolSequencePattern[];
	skipped: Array<{
		key: string;
		reason: "existing_skill_tool_sequence" | "existing_trajectory_proposal";
		skillId: string;
	}>;
}

/**
 * Canonical identity resolution for runtime-facing tool names. A name is safe
 * to persist in `skill_entries.tool_ids` only when exactly one materialized
 * `app_tools` row owns it. Missing and multi-app names stay explicit so the
 * caller can report why a mined pattern was refused.
 */
export interface ToolNameResolution {
	toolIdByName: Map<string, string>;
	unresolved: string[];
	ambiguous: string[];
}

export interface PatternResolutionResult {
	resolved: MinedToolSequencePattern[];
	skipped: Array<{
		key: string;
		reason: "unresolved_tool_identity" | "ambiguous_tool_identity";
		toolNames: string[];
	}>;
}

/**
 * A mechanically templated Skill Workshop proposal payload — the exact field
 * subset `skills.proposeWorkshop` (`propose_skill`) accepts. No LLM polish:
 * the in-repo consolidation path (brain-bridge crystallizer) templates
 * mechanically, so this composer does too.
 */
export interface TrajectorySkillProposalDraft {
	title: string;
	summary: string;
	description: string;
	content: string;
	toolIds: string[];
	tags: string[];
	domain: string;
	revisionReasoning: string;
}

// ============================================================================
// Pure functions — parsing and sequence extraction
// ============================================================================

/**
 * Parse one WS1 tool-call ref. Canonical shape (do.ts `toolCallRefsForRun`):
 * `{runId}:step:{stepNumber}:{index}:{toolName}`. The documented legacy shape
 * `{runId}:step:{stepNumber}:{toolName}` (no index) is tolerated. `runId` may
 * itself contain colons (fireKeys do), so the parser anchors on the LAST
 * `:step:` marker rather than splitting the whole string.
 */
export function parseToolCallRef(ref: string): ParsedToolCallRef | null {
	const marker = ":step:";
	const at = ref.lastIndexOf(marker);
	if (at <= 0) return null;
	const runId = ref.slice(0, at);
	const rest = ref.slice(at + marker.length).split(":");
	if (rest.length < 2) return null;
	const stepNumber = Number(rest[0]);
	if (!Number.isInteger(stepNumber) || stepNumber < 0) return null;
	if (rest.length === 2) {
		const toolName = rest[1]?.trim();
		if (!toolName) return null;
		return { runId, stepNumber, index: 0, toolName };
	}
	const maybeIndex = Number(rest[1]);
	if (Number.isInteger(maybeIndex) && maybeIndex >= 0) {
		const toolName = rest.slice(2).join(":").trim();
		if (!toolName) return null;
		return { runId, stepNumber, index: maybeIndex, toolName };
	}
	const toolName = rest.slice(1).join(":").trim();
	if (!toolName) return null;
	return { runId, stepNumber, index: 0, toolName };
}

/**
 * Rebuild per-run ordered tool-name sequences from linked episode records.
 * Multiple rationale records for the same run merge (refs dedupe by identity);
 * ordering is (stepNumber, index). The ref's own embedded runId is
 * authoritative; unparsable refs are skipped.
 */
export function extractRunToolSequences(
	records: readonly LinkedEpisodeRecord[],
): RunToolSequence[] {
	const byRun = new Map<string, Map<string, ParsedToolCallRef>>();
	for (const record of records) {
		for (const ref of record.toolCallRefs ?? []) {
			const parsed = parseToolCallRef(ref);
			if (!parsed) continue;
			let refs = byRun.get(parsed.runId);
			if (!refs) {
				refs = new Map();
				byRun.set(parsed.runId, refs);
			}
			refs.set(ref, parsed);
		}
	}
	const sequences: RunToolSequence[] = [];
	for (const [runId, refs] of byRun) {
		const ordered = [...refs.values()].sort(
			(a, b) => a.stepNumber - b.stepNumber || a.index - b.index,
		);
		if (ordered.length === 0) continue;
		sequences.push({ runId, tools: ordered.map((r) => r.toolName) });
	}
	return sequences.sort((a, b) => a.runId.localeCompare(b.runId));
}

// ============================================================================
// Pure functions — pattern mining
// ============================================================================

/** Deterministic human-readable pattern key. */
export function toolSequenceKey(tools: readonly string[]): string {
	return tools.join(KEY_DELIMITER);
}

/**
 * Deterministic short hash of a pattern key (FNV-1a, 8 hex chars) — used in
 * proposal titles/tags so re-mining the same routine is exactly detectable.
 */
export function toolSequenceHash(tools: readonly string[]): string {
	const key = toolSequenceKey(tools);
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Whether `inner` occurs as a CONTIGUOUS subsequence of `outer`. */
function isContiguousSubsequence(
	inner: readonly string[],
	outer: readonly string[],
): boolean {
	if (inner.length > outer.length) return false;
	const paddedOuter = `${KEY_DELIMITER}${toolSequenceKey(outer)}${KEY_DELIMITER}`;
	const paddedInner = `${KEY_DELIMITER}${toolSequenceKey(inner)}${KEY_DELIMITER}`;
	return paddedOuter.includes(paddedInner);
}

/**
 * Mine recurring contiguous tool-call sequences across runs.
 *
 * Recurrence criteria (all mechanical):
 * - contiguous window of `minLength..maxLength` tools within one run;
 * - a pattern counts AT MOST ONCE per run (support = distinct runs);
 * - `support >= minSupport` (default 3);
 * - at least `minDistinctTools` distinct tool names (default 2) — kills
 *   degenerate single-tool repetition;
 * - maximality: a qualifying pattern contained in a longer qualifying pattern
 *   with equal-or-higher support is dropped (the longer routine subsumes it;
 *   a shorter pattern survives only when it has STRICTLY more support).
 *
 * Output is deterministically ordered: support desc, length desc, key asc.
 */
export function mineToolSequencePatterns(
	runs: readonly RunToolSequence[],
	options: MineOptions = {},
): MinedToolSequencePattern[] {
	const minSupport = Math.max(options.minSupport ?? DEFAULT_MIN_SUPPORT, 1);
	const minLength = Math.max(
		options.minLength ?? DEFAULT_MIN_SEQUENCE_LENGTH,
		2,
	);
	const maxLength = Math.max(
		options.maxLength ?? DEFAULT_MAX_SEQUENCE_LENGTH,
		minLength,
	);
	const minDistinctTools = Math.max(
		options.minDistinctTools ?? DEFAULT_MIN_DISTINCT_TOOLS,
		1,
	);

	const byKey = new Map<string, { tools: string[]; runIds: Set<string> }>();
	for (const run of runs) {
		if (!run.runId || run.tools.length < minLength) continue;
		const seenInRun = new Set<string>();
		for (let start = 0; start < run.tools.length; start++) {
			const windowMax = Math.min(maxLength, run.tools.length - start);
			for (let length = minLength; length <= windowMax; length++) {
				const tools = run.tools.slice(start, start + length);
				const key = toolSequenceKey(tools);
				if (seenInRun.has(key)) continue;
				seenInRun.add(key);
				let entry = byKey.get(key);
				if (!entry) {
					entry = { tools, runIds: new Set() };
					byKey.set(key, entry);
				}
				entry.runIds.add(run.runId);
			}
		}
	}

	const qualifying: MinedToolSequencePattern[] = [];
	for (const [key, entry] of byKey) {
		if (entry.runIds.size < minSupport) continue;
		if (new Set(entry.tools).size < minDistinctTools) continue;
		qualifying.push({
			tools: entry.tools,
			key,
			support: entry.runIds.size,
			supportRunIds: [...entry.runIds].sort(),
		});
	}

	const maximal = qualifying.filter(
		(pattern) =>
			!qualifying.some(
				(other) =>
					other.key !== pattern.key &&
					other.tools.length > pattern.tools.length &&
					other.support >= pattern.support &&
					isContiguousSubsequence(pattern.tools, other.tools),
			),
	);

	return maximal.sort(
		(a, b) =>
			b.support - a.support ||
			b.tools.length - a.tools.length ||
			a.key.localeCompare(b.key),
	);
}

// ============================================================================
// Pure functions — dedupe + proposal composition
// ============================================================================

/**
 * Drop patterns that already exist as a skill or an open/settled trajectory
 * proposal. A pattern is a duplicate when an existing skill either:
 * - carries the exact `trajectory:{hash}` tag (any lifecycle state — a
 *   rejected/archived mined proposal stays rejected; do not re-propose it), or
 * - has the SAME ordered `toolIds` sequence and is not archived (matched
 *   against raw mined tool names AND their resolved app_tool UUIDs).
 */
export function filterNovelPatterns(
	patterns: readonly MinedToolSequencePattern[],
	existing: readonly ExistingSkillForDedupe[],
	toolIdByName: ReadonlyMap<string, string> = new Map(),
): PatternDedupeResult {
	const novel: MinedToolSequencePattern[] = [];
	const skipped: PatternDedupeResult["skipped"] = [];
	for (const pattern of patterns) {
		const patternTag = `${TRAJECTORY_PATTERN_TAG_PREFIX}${toolSequenceHash(pattern.tools)}`;
		const nameKey = toolSequenceKey(pattern.tools);
		const resolvedKey = toolSequenceKey(
			pattern.tools.map((tool) => toolIdByName.get(tool) ?? tool),
		);
		const tagMatch = existing.find((skill) =>
			(skill.tags ?? []).includes(patternTag),
		);
		if (tagMatch) {
			skipped.push({
				key: pattern.key,
				reason: "existing_trajectory_proposal",
				skillId: tagMatch.id,
			});
			continue;
		}
		const sequenceMatch = existing.find((skill) => {
			if (skill.lifecycleState === "archived") return false;
			const skillKey = toolSequenceKey(skill.toolIds ?? []);
			return (
				skillKey.length > 0 &&
				(skillKey === nameKey || skillKey === resolvedKey)
			);
		});
		if (sequenceMatch) {
			skipped.push({
				key: pattern.key,
				reason: "existing_skill_tool_sequence",
				skillId: sequenceMatch.id,
			});
			continue;
		}
		novel.push(pattern);
	}
	return { novel, skipped };
}

/**
 * Bind telemetry-native identities. Mined patterns come exclusively from
 * ledger-corroborated execution refs, so every tool name in them was
 * genuinely executed by the runtime. Names with no `app_tools` row are the
 * runtime's native tools (open_computer, exec, tedix_mcp_code, ...), not
 * hallucinations — bind them as explicit `native:{name}` identities so the
 * binding class stays visible to Workshop reviewers. Ambiguous names (which
 * match MULTIPLE app tools) are left untouched and still fail closed.
 * ONLY telemetry-derived resolutions may pass through this; tool names that
 * originate from LLM text must keep the raw fail-closed resolution.
 */
export function bindNativeTelemetryIdentities(
	resolution: ToolNameResolution,
): ToolNameResolution {
	if (resolution.unresolved.length === 0) return resolution;
	const toolIdByName = new Map(resolution.toolIdByName);
	for (const name of resolution.unresolved) {
		toolIdByName.set(name, `native:${name}`);
	}
	return { toolIdByName, unresolved: [], ambiguous: resolution.ambiguous };
}

/**
 * Fail closed before proposal composition: every runtime name in a pattern
 * must map to exactly one canonical `app_tools.id`. A partially-resolved
 * routine is not a skill binding and must never fall back to raw names.
 */
export function filterPatternsWithCanonicalToolIds(
	patterns: readonly MinedToolSequencePattern[],
	resolution: ToolNameResolution,
): PatternResolutionResult {
	const unresolved = new Set(resolution.unresolved);
	const ambiguous = new Set(resolution.ambiguous);
	const resolved: MinedToolSequencePattern[] = [];
	const skipped: PatternResolutionResult["skipped"] = [];
	for (const pattern of patterns) {
		const ambiguousNames = [
			...new Set(pattern.tools.filter((tool) => ambiguous.has(tool))),
		].sort();
		if (ambiguousNames.length > 0) {
			skipped.push({
				key: pattern.key,
				reason: "ambiguous_tool_identity",
				toolNames: ambiguousNames,
			});
			continue;
		}
		const unresolvedNames = [
			...new Set(
				pattern.tools.filter(
					(tool) => unresolved.has(tool) || !resolution.toolIdByName.has(tool),
				),
			),
		].sort();
		if (unresolvedNames.length > 0) {
			skipped.push({
				key: pattern.key,
				reason: "unresolved_tool_identity",
				toolNames: unresolvedNames,
			});
			continue;
		}
		resolved.push(pattern);
	}
	return { resolved, skipped };
}

/**
 * Compose a Skill Workshop `propose_skill` payload from a mined pattern.
 * Fully mechanical templating (no LLM): title from the tool sequence,
 * `toolIds` from canonical `app_tools` UUIDs, evidence section citing the
 * supporting run ids. Throws if a caller bypasses the fail-closed resolution
 * filter; raw runtime names are never valid stored tool bindings.
 */
export function composeTrajectorySkillProposal(
	pattern: MinedToolSequencePattern,
	options: {
		toolIdByName?: ReadonlyMap<string, string>;
		minSupport?: number;
	} = {},
): TrajectorySkillProposalDraft {
	const hash = toolSequenceHash(pattern.tools);
	const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
	const toolIdByName = options.toolIdByName ?? new Map<string, string>();
	const shownTools = pattern.tools.slice(0, 3);
	const extra = pattern.tools.length - shownTools.length;
	// Clamp so the derived slug stays comfortably under the 64-char slug limit
	// (validateSkillInput INVALID_NAME); the hash suffix keeps titles unique.
	const titleBase =
		`Mined routine ${shownTools.join(" ")}${extra > 0 ? ` plus ${extra}` : ""}`
			.slice(0, 48)
			.trimEnd();
	const title = `${titleBase} ${hash.slice(0, 6)}`;
	const arrowSequence = pattern.tools.join(" → ");
	const summary = `Recurring tool routine observed in ${pattern.support} successful runs: ${arrowSequence}.`;
	const missing = [
		...new Set(pattern.tools.filter((tool) => !toolIdByName.has(tool))),
	];
	if (missing.length > 0) {
		throw new Error(
			`UNRESOLVED_TRAJECTORY_TOOLS: ${missing.sort().join(", ")}`,
		);
	}
	const toolIds = [
		...new Set(pattern.tools.map((tool) => toolIdByName.get(tool)!)),
	];
	const content = [
		`# ${title}`,
		"",
		"Trajectory-mined skill proposal (Agent Workflow Memory pattern). This",
		`routine recurred in ${pattern.support} distinct successful, proof-carrying`,
		"runs. Review, refine the narrative, and promote through the Skill",
		"Workshop (`inspect_skill_proposal` → `apply_skill_proposal`); it is a",
		"draft, not org guidance, until applied.",
		"",
		"## Routine",
		"",
		...pattern.tools.map((tool, index) => `${index + 1}. \`${tool}\``),
		"",
		"## Evidence",
		"",
		'Supporting runs (rationale `outcome_status = "success"` with WS1 proof refs):',
		"",
		...pattern.supportRunIds.map((runId) => `- \`${runId}\``),
		"",
		"## Provenance",
		"",
		"- Miner: deterministic trajectory pattern miner (WS2) — no LLM detection.",
		`- Pattern key: \`${pattern.key}\``,
		`- Support: ${pattern.support} distinct runs (threshold >= ${minSupport}).`,
	].join("\n");
	return {
		title,
		summary,
		description: summary,
		content,
		toolIds,
		tags: [TRAJECTORY_MINED_TAG, `${TRAJECTORY_PATTERN_TAG_PREFIX}${hash}`],
		domain: "trajectory-mined",
		revisionReasoning: `Trajectory miner: routine recurred in ${pattern.support} successful runs (${pattern.supportRunIds.join(", ")}).`,
	};
}

// ============================================================================
// D1 reads
// ============================================================================

export interface ListLinkedSuccessfulEpisodesOptions {
	orgId: string;
	tediId?: string;
	/** ISO 8601 lower bound on `created_at`. */
	since: string;
	limit?: number;
}

/**
 * WS1 evidence-linked, PROVEN-successful episodes: `outcome_status='success'`,
 * `proof_ref` present, `run_id` + `tool_call_refs` present. These rows are the
 * miner's only input — unproven or unlinked work never seeds a skill.
 *
 * Corroboration gate (mining fail-closes; the rationale record itself stays
 * valid): a proof_ref derived from the record's own runId is SELF-ATTESTED —
 * the writer supplied the runId it then "proved" with. Support-set
 * qualification therefore requires independent execution evidence:
 * - skill-workflow runIds must have a `skill_runs` row that COMPLETED;
 * - any other runId must be corroborated by the runtime event ledger —
 *   run-scoped `tedi_runtime_events` rows written by the runtime for the same
 *   tedi/org/run. Fabricated runIds have neither and never reach support >= 3.
 */
export async function listLinkedSuccessfulEpisodes(
	db: DbClient,
	options: ListLinkedSuccessfulEpisodesOptions,
): Promise<LinkedEpisodeRecord[]> {
	const conditions = [
		eq(tediRationaleRecords.orgId, options.orgId),
		eq(tediRationaleRecords.outcomeStatus, "success"),
		isNotNull(tediRationaleRecords.proofRef),
		isNotNull(tediRationaleRecords.runId),
		isNotNull(tediRationaleRecords.toolCallRefs),
		// A rationale stamped success at dispatch time is not execution proof.
		// For canonical skill workflow runs, require the durable run itself to
		// have completed. Any other runId must exist in the runtime event
		// ledger (self-attested run ids fail closed for mining only). The
		// tedi-scoped correlation rides idx_tedi_runtime_events_run.
		or(
			eq(skillRuns.status, "completed"),
			and(
				isNull(skillRuns.id),
				exists(
					db
						.select({ one: sql`1` })
						.from(tediRuntimeEvents)
						.where(
							and(
								eq(tediRuntimeEvents.tediId, tediRationaleRecords.tediId),
								eq(tediRuntimeEvents.runId, tediRationaleRecords.runId),
								eq(
									tediRuntimeEvents.organizationId,
									tediRationaleRecords.orgId,
								),
							),
						),
				),
			),
		),
		gte(tediRationaleRecords.createdAt, options.since),
	];
	if (options.tediId) {
		conditions.push(eq(tediRationaleRecords.tediId, options.tediId));
	}
	const rows = await db
		.select({
			runId: tediRationaleRecords.runId,
			toolCallRefs: tediRationaleRecords.toolCallRefs,
		})
		.from(tediRationaleRecords)
		.leftJoin(
			skillRuns,
			and(
				eq(skillRuns.id, tediRationaleRecords.runId),
				eq(skillRuns.organizationId, tediRationaleRecords.orgId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(tediRationaleRecords.createdAt))
		.limit(Math.min(options.limit ?? 500, 2000));
	return rows;
}

/**
 * Existing skills relevant to the dedupe check: any org skill with a toolIds
 * sequence, plus every trajectory-tagged row regardless of toolIds (covers
 * archived/rejected mined proposals).
 */
export async function listSkillsForTrajectoryDedupe(
	db: DbClient,
	orgId: string,
): Promise<ExistingSkillForDedupe[]> {
	return db
		.select({
			id: skillEntries.id,
			title: skillEntries.title,
			toolIds: skillEntries.toolIds,
			tags: skillEntries.tags,
			lifecycleState: skillEntries.lifecycleState,
		})
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, orgId),
				or(
					isNotNull(skillEntries.toolIds),
					like(skillEntries.tags, `%${TRAJECTORY_MINED_TAG}%`),
				),
			),
		);
}

/**
 * Resolve mined runtime tool names against `app_tools.tool_id`. Only
 * UNAMBIGUOUS names map; missing and multi-app names are returned explicitly
 * so proposal creation can refuse them instead of persisting raw names.
 */
export async function resolveToolNamesToAppToolIds(
	db: DbClient,
	toolNames: readonly string[],
): Promise<ToolNameResolution> {
	const unique = [...new Set(toolNames)].filter(Boolean);
	if (unique.length === 0) {
		return { toolIdByName: new Map(), unresolved: [], ambiguous: [] };
	}
	const parsed = unique.map((runtimeName) => {
		const dot = runtimeName.lastIndexOf(".");
		if (dot <= 0 || dot === runtimeName.length - 1) {
			return { runtimeName, method: runtimeName, namespace: null };
		}
		return {
			runtimeName,
			method: runtimeName.slice(dot + 1),
			namespace: runtimeName.slice(0, dot),
		};
	});
	const methods = [...new Set(parsed.map((item) => item.method))];
	const rows = await db
		.select({ id: appTools.id, toolId: appTools.toolId, appSlug: apps.slug })
		.from(appTools)
		.innerJoin(apps, eq(appTools.appId, apps.id))
		.where(inArray(appTools.toolId, methods));
	const mapping = new Map<string, string>();
	const unresolved: string[] = [];
	const ambiguous: string[] = [];
	for (const item of parsed) {
		const candidates = item.namespace
			? new Set([
					item.namespace,
					item.namespace.replaceAll("_", "-"),
					`${item.namespace.replaceAll("_", "-")}-tedix`,
				])
			: null;
		const matches = rows.filter(
			(row) =>
				row.toolId === item.method &&
				(!candidates || candidates.has(row.appSlug)),
		);
		if (matches.length === 1) {
			mapping.set(item.runtimeName, matches[0]!.id);
		} else if (matches.length === 0) {
			unresolved.push(item.runtimeName);
		} else {
			ambiguous.push(item.runtimeName);
		}
	}
	return {
		toolIdByName: mapping,
		unresolved: unresolved.sort(),
		ambiguous: ambiguous.sort(),
	};
}
