import { createDbClient } from "@tedix/db/client";
import { getProjectById } from "@tedix/db/queries/projects";
import {
	claimAgentReviewRetry,
	listAgentReviewsForTriage,
	recordAgentReviewTriageNotice,
} from "@tedix/db/queries/work-items/agent-review-triage";
import { agentReviewProjectId } from "../services/agent-review-config";
import { wakeAgentReview } from "../services/agent-review";

/** The existing installation tick supplies cadence; project metadata owns recovery policy. */
export async function sweepAgentReviewTriage(
	env: CloudflareEnv,
	now = Date.now(),
): Promise<Record<string, number>> {
	const counts = { retried: 0, completed: 0, late: 0 };
	const projectId = agentReviewProjectId(env);
	if (!projectId) return counts;
	const db = createDbClient(env.DB);
	const project = await getProjectById(db, projectId);
	if (
		!project ||
		project.status !== "active" ||
		!project.leadTediId ||
		!project.objectiveId ||
		project.metadata?.agentReviewEnabled !== true
	)
		return counts;
	const policy = project.metadata.agentReviewTriage;
	const config =
		policy && typeof policy === "object" && !Array.isArray(policy)
			? policy
			: {};
	if (config.enabled === false) return counts;
	const retryMinutes =
		typeof config.retryMinutes === "number" &&
		Number.isInteger(config.retryMinutes)
			? Math.min(120, Math.max(5, config.retryMinutes))
			: 30;
	const maxRetries =
		typeof config.maxRetries === "number" && Number.isInteger(config.maxRetries)
			? Math.min(5, Math.max(0, config.maxRetries))
			: 3;
	const at = new Date(now).toISOString();
	const reviews = await listAgentReviewsForTriage(db, {
		orgId: project.orgId,
		projectId,
		leadTediId: project.leadTediId,
		maxRetries,
		retryBefore: new Date(now - retryMinutes * 60_000).toISOString(),
		lateBefore: new Date(now - 2 * 60 * 60_000).toISOString(),
	});
	for (const review of reviews) {
		if (review.complete) {
			await recordAgentReviewTriageNotice(db, {
				orgId: project.orgId,
				workItemId: review.id,
				state: "completed",
				at,
			});
			counts.completed++;
			continue;
		}
		if (now - Date.parse(review.createdAt) > 2 * 60 * 60_000) {
			await recordAgentReviewTriageNotice(db, {
				orgId: project.orgId,
				workItemId: review.id,
				state: "late",
				at,
			});
			counts.late++;
		}
		if (
			review.retries >= maxRetries ||
			now - Date.parse(review.lastRetry ?? review.createdAt) <
				retryMinutes * 60_000
		)
			continue;
		const retry = review.retries + 1;
		if (
			await claimAgentReviewRetry(db, {
				orgId: project.orgId,
				workItemId: review.id,
				retry,
				at,
			})
		) {
			await wakeAgentReview(db, env, project, review, retry);
			counts.retried++;
		}
	}
	return counts;
}
