// @ts-nocheck — this source is compiled inside the tenant workflow sandbox.
function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedInteger(value, fallback, min, max) {
	if (value === undefined) return fallback;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	) {
		throw new Error(`Mining parameter must be an integer in ${min}..${max}`);
	}
	return value;
}
function miningResult(value) {
	if (!object(value) || value.ok === false)
		throw new Error("Trajectory mining failed or returned no result");
	if (
		value.completionEvidence !== undefined &&
		(!object(value.completionEvidence) ||
			value.completionEvidence.status !== "succeeded")
	) {
		throw new Error("Trajectory mining did not report successful completion");
	}
	for (const field of ["episodesExamined", "runsExamined"]) {
		if (
			typeof value[field] !== "number" ||
			!Number.isInteger(value[field]) ||
			value[field] < 0
		) {
			throw new Error(`Invalid mining result: ${field}`);
		}
	}
	for (const field of ["patterns", "proposed", "skipped"]) {
		if (!Array.isArray(value[field]))
			throw new Error(`Invalid mining result: ${field}`);
	}
	if (
		!value.proposed.every(
			(row) => object(row) && typeof row.id === "string" && row.id.length > 0,
		)
	) {
		throw new Error("Invalid mining result: proposal identity missing");
	}
	return value;
}
export default {
	async run(event, step, env) {
		const input = event.payload ?? {};
		if (!object(input)) throw new Error("Mining input must be an object");
		const allowed = new Set([
			"dryRun",
			"windowDays",
			"minSupport",
			"maxProposals",
		]);
		if (Object.keys(input).some((key) => !allowed.has(key)))
			throw new Error(
				"Unknown mining input; identity comes from the admitted run",
			);
		if (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
			throw new Error("dryRun must be boolean");
		const tediId = env.__RUN_CONTEXT__?.tediId;
		if (typeof tediId !== "string" || !tediId.trim())
			throw new Error("Admitted tedi identity is required");
		const params = {
			tediId,
			windowDays: boundedInteger(input.windowDays, 14, 1, 90),
			minSupport: boundedInteger(input.minSupport, 3, 3, 50),
			maxProposals: boundedInteger(input.maxProposals, 3, 1, 10),
			dryRun: input.dryRun !== false,
		};
		// Cloudflare treats limit: 1 as one total attempt and rejects limit: 0.
		// This preserves the required step boundary without replaying an
		// outcome-unknown proposal write.
		const result = await step.do(
			"mine-trajectories",
			{ retries: { limit: 1, delay: "1 second" }, timeout: "2 minutes" },
			async () =>
				miningResult(await env.MCP.tedi.mine_skill_candidates(params)),
		);
		if (params.dryRun && result.proposed.length)
			throw new Error("Dry-run unexpectedly created proposals");
		if (result.proposed.length > params.maxProposals)
			throw new Error("Mining exceeded the proposal cap");
		return {
			outcome: result.proposed.length
				? "proposal_created"
				: params.dryRun
					? "observation"
					: "no_change",
			dryRun: params.dryRun,
			episodesExamined: result.episodesExamined,
			runsExamined: result.runsExamined,
			patternsFound: result.patterns.length,
			proposalsCreated: result.proposed.length,
			proposalIds: result.proposed.map((proposal) => proposal.id),
			skippedPatterns: result.skipped.length,
		};
	},
};
