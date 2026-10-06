/**
 * Characterization tests for the brain-bridge similarity + hash semantics.
 *
 * Pin the EXACT numeric behavior of the threshold-tuned matching paths and
 * the persisted hash framings BEFORE/AFTER consolidating the duplicated
 * helpers, so the swap cannot shift a decision or break dedup continuity:
 *
 * - rationale-bridge semantic dedup: directional word-overlap ratio
 *   (matches / |tokens(new observation)|, duplicates counted) against
 *   SEMANTIC_DEDUP_THRESHOLD = 0.5, capped per pattern at
 *   SEMANTIC_DUP_MAX_PER_PATTERN.
 * - rationale-bridge completion matching: directional keyword overlap >= 3,
 *   duplicates in the observation counted.
 * - crystallizer skill dedup: same tokenizer, keyword overlap >= 3.
 * - persisted hashes: sha256 hex sliced to 16 chars over each caller's exact
 *   input framing (bridge dedup keys, rationale idempotency keys).
 * - the cross-package promotion invariant.
 */

import {
	NEVER_PROMOTION_THRESHOLD,
	PROMOTION_THRESHOLD,
} from "@tedix/context-core/compiler";
import type { Observation } from "@tedix/context-core/types";
import { describe, expect, it, vi } from "bun:test";
import { entityHash, observationHash } from "./bridge.js";
import { compileDirectives } from "./compiler.js";
import { crystallize } from "./crystallizer.js";
import type { PlatformClient } from "./platform-client.js";
import {
	type RationaleBridgeState,
	SEMANTIC_DUP_MAX_PER_PATTERN,
	runRationaleBridge,
} from "./rationale-bridge.js";

function observation(overrides: Partial<Observation>): Observation {
	return {
		type: "decision",
		priority: "high",
		content: "Prefetch manifest checkpoints nightly",
		details: [],
		date: "2026-08-19",
		time: "10:00:00",
		...overrides,
	} as Observation;
}

function makeStateStore() {
	let state: RationaleBridgeState = { records: [] };
	return {
		load: async () => state,
		save: async (next: RationaleBridgeState) => {
			state = next;
		},
	};
}

function makePlatform() {
	let nextId = 0;
	return {
		memorySearch: vi.fn(async () => ({ results: [] })),
		createRationaleRecord: vi.fn(async () => ({ id: `r-${nextId++}` })),
		completeRationaleRecord: vi.fn(async () => ({})),
	} as unknown as PlatformClient;
}

describe("rationale-bridge semantic dedup ratio (characterization)", () => {
	// Base content tokens (len > 3, small stop-word set):
	// {prefetch, manifest, checkpoints, nightly}
	const base = "Prefetch manifest checkpoints nightly";

	it("caps a pattern at SEMANTIC_DUP_MAX_PER_PATTERN and dedups at ratio >= 0.5 of the NEW observation's tokens", async () => {
		const platform = makePlatform();
		const stateStore = makeStateStore();

		const result = await runRationaleBridge({
			newObservations: [
				// 6 identical: exact-hash matches count against the per-pattern
				// cap, so exactly 5 create and the 6th is suppressed.
				...Array.from({ length: 6 }, () => observation({ content: base })),
				// {prefetch, manifest, hourly}: 2/3 ≈ 0.67 >= 0.5 → suppressed.
				observation({ content: "Prefetch manifest hourly" }),
				// {prefetch, manifest, hourly, rotation}: 2/4 = 0.5 (boundary,
				// inclusive) → suppressed. Denominator is the NEW observation's
				// token count — the ratio is directional.
				observation({ content: "Prefetch manifest hourly rotation" }),
				// {prefetch, gateway, credentials}: 1/3 < 0.5 → created.
				observation({ content: "Prefetch gateway credentials" }),
			],
			platform,
			stateStore,
		});

		const created = (
			platform.createRationaleRecord as ReturnType<typeof vi.fn>
		).mock.calls.map((call) => (call[0] as { action: string }).action);
		expect(created).toEqual([
			...Array.from({ length: 5 }, () => base),
			"Prefetch gateway credentials",
		]);
		expect(result.created).toHaveLength(6);
	});
});

describe("rationale-bridge completion overlap (characterization)", () => {
	const base = "Prefetch manifest checkpoints nightly";

	async function runFailureCase(errorContent: string): Promise<number> {
		const platform = makePlatform();
		const stateStore = makeStateStore();
		await runRationaleBridge({
			newObservations: [
				observation({ content: base }),
				observation({ type: "error", content: errorContent }),
			],
			platform,
			stateStore,
		});
		return (platform.completeRationaleRecord as ReturnType<typeof vi.fn>).mock
			.calls.length;
	}

	it("completes as failure at keyword overlap >= 3", async () => {
		// {prefetch, manifest, checkpoints, failed} → 3 shared tokens.
		expect(await runFailureCase("Prefetch manifest checkpoints failed")).toBe(
			1,
		);
	});

	it("does not complete at overlap 2", async () => {
		expect(await runFailureCase("Prefetch manifest failed")).toBe(0);
	});

	it("counts duplicate tokens in the observation toward the overlap", async () => {
		// {manifest, manifest, manifest, failed} → overlap 3 from ONE distinct
		// shared word. Directional with multiplicity — pinned deliberately.
		expect(await runFailureCase("Manifest manifest manifest failed")).toBe(1);
	});
});

