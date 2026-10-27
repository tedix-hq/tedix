import type { DbClient } from "@tedix/db/client";
import { REQUEST_FILING_POLICY } from "@tedix/api-contract/schemas/request-filing-policy";
import type { LedgerModel } from "./agent-session-request-ledger";
import { executeJevJudgment } from "./jev-judgment";

export function requestFilingFitModel(
	db: DbClient,
	env: CloudflareEnv,
	organizationId: string,
): NonNullable<LedgerModel["chooseProject"]> {
	return async ({ context, projectIds, workItemIds }) => {
		const policy = REQUEST_FILING_POLICY.choice;
		const projectOptions = [...projectIds, "NONE", "UNCLEAR"];
		const workOptions = [...workItemIds, "NONE", "UNCLEAR"];
		if (projectOptions.length > 255)
			throw new Error("Request filing portfolio exceeds choice options");
		const result = await executeJevJudgment({
			db,
			env,
			context: { organizationId },
			state: { input: context },
			questions: {
				project: {
					type: "choice",
					instructions: policy.instructions,
					criteria: Object.fromEntries(projectOptions.map((id) => [id, id])),
				},
				work: {
					type: "choice",
					instructions: policy.workInstructions,
					criteria: Object.fromEntries(workOptions.map((id) => [id, id])),
				},
				actionable: { type: "noul", instructions: policy.actionInstructions },
			},
			model: policy.model,
			transport: "cloudflare",
			timeoutMs: policy.timeoutMs,
			source: "system:request-filing-fit",
			billingSource: "system",
			sessionType: "kernel",
		});
		const project = result?.answers.project;
		const work = result?.answers.work;
		const actionable = result?.answers.actionable;
		const validChoice = (
			answer: typeof project | undefined,
			options: string[],
		): answer is NonNullable<typeof project> =>
			answer?.type === "choice" &&
			options.includes(answer.choice) &&
			options.every(
				(id) =>
					Number.isFinite(answer.probabilities[id]) &&
					answer.probabilities[id]! >= 0 &&
					answer.probabilities[id]! <= 1,
			) &&
			Number.isFinite(answer.confidence) &&
			answer.confidence >= 0 &&
			answer.confidence <= 1;
		if (
			!validChoice(project, projectOptions) ||
			!validChoice(work, workOptions) ||
			actionable?.type !== "noul" ||
			!Number.isFinite(actionable.noul) ||
			actionable.noul < 0 ||
			actionable.noul > 1
		)
			throw new Error("Request filing choice unavailable");
		const tied = projectOptions.some(
			(id) =>
				id !== project.choice &&
				project.probabilities[id]! >= project.probabilities[project.choice]!,
		);
		return {
			projectId: tied ? "UNCLEAR" : project.choice,
			confidence: project.probabilities[project.choice]!,
			workItemId:
				workItemIds.includes(work.choice) &&
				work.probabilities[work.choice]! >=
					REQUEST_FILING_POLICY.autoApplyConfidence
					? work.choice
					: null,
			actionable: actionable.noul >= 0.5,
		};
	};
}
