/**
 * Trajectory pattern miner tests (WS2 — trace↔skill coupling).
 *
 * Pure-function coverage over synthetic WS1 linked-rationale fixtures:
 * ref parsing, per-run sequence extraction, recurrence/support counting,
 * dedupe against existing skills/proposals, and Workshop payload composition
 * (validated against the REAL `propose_skill` contract input schema).
 */

import { DatabaseSync } from "node:sqlite";
import { SkillWorkshopProposeInputSchema } from "@tedix/api-contract/contracts/cognitive";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	bindNativeTelemetryIdentities,
	composeTrajectorySkillProposal,
	extractRunToolSequences,
	filterNovelPatterns,
	filterPatternsWithCanonicalToolIds,
	type LinkedEpisodeRecord,
	listLinkedSuccessfulEpisodes,
	mineToolSequencePatterns,
	parseToolCallRef,
	TRAJECTORY_MINED_TAG,
	TRAJECTORY_PATTERN_TAG_PREFIX,
	toolSequenceHash,
	toolSequenceKey,
} from "./trajectory-mining";

// ============================================================================
// Fixtures
// ============================================================================

function refsForRun(runId: string, tools: string[]): string[] {
	return tools.map((tool, i) => `${runId}:step:${i + 1}:0:${tool}`);
}

function episode(runId: string, tools: string[]): LinkedEpisodeRecord {
	return { runId, toolCallRefs: refsForRun(runId, tools) };
}

/** N distinct runs, each executing the same tool sequence. */
function recurringRuns(
	count: number,
	tools: string[],
	prefix = "run",
): LinkedEpisodeRecord[] {
	return Array.from({ length: count }, (_, i) =>
		episode(`${prefix}-${i + 1}`, tools),
	);
}

// ============================================================================
// parseToolCallRef
// ============================================================================

describe("parseToolCallRef", () => {
	it("parses the canonical 5-part shape with colons inside runId", () => {
		// Cron runIds embed colon-delimited fireKeys.
		const parsed = parseToolCallRef(
			"tedi-1:cron:job-9:1752600000:step:3:1:list_skills",
		);
		expect(parsed).toEqual({
			runId: "tedi-1:cron:job-9:1752600000",
			stepNumber: 3,
			index: 1,
			toolName: "list_skills",
		});
	});

	it("tolerates the documented legacy 4-part shape (no index)", () => {
		const parsed = parseToolCallRef("run-1:step:2:get_skill");
		expect(parsed).toEqual({
			runId: "run-1",
			stepNumber: 2,
			index: 0,
			toolName: "get_skill",
		});
	});

	it("rejects refs without a :step: marker or tool name", () => {
		expect(parseToolCallRef("run-1:directives:3")).toBeNull();
		expect(parseToolCallRef("run-1:step:2")).toBeNull();
		expect(parseToolCallRef("run-1:step:x:0:tool")).toBeNull();
		expect(parseToolCallRef(":step:1:0:tool")).toBeNull();
	});
});

// ============================================================================
// extractRunToolSequences
// ============================================================================

describe("extractRunToolSequences", () => {
	it("groups refs per run, ordered by (stepNumber, index)", () => {
		const records: LinkedEpisodeRecord[] = [
			{
				runId: "run-1",
				toolCallRefs: [
					"run-1:step:2:0:get_skill",
					"run-1:step:1:1:read_file",
					"run-1:step:1:0:list_skills",
				],
			},
		];
		const runs = extractRunToolSequences(records);
		expect(runs).toEqual([
			{ runId: "run-1", tools: ["list_skills", "read_file", "get_skill"] },
		]);
	});

	it("merges multiple rationale records of the same run and dedupes identical refs", () => {
		const records: LinkedEpisodeRecord[] = [
			{
				runId: "run-1",
				toolCallRefs: [
					"run-1:step:1:0:list_skills",
					"run-1:step:2:0:get_skill",
				],
			},
			{
				runId: "run-1",
				toolCallRefs: [
					"run-1:step:2:0:get_skill",
					"run-1:step:3:0:improve_skill",
				],
			},
		];
		const runs = extractRunToolSequences(records);
		expect(runs).toEqual([
			{
				runId: "run-1",
				tools: ["list_skills", "get_skill", "improve_skill"],
			},
		]);
	});

	it("skips unparsable refs and empty records", () => {
		const runs = extractRunToolSequences([
			{ runId: "run-1", toolCallRefs: ["garbage", "run-1:step:1:0:code"] },
			{ runId: "run-2", toolCallRefs: null },
		]);
		expect(runs).toEqual([{ runId: "run-1", tools: ["code"] }]);
	});
});

