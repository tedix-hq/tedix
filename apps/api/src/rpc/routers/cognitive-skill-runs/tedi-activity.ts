import { getRunArtifact } from "@tedix/db/queries/skill-run-artifacts";
import { resolveSkillRunArtifactContents } from "../../../services/skill-workflow-inspection";
import {
	readWorkflowStepTediActivity,
	unavailableTediActivity,
} from "../../../services/workflow-step-tedi-activity";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import { getSkillRunForEnvironment, requireWorkflowRunTedi } from "./shared";

export const skillsGetWorkflowStepTediActivity =
	authedSkills.getWorkflowStepTediActivity
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			const run = await getSkillRunForEnvironment(context, input.runId, orgId);
			if (
				!run ||
				run.workflowRetiredAt ||
				run.error === "REVOKED" ||
				run.error?.startsWith("REVOKED:")
			)
				throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
			requireWorkflowRunTedi(run, input.tediId);
			if ((run.executionEpoch ?? 0) !== input.executionEpoch)
				throw createError(
					ErrorCodes.CONFLICT,
					"Workflow execution epoch changed; reload the selected step.",
				);
			if (run.sensitiveDataLatch)
				return unavailableTediActivity(
					"This run's sensitive activity is withheld.",
					true,
				);
			if (!input.path.startsWith(`epochs/${input.executionEpoch}/steps/`))
				return unavailableTediActivity(
					"This historical step has no verified epoch-bound tedi task link.",
				);
			const parentPath = input.path.split("/calls/")[0] + ".json";
			const [artifact, parent] = await Promise.all([
				getRunArtifact(context.db, run.id, input.path),
				getRunArtifact(context.db, run.id, parentPath),
			]);
			if (!artifact)
				return unavailableTediActivity(
					"The recorded call receipt is unavailable.",
				);
			const { resolved } = await resolveSkillRunArtifactContents({
				artifacts: [artifact, ...(parent ? [parent] : [])],
				includeArbitraryContent: false,
				loadR2: context.env.SKILL_ARTIFACTS
					? (key) => context.env.SKILL_ARTIFACTS.get(key)
					: undefined,
			});
			const parse = (content: string | null) => {
				try {
					return content ? JSON.parse(content) : null;
				} catch {
					return null;
				}
			};
			const result = await readWorkflowStepTediActivity(
				context,
				{
					organizationId: orgId,
					runId: run.id,
					tediId: run.tediId,
					executionEpoch: input.executionEpoch,
					path: input.path,
					attempt: input.attempt,
				},
				parse(resolved[0]?.content ?? null),
				parse(resolved[1]?.content ?? null),
			);
			const current = await getSkillRunForEnvironment(
				context,
				input.runId,
				orgId,
			);
			if (
				!current ||
				current.workflowRetiredAt ||
				current.error === "REVOKED" ||
				current.error?.startsWith("REVOKED:")
			)
				throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
			if ((current.executionEpoch ?? 0) !== input.executionEpoch)
				throw createError(
					ErrorCodes.CONFLICT,
					"Workflow execution epoch changed; reload the selected step.",
				);
			return current.sensitiveDataLatch
				? unavailableTediActivity(
						"This run's sensitive activity is withheld.",
						true,
					)
				: result;
		});
