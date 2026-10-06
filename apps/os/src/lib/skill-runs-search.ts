import type { SkillRunStatus } from "@tedix/api-contract/contracts/cognitive";
import * as z from "zod";

export const skillRunsSearchSchema = z.object({
	status: z
		.enum(["queued", "running", "paused", "completed", "failed", "canceled"])
		.optional()
		.catch(undefined),
});

export type SkillRunsSearch = z.infer<typeof skillRunsSearchSchema>;

export function hasActiveSkillRun(
	runs: readonly { status: SkillRunStatus }[],
): boolean {
	return runs.some((run) =>
		["queued", "running", "paused"].includes(run.status),
	);
}
