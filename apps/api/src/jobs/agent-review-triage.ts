import { createDbClient } from "@tedix/db/client";
import { getProjectById } from "@tedix/db/queries/projects";
import {
	claimAgentReviewRetry,
	listAgentReviewsForTriage,
	recordAgentReviewTriageNotice,
} from "@tedix/db/queries/work-items/agent-review-triage";
import { purgeExpiredAgentReviews } from "@tedix/db/queries/work-items/agent-review-intake";
import { agentReviewProjectId } from "../services/agent-review-config";
import { wakeAgentReview } from "../services/agent-review";

/** The existing installation tick supplies cadence; project metadata owns recovery policy. */
export async function sweepAgentReviewTriage(
	env: CloudflareEnv,
	now = Date.now(),
): Promise<Record<string, number>> {
	const counts = { retried: 0, purged: 0 };
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
	const intake = project.metadata.agentReviewIntake;
	const retentionDays =
		intake &&
		typeof intake === "object" &&
		!Array.isArray(intake) &&
		typeof intake.retentionDays === "number" &&
		Number.isInteger(intake.retentionDays)
			? Math.min(90, Math.max(1, intake.retentionDays))
			: 90;
	counts.purged = await purgeExpiredAgentReviews(db, {
		orgId: project.orgId,
		projectId,
		before: new Date(now - retentionDays * 86_400_000).toISOString(),
	});
	if (config.enabled !== true || config.tediId !== project.leadTediId)
		return counts;
	const limit =
		typeof config.maxPerTick === "number" && Number.isInteger(config.maxPerTick)
			? Math.min(2, Math.max(1, config.maxPerTick))
			: 2;
	const retryMinutes =
		typeof config.retryMinutes === "number" &&
		Number.isInteger(config.retryMinutes)
			? Math.min(120, Math.max(5, config.retryMinutes))
			: 30;
	const maxRetries =
		typeof config.maxRetries === "number" && Number.isInteger(config.maxRetries)
			? Math.min(1, Math.max(0, config.maxRetries))
			: 1;
	const at = new Date(now).toISOString();
	const reviews = await listAgentReviewsForTriage(db, {
		orgId: project.orgId,
		projectId,
		leadTediId: project.leadTediId,
		maxRetries,
		retryBefore: new Date(now - retryMinutes * 60_000).toISOString(),
		recentAfter: new Date(now - 7 * 86_400_000).toISOString(),
		limit,
	});
	if (reviews.length)
		await recordAgentReviewTriageNotice(db, {
			orgId: project.orgId,
			projectId,
			workItemId: reviews[0]!.id,
			state: "digest",
			at,
		});
	for (const [slot, review] of reviews.slice(0, limit).entries()) {
		if (review.retries > maxRetries) continue;
		const retry = review.retries;
		if (
			await claimAgentReviewRetry(db, {
				orgId: project.orgId,
				workItemId: review.id,
				retry,
				tickSlotId: `${projectId}:triage-tick:${Math.floor(now / 900_000)}:${slot}`,
				at,
			})
		) {
			await wakeAgentReview(db, env, project, review, retry);
			counts.retried++;
		}
	}
	return counts;
}