// ============================================================================
// mineToolSequencePatterns
// ============================================================================

describe("mineToolSequencePatterns", () => {
	it("finds a routine that recurs in >=3 distinct successful runs", () => {
		const runs = extractRunToolSequences(
			recurringRuns(3, ["list_skills", "get_skill", "improve_skill"]),
		);
		const patterns = mineToolSequencePatterns(runs);
		expect(patterns).toHaveLength(1);
		expect(patterns[0]).toMatchObject({
			tools: ["list_skills", "get_skill", "improve_skill"],
			key: "list_skills > get_skill > improve_skill",
			support: 3,
			supportRunIds: ["run-1", "run-2", "run-3"],
		});
	});

	it("counts support per DISTINCT run — repeats within one run count once", () => {
		const runs = extractRunToolSequences([
			// One run repeating the pair 3 times is NOT recurrence across runs.
			episode("run-1", [
				"a_tool",
				"b_tool",
				"a_tool",
				"b_tool",
				"a_tool",
				"b_tool",
			]),
			episode("run-2", ["a_tool", "b_tool"]),
		]);
		expect(mineToolSequencePatterns(runs)).toEqual([]);
	});

	it("drops sequences below minSupport", () => {
		const runs = extractRunToolSequences(
			recurringRuns(2, ["list_skills", "get_skill"]),
		);
		expect(mineToolSequencePatterns(runs)).toEqual([]);
	});

	it("rejects degenerate single-tool repetition (minDistinctTools)", () => {
		const runs = extractRunToolSequences(
			recurringRuns(5, ["code", "code", "code"]),
		);
		expect(mineToolSequencePatterns(runs)).toEqual([]);
	});

	it("keeps only the maximal pattern when a sub-sequence has equal support", () => {
		const runs = extractRunToolSequences(
			recurringRuns(3, ["list_skills", "get_skill", "improve_skill"]),
		);
		const patterns = mineToolSequencePatterns(runs);
		// "list_skills > get_skill" (support 3) is subsumed by the length-3 routine.
		expect(patterns.map((p) => p.key)).toEqual([
			"list_skills > get_skill > improve_skill",
		]);
	});

	it("keeps a shorter pattern with STRICTLY higher support alongside the longer one", () => {
		const runs = extractRunToolSequences([
			...recurringRuns(
				3,
				["list_skills", "get_skill", "improve_skill"],
				"full",
			),
			...recurringRuns(2, ["list_skills", "get_skill"], "partial"),
		]);
		const patterns = mineToolSequencePatterns(runs);
		expect(patterns.map((p) => [p.key, p.support])).toEqual([
			["list_skills > get_skill", 5],
			["list_skills > get_skill > improve_skill", 3],
		]);
	});

	it("is deterministic: support desc, then length desc, then key asc", () => {
		const runs = extractRunToolSequences([
			...recurringRuns(4, ["z_tool", "y_tool"], "zy"),
			...recurringRuns(4, ["a_tool", "b_tool"], "ab"),
		]);
		const patterns = mineToolSequencePatterns(runs);
		expect(patterns.map((p) => p.key)).toEqual([
			"a_tool > b_tool",
			"z_tool > y_tool",
		]);
	});
});

// ============================================================================
// filterNovelPatterns (dedupe)
// ============================================================================

