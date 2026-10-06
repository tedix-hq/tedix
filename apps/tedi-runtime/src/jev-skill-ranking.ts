import type {
	RankSkillsInput,
	RankSkillsOutput,
} from "@tedix/api-contract/schemas/jev";
import {
	selectRetrievedSkillCandidates,
	selectRetrievedSkills,
	type RetrievableSkill,
	type RetrievedSkillMatch,
	type SelectRetrievedSkillsOptions,
} from "@tedix/context-core/skill-retrieval";
import { exceptionTopology } from "./exception-topology";

/** Optional service seam. Never broadens eligibility or the existing prompt top-K. */
export async function selectSkillsWithJev(input: {
	skills: readonly RetrievableSkill[];
	query: string;
	options?: SelectRetrievedSkillsOptions;
	onExecutionAttempts?: (
		receipt: Pick<RankSkillsOutput, "executionAttempts" | "usagePersistence">,
	) => Promise<void>;
	runId?: string | null;
	rank?: (input: Omit<RankSkillsInput, "tediId">) => Promise<RankSkillsOutput>;
}): Promise<RetrievedSkillMatch[]> {
	const baseline = selectRetrievedSkills(
		input.skills,
		input.query,
		input.options,
	);
	if (!input.rank || !input.runId || baseline.length === 0) return baseline;
	const candidates = selectRetrievedSkillCandidates(input.skills, input.query, {
		...input.options,
		topK: 40,
	});
	if (candidates.length <= baseline.length) return baseline;
	try {
		const response = await input.rank({
			runId: input.runId,
			query: input.query.slice(0, 2000),
			skillIds: candidates.map((match) => match.skill.id),
		});
		await input.onExecutionAttempts?.({
			executionAttempts: response.executionAttempts,
			usagePersistence: response.usagePersistence,
		});
		const ids = response.skillIds;
		const byId = new Map(candidates.map((match) => [match.skill.id, match]));
		if (
			!ids ||
			ids.length !== candidates.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => !byId.has(id))
		)
			return baseline;
		return ids.slice(0, baseline.length).map((id) => byId.get(id)!);
	} catch (error) {
		console.warn({
			event: "jev.skill_ranking_failed",
			exception: exceptionTopology(error),
		});
		return baseline;
	}
}
