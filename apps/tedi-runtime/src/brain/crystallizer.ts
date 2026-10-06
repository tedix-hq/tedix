/**
 * Crystallizer — HTTP/runtime side.
 *
 * Pattern detection (key, quality gates, threshold) lives in
 * `@tedix/context-core/crystallizer`. This module wires that pure logic to
 * platform writes: `findSkills` (dedup), `improveSkill` (refine), and
 * `recordSkill` (draft creation).
 *
 * State persistence is injected through CrystallizationStateStore. The Agent
 * runtime supplies DoCrystallizationStateStore backed by DO SQLite.
 */

import {
	type CrystallizationState,
	type ProceduralPattern,
	detectCandidates,
	evaluateQuality,
	nextPatternVersion,
} from "@tedix/context-core/crystallizer";
import { matchKeywordOverlap } from "@tedix/context-core/text-utils";
import type { Observation } from "@tedix/context-core/types";
import type { PlatformClient } from "./platform-client.js";

export interface CrystallizationStateStore {
	load(): Promise<CrystallizationState>;
	save(state: CrystallizationState): Promise<void>;
}

interface Logger {
	log(msg: string): void;
}

const defaultLogger: Logger = { log: (msg) => console.log(msg) };

/**
 * Crystallize a single pattern into either an improved skill or a draft skill.
 * Returns `{ muscleId, version }` on success, or `null` when the pattern is
 * rejected by quality gates or a platform call fails.
 */
export async function crystallize(
	pattern: ProceduralPattern,
	state: CrystallizationState,
	platform: PlatformClient,
	logger: Logger = defaultLogger,
): Promise<{ muscleId: string; version: number } | null> {
	const quality = evaluateQuality(pattern);
	if (!quality.ok) {
		logger.log(`[brain-bridge] Crystallizer: skipped (${quality.reason})`);
		return null;
	}

	const { steps, description, name } = quality;
	const version = nextPatternVersion(pattern.key, state);
	const prior = state.patterns[pattern.key];

	const fullDescription = `Auto-suggested from ${pattern.observations.length} procedural observations (v${version}). Review before promotion:\n${description}`;

	// Dedup against existing skills
	let matchedSkill: { id: string; title: string } | null = null;
	try {
		const existing = await platform.findSkills(pattern.representative, 3);
		for (const skill of existing.entries ?? []) {
			const titleText = skill.title || "";
			const summaryText = skill.summary || skill.description || "";
			const combinedText = `${titleText} ${summaryText}`;
			if (matchKeywordOverlap(combinedText, pattern.representative) >= 3) {
				matchedSkill = { id: skill.id, title: titleText };
				break;
			}
		}
	} catch (findErr) {
		logger.log(
			`[brain-bridge] Crystallizer: findSkills failed, falling through to create (${findErr instanceof Error ? findErr.message : String(findErr)})`,
		);
	}

	if (matchedSkill) {
		try {
			await platform.improveSkill({
				id: matchedSkill.id,
				content: fullDescription,
				revisionReasoning: `Auto-refined from ${pattern.observations.length} new procedural observations`,
			});
			logger.log(
				`[brain-bridge] Crystallizer: refined existing skill "${matchedSkill.title}" with ${pattern.observations.length} new observations`,
			);
		} catch (improveErr) {
			logger.log(
				`[brain-bridge] Crystallizer: improveSkill failed (${improveErr instanceof Error ? improveErr.message : String(improveErr)})`,
			);
		}

		state.patterns[pattern.key] = {
			muscleId: prior?.muscleId || "refined",
			version,
			crystallizedAt: new Date().toISOString(),
			observationCount: pattern.observations.length,
		};

		return { muscleId: prior?.muscleId || "refined", version };
	}

	// No match — record a draft skill candidate
	try {
		const recorded = await platform.recordSkill({
			title: name,
			content: fullDescription,
			domain: "crystallized",
			summary: steps[0] ?? pattern.representative,
			tags: ["crystallized", "muscle-memory", "auto-suggested", "draft"],
			lifecycleState: "draft",
			visibility: "private",
		});
		const skillId = recorded?.entry?.id ?? "draft-skill";
		state.patterns[pattern.key] = {
			muscleId: `draft:${skillId}`,
			version,
			crystallizedAt: new Date().toISOString(),
			observationCount: pattern.observations.length,
		};
		logger.log(
			`[brain-bridge] Crystallizer: recorded draft skill "${name}" (pending promotion)`,
		);
		return { muscleId: `draft:${skillId}`, version };
	} catch (err) {
		logger.log(
			`[brain-bridge] Crystallizer: draft skill creation skipped (${err instanceof Error ? err.message : String(err)})`,
		);
		return null;
	}
}

export interface RunCrystallizationOptions {
	observations: Observation[];
	platform: PlatformClient;
	stateStore: CrystallizationStateStore;
	logger?: Logger;
}

/**
 * Full crystallization cycle: detect candidates via context-core, crystallize
 * each, persist state. Returns the number of patterns that produced a write.
 */
export async function runCrystallization(
	options: RunCrystallizationOptions,
): Promise<number> {
	const {
		observations,
		platform,
		stateStore,
		logger = defaultLogger,
	} = options;
	const state = await stateStore.load();
	const candidates = detectCandidates(observations, state);

	if (candidates.length === 0) return 0;

	let crystallized = 0;
	for (const candidate of candidates) {
		const result = await crystallize(candidate, state, platform, logger);
		if (result) crystallized++;
	}

	if (crystallized > 0) {
		await stateStore.save(state);
		logger.log(
			`[brain-bridge] Crystallizer: persisted state (${Object.keys(state.patterns).length} patterns)`,
		);
	}

	return crystallized;
}