describe("filterNovelPatterns", () => {
	const pattern = mineToolSequencePatterns(
		extractRunToolSequences(recurringRuns(3, ["list_skills", "get_skill"])),
	)[0]!;
	const patternTag = `${TRAJECTORY_PATTERN_TAG_PREFIX}${toolSequenceHash(pattern.tools)}`;

	it("skips a pattern whose trajectory tag already exists — even archived (rejected stays rejected)", () => {
		const { novel, skipped } = filterNovelPatterns(
			[pattern],
			[
				{
					id: "skill-1",
					title: "old proposal",
					toolIds: null,
					tags: [TRAJECTORY_MINED_TAG, patternTag],
					lifecycleState: "archived",
				},
			],
		);
		expect(novel).toEqual([]);
		expect(skipped).toEqual([
			{
				key: pattern.key,
				reason: "existing_trajectory_proposal",
				skillId: "skill-1",
			},
		]);
	});

	it("skips a pattern matching an existing non-archived skill's toolIds sequence", () => {
		const { novel, skipped } = filterNovelPatterns(
			[pattern],
			[
				{
					id: "skill-2",
					title: "hand-authored",
					toolIds: ["list_skills", "get_skill"],
					tags: null,
					lifecycleState: "active",
				},
			],
		);
		expect(novel).toEqual([]);
		expect(skipped[0]?.reason).toBe("existing_skill_tool_sequence");
	});

	it("matches against RESOLVED app_tool UUID sequences too", () => {
		const toolIdByName = new Map([
			["list_skills", "uuid-list"],
			["get_skill", "uuid-get"],
		]);
		const { novel, skipped } = filterNovelPatterns(
			[pattern],
			[
				{
					id: "skill-3",
					title: "uuid-bound skill",
					toolIds: ["uuid-list", "uuid-get"],
					tags: null,
					lifecycleState: "proven",
				},
			],
			toolIdByName,
		);
		expect(novel).toEqual([]);
		expect(skipped[0]?.skillId).toBe("skill-3");
	});

	it("passes novel patterns through (archived toolIds matches do not block)", () => {
		const { novel, skipped } = filterNovelPatterns(
			[pattern],
			[
				{
					id: "skill-4",
					title: "archived unrelated",
					toolIds: ["list_skills", "get_skill"],
					tags: null,
					lifecycleState: "archived",
				},
				{
					id: "skill-5",
					title: "different sequence",
					toolIds: ["get_skill", "list_skills"],
					tags: null,
					lifecycleState: "active",
				},
			],
		);
		expect(skipped).toEqual([]);
		expect(novel).toEqual([pattern]);
	});
});

// ============================================================================
// composeTrajectorySkillProposal
// ============================================================================

describe("composeTrajectorySkillProposal", () => {
	const pattern = mineToolSequencePatterns(
		extractRunToolSequences(
			recurringRuns(4, ["list_skills", "get_skill", "improve_skill"]),
		),
	)[0]!;

	it("emits a valid propose_skill payload with canonical toolIds populated", () => {
		const draft = composeTrajectorySkillProposal(pattern, {
			toolIdByName: new Map([
				["list_skills", "11111111-1111-8111-8111-111111111111"],
				["get_skill", "22222222-2222-8222-8222-222222222222"],
				["improve_skill", "33333333-3333-8333-8333-333333333333"],
			]),
		});
		// The REAL Workshop contract input must accept the payload as-is.
		const parsed = SkillWorkshopProposeInputSchema.parse({
			...draft,
			tediId: "tedi-1",
		});
		expect(parsed.toolIds).toEqual([
			"11111111-1111-8111-8111-111111111111",
			"22222222-2222-8222-8222-222222222222",
			"33333333-3333-8333-8333-333333333333",
		]);
		expect(parsed.title).toBeTruthy();
		expect(parsed.content).toContain("## Routine");
	});

	it("cites every supporting runId as evidence in the content", () => {
		const draft = composeTrajectorySkillProposal(pattern, {
			toolIdByName: new Map(
				pattern.tools.map((tool, index) => [
					tool,
					`${String(index + 1).padStart(8, "0")}-1111-8111-8111-111111111111`,
				]),
			),
		});
		for (const runId of pattern.supportRunIds) {
			expect(draft.content).toContain(runId);
		}
		expect(draft.content).toContain("## Evidence");
		expect(draft.revisionReasoning).toContain("4 successful runs");
	});

	it("tags the proposal with the deterministic pattern hash for dedupe", () => {
		const draft = composeTrajectorySkillProposal(pattern, {
			toolIdByName: new Map(
				pattern.tools.map((tool, index) => [
					tool,
					`${String(index + 1).padStart(8, "0")}-1111-8111-8111-111111111111`,
				]),
			),
		});
		expect(draft.tags).toContain(TRAJECTORY_MINED_TAG);
		expect(draft.tags).toContain(
			`${TRAJECTORY_PATTERN_TAG_PREFIX}${toolSequenceHash(pattern.tools)}`,
		);
	});

	it("derives a slug-safe title within the 64-char slug limit even for long tool names", () => {
		const longPattern = {
			tools: [
				"workers_builds_list_builds_for_worker_extremely",
				"workers_builds_get_build_logs_and_artifacts",
				"workers_builds_retrigger_build_with_options",
				"another_tool",
			],
			key: toolSequenceKey([
				"workers_builds_list_builds_for_worker_extremely",
				"workers_builds_get_build_logs_and_artifacts",
				"workers_builds_retrigger_build_with_options",
				"another_tool",
			]),
			support: 3,
			supportRunIds: ["r1", "r2", "r3"],
		};
		const draft = composeTrajectorySkillProposal(longPattern, {
			toolIdByName: new Map(
				longPattern.tools.map((tool, index) => [
					tool,
					`${String(index + 1).padStart(8, "0")}-1111-8111-8111-111111111111`,
				]),
			),
		});
		const slug = draft.title
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64);
		expect(slug.length).toBeGreaterThan(0);
		expect(slug.length).toBeLessThanOrEqual(64);
		expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)).toBe(true);
	});

	it("refuses proposal composition when any runtime name lacks a canonical id", () => {
		expect(() =>
			composeTrajectorySkillProposal(pattern, {
				toolIdByName: new Map([
					["list_skills", "11111111-1111-8111-8111-111111111111"],
				]),
			}),
		).toThrow(/UNRESOLVED_TRAJECTORY_TOOLS: get_skill, improve_skill/);
	});
});