describe("crystallizer skill dedup overlap (characterization)", () => {
	const pattern = {
		key: "validate|manifest|checkpoints",
		representative: "Validate manifest checkpoints before deploy",
		observations: [
			observation({
				type: "procedural",
				content: "Validate manifest checkpoints before deploy of the bundle",
			}),
			observation({
				type: "procedural",
				content: "Audit manifest checksums after staging the widget bundle",
			}),
		],
		crystallized: false,
	};

	function crystallizerPlatform(existingTitle: string) {
		return {
			findSkills: vi.fn(async () => ({
				entries: [{ id: "skill-1", title: existingTitle, summary: "" }],
			})),
			improveSkill: vi.fn(async () => ({})),
			recordSkill: vi.fn(async () => ({ entry: { id: "skill-new" } })),
		} as unknown as PlatformClient;
	}

	it("refines an existing skill at keyword overlap >= 3", async () => {
		// Skill text {validate, manifest, deploy} vs representative set
		// {validate, manifest, checkpoints, before, deploy} → 3.
		const platform = crystallizerPlatform("Validate manifest deploy");
		await crystallize(pattern, { patterns: {} }, platform);
		expect(platform.improveSkill).toHaveBeenCalledTimes(1);
		expect(platform.recordSkill).not.toHaveBeenCalled();
	});

	it("records a draft skill below overlap 3", async () => {
		// {validate, gateway, rotation} → overlap 1.
		const platform = crystallizerPlatform("Validate gateway rotation");
		await crystallize(pattern, { patterns: {} }, platform);
		expect(platform.improveSkill).not.toHaveBeenCalled();
		expect(platform.recordSkill).toHaveBeenCalledTimes(1);
	});
});

describe("persisted hash framings (characterization)", () => {
	it("observationHash: sha256('type:lowercased trimmed content') sliced to 16", () => {
		expect(observationHash(observation({ content: "Pinned Content " }))).toBe(
			"c3db35983f4fe16e",
		);
	});

	it("entityHash: sha256('entity:type:lowercased trimmed name') sliced to 16", () => {
		expect(entityHash("tool", "Wrangler ")).toBe("ade3a1226575456e");
	});

	it("rationale episode idempotency key: turn-episode:sha256(runId) sliced to 16", async () => {
		const platform = makePlatform();
		const stateStore = makeStateStore();
		await runRationaleBridge({
			newObservations: [
				observation({
					type: "episode",
					content: "Deploy of the manifest bundle succeeded end to end",
					outcomeStatus: "success",
				} as Partial<Observation>),
			],
			platform,
			stateStore,
			correlation: { runId: "run-hash-pin" },
		});
		const call = (platform.createRationaleRecord as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as { idempotencyKey?: string };
		expect(call?.idempotencyKey).toBe("turn-episode:3dfc40e77c8fb2c2");
	});
});

describe("cross-package promotion coupling", () => {
	it("SEMANTIC_DUP_MAX_PER_PATTERN >= NEVER_PROMOTION_THRESHOLD (or 'never' compilation is unreachable)", () => {
		expect(SEMANTIC_DUP_MAX_PER_PATTERN).toBeGreaterThanOrEqual(
			NEVER_PROMOTION_THRESHOLD,
		);
	});

	it("compileDirectives pre-gate stays at PROMOTION_THRESHOLD: 3 completed all-success records DO compile", async () => {
		// The pre-gate at PROMOTION_THRESHOLD is a necessary-condition early
		// exit (< 3 completed records cannot form ANY promotable cluster), NOT
		// the promotion decision. Raising it to NEVER_PROMOTION_THRESHOLD
		// would wrongly skip legitimate 3-record "always" clusters.
		const records = Array.from({ length: 3 }, (_, i) => ({
			id: `rec-${i}`,
			action: "Deploy the widget bundle to staging",
			category: "deployment",
			outcomeStatus: "success",
		}));
		const platform = {
			getRationaleChain: vi.fn(async () => ({ data: records })),
			getContrastiveDecisions: vi.fn(async () => ({
				successes: [],
				failures: [],
			})),
		} as unknown as PlatformClient;
		const directives = await compileDirectives({
			platform,
			logger: { log: () => {} },
		});
		expect(directives).toHaveLength(1);
		expect(directives[0]!.strength).toBe("always");
	});

	it("the real 'never' gate still applies after the pre-gate: 4 all-failure records do NOT compile", async () => {
		const records = Array.from({ length: 4 }, (_, i) => ({
			id: `rec-${i}`,
			action: "Deploy the widget bundle to staging",
			category: "deployment",
			outcomeStatus: "failure",
		}));
		const platform = {
			getRationaleChain: vi.fn(async () => ({ data: records })),
			getContrastiveDecisions: vi.fn(async () => ({
				successes: [],
				failures: [],
			})),
		} as unknown as PlatformClient;
		const directives = await compileDirectives({
			platform,
			logger: { log: () => {} },
		});
		expect(directives).toHaveLength(0);
		expect(NEVER_PROMOTION_THRESHOLD).toBeGreaterThan(PROMOTION_THRESHOLD);
	});
});