// ============================================================================
// listLinkedSuccessfulEpisodes — support-set corroboration gate (B5)
// ============================================================================

function corroborationFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_rationale_records (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			outcome_status TEXT NOT NULL DEFAULT 'pending',
			run_id TEXT,
			tool_call_refs TEXT,
			proof_ref TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE skill_runs (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE tedi_runtime_events (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT NOT NULL,
			run_id TEXT
		);
	`);
	const insertEpisode = (input: { id: string; runId: string }) => {
		sqlite
			.prepare(
				`INSERT INTO tedi_rationale_records
					(id, tedi_id, org_id, outcome_status, run_id, tool_call_refs, proof_ref, created_at)
				 VALUES (?, 'tedi-1', 'org-1', 'success', ?, ?, ?, '2026-07-16T00:00:00.000Z')`,
			)
			.run(
				input.id,
				input.runId,
				JSON.stringify([
					`${input.runId}:step:1:0:list_skills`,
					`${input.runId}:step:2:0:get_skill`,
				]),
				JSON.stringify({ kind: "run", ref: input.runId }),
			);
	};
	const insertRuntimeEvent = (input: {
		id: string;
		runId: string;
		tediId?: string;
	}) => {
		sqlite
			.prepare(
				`INSERT INTO tedi_runtime_events (id, organization_id, tedi_id, run_id)
				 VALUES (?, 'org-1', ?, ?)`,
			)
			.run(input.id, input.tediId ?? "tedi-1", input.runId);
	};
	const insertSkillRun = (input: { id: string; status: string }) => {
		sqlite
			.prepare(
				`INSERT INTO skill_runs (id, organization_id, status) VALUES (?, 'org-1', ?)`,
			)
			.run(input.id, input.status);
	};
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insertEpisode,
		insertRuntimeEvent,
		insertSkillRun,
	};
}

describe("listLinkedSuccessfulEpisodes (corroboration gate)", () => {
	const since = "2026-07-01T00:00:00.000Z";

	it("excludes self-attested non-workflow runIds without runtime-ledger corroboration", async () => {
		const { db, insertEpisode, insertRuntimeEvent, insertSkillRun } =
			corroborationFixture();
		// Completed skill workflow run — canonical execution evidence.
		insertSkillRun({ id: "wfrun-1", status: "completed" });
		insertEpisode({ id: "rec-wf", runId: "wfrun-1" });
		// Failed skill workflow run — dispatch-time success stamp is not proof.
		insertSkillRun({ id: "wfrun-2", status: "failed" });
		insertEpisode({ id: "rec-wf-failed", runId: "wfrun-2" });
		// Chat run corroborated by run-scoped runtime-ledger rows.
		insertEpisode({ id: "rec-chat", runId: "tedi-1:chat:42" });
		insertRuntimeEvent({ id: "evt-1", runId: "tedi-1:chat:42" });
		// Fabricated runId: neither a skill run nor in the runtime ledger.
		insertEpisode({ id: "rec-fab", runId: "made-up-run" });
		// Ledger rows exist but under a DIFFERENT tedi — fails closed.
		insertEpisode({ id: "rec-cross", runId: "other-tedi-run" });
		insertRuntimeEvent({
			id: "evt-2",
			runId: "other-tedi-run",
			tediId: "tedi-9",
		});

		const episodes = await listLinkedSuccessfulEpisodes(db, {
			orgId: "org-1",
			since,
		});
		expect(episodes.map((episode) => episode.runId).sort()).toEqual([
			"tedi-1:chat:42",
			"wfrun-1",
		]);
	});

	it("fabricated runIds cannot reach support-3; corroborated chat runs can", async () => {
		const { db, insertEpisode, insertRuntimeEvent } = corroborationFixture();
		// Three fabricated episodes sharing a routine — zero corroboration.
		for (let i = 1; i <= 3; i++) {
			insertEpisode({ id: `rec-fab-${i}`, runId: `fabricated-${i}` });
		}
		const starved = await listLinkedSuccessfulEpisodes(db, {
			orgId: "org-1",
			since,
		});
		expect(mineToolSequencePatterns(extractRunToolSequences(starved))).toEqual(
			[],
		);

		// The same routine across three REAL chat runs with ledger rows mines.
		for (let i = 1; i <= 3; i++) {
			insertEpisode({ id: `rec-real-${i}`, runId: `tedi-1:chat:${i}` });
			insertRuntimeEvent({ id: `evt-real-${i}`, runId: `tedi-1:chat:${i}` });
		}
		const corroborated = await listLinkedSuccessfulEpisodes(db, {
			orgId: "org-1",
			since,
		});
		const patterns = mineToolSequencePatterns(
			extractRunToolSequences(corroborated),
		);
		expect(patterns).toHaveLength(1);
		expect(patterns[0]).toMatchObject({
			tools: ["list_skills", "get_skill"],
			support: 3,
		});
	});
});

describe("filterPatternsWithCanonicalToolIds", () => {
	const patterns = mineToolSequencePatterns(
		extractRunToolSequences(
			recurringRuns(3, ["list_skills", "get_skill", "improve_skill"]),
		),
	);

	it("passes only patterns whose complete sequence resolves uniquely", () => {
		const result = filterPatternsWithCanonicalToolIds(patterns, {
			toolIdByName: new Map([
				["list_skills", "uuid-list"],
				["get_skill", "uuid-get"],
				["improve_skill", "uuid-improve"],
			]),
			unresolved: [],
			ambiguous: [],
		});
		expect(result.resolved).toEqual(patterns);
		expect(result.skipped).toEqual([]);
	});

	it("reports and skips unresolved or ambiguous runtime identities", () => {
		const unresolved = filterPatternsWithCanonicalToolIds(patterns, {
			toolIdByName: new Map([["list_skills", "uuid-list"]]),
			unresolved: ["get_skill", "improve_skill"],
			ambiguous: [],
		});
		expect(unresolved.resolved).toEqual([]);
		expect(unresolved.skipped).toEqual([
			{
				key: patterns[0]!.key,
				reason: "unresolved_tool_identity",
				toolNames: ["get_skill", "improve_skill"],
			},
		]);

		const ambiguous = filterPatternsWithCanonicalToolIds(patterns, {
			toolIdByName: new Map([
				["list_skills", "uuid-list"],
				["improve_skill", "uuid-improve"],
			]),
			unresolved: [],
			ambiguous: ["get_skill"],
		});
		expect(ambiguous.resolved).toEqual([]);
		expect(ambiguous.skipped[0]).toMatchObject({
			reason: "ambiguous_tool_identity",
			toolNames: ["get_skill"],
		});
	});
});

describe("bindNativeTelemetryIdentities", () => {
	it("binds unresolved telemetry names as native:{name} and composes proposals with them", () => {
		const resolution = bindNativeTelemetryIdentities({
			toolIdByName: new Map([["memory_search", "uuid-1"]]),
			unresolved: ["request_workstation", "tedix_mcp_code"],
			ambiguous: [],
		});
		expect(resolution.unresolved).toEqual([]);
		expect(resolution.toolIdByName.get("request_workstation")).toBe(
			"native:request_workstation",
		);
		const pattern = {
			key: "request_workstation>tedix_mcp_code",
			tools: ["request_workstation", "tedix_mcp_code"],
			support: 3,
			supportRunIds: ["r1", "r2", "r3"],
		} as never;
		const { resolved, skipped } = filterPatternsWithCanonicalToolIds(
			[pattern],
			resolution,
		);
		expect(skipped).toEqual([]);
		expect(resolved).toHaveLength(1);
		const draft = composeTrajectorySkillProposal(resolved[0], {
			toolIdByName: resolution.toolIdByName,
		});
		expect(draft.toolIds).toContain("native:request_workstation");
	});

	it("leaves ambiguous names fail-closed", () => {
		const resolution = bindNativeTelemetryIdentities({
			toolIdByName: new Map(),
			unresolved: [],
			ambiguous: ["send"],
		});
		const { resolved, skipped } = filterPatternsWithCanonicalToolIds(
			[
				{
					key: "send",
					tools: ["send"],
					support: 3,
					runIds: ["a", "b", "c"],
				} as never,
			],
			resolution,
		);
		expect(resolved).toEqual([]);
		expect(skipped[0]?.reason).toBe("ambiguous_tool_identity");
	});
});
