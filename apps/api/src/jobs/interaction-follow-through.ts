import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import { createDbClient } from "@tedix/db/client";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	latestCardChangeRequest,
	listCardRevisions,
} from "@tedix/db/queries/work-items/card-revisions";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import {
	listDueWorkInteractionReviews,
	recordWorkInteractionReviewWake,
} from "@tedix/db/queries/work-items/interaction-reviews";
import { assertWorkApprovalWakeAccepted } from "./work-approval-redrive";
import { cardOwningTedi } from "../services/card-revisions";
import { recheckDecisionAction } from "../services/decision-action-recheck";

function interactionReviewPrompt(requestId: string, version: number): string {
	return `You own an unanswered Needs-you ask. Read Interaction ${requestId} (observed version ${version}) and its current Work/source now. If already answered, act on the exact answer within existing authority and post a review_work_interaction continued receipt naming its responseId and an owner tool.completed event evidenceId. Otherwise re-check whether the ask is still needed: use review_work_interaction to close it with a note or reask once with a note. A second unanswered review may close, never nudge again. Do not create another ask or send a separate channel nudge. No new authority is granted.`;
}

/** Runs on the existing two-minute Interaction maintenance tick. */
export async function dispatchInteractionReviews(
	env: CloudflareEnv,
	scheduledTime: number,
) {
	const db = createDbClient(env.DB);
	let reviews = 0;
	for (const row of await listDueWorkInteractionReviews(
		db,
		new Date(scheduledTime).toISOString(),
	)) {
		if (
			row.status === "resolved" &&
			(await recheckDecisionAction(
				db,
				row,
				new Date(scheduledTime).toISOString(),
			))
		) {
			await recordWorkInteractionReviewWake(
				db,
				row,
				new Date(scheduledTime).toISOString(),
				null,
			);
			continue;
		}
		const rawFollow = row.metadata.followThrough;
		const follow =
			rawFollow && typeof rawFollow === "object" && !Array.isArray(rawFollow)
				? rawFollow
				: {};
		const key =
			row.status === "resolved"
				? `interaction-continuation:${row.id}:${row.version}:${follow.continuationWakeAt ?? "first"}`
				: `interaction-review:${row.id}:${row.version}`;
		const change =
			row.status === "open"
				? await latestCardChangeRequest(db, row.orgId, row.id)
				: null;
		const revisions = change
			? await listCardRevisions(db, row.orgId, row.id)
			: [];
		const pendingChange =
			change &&
			!revisions.some((revision) => revision.responseId === change.id);
		const prompt = pendingChange
			? `${change.body}\nChange request responseId=${change.id}. Read cardHistory and the current request version before calling workInteractions.reviseCard. Keep the same card; never approve or execute it.`
			: row.status === "resolved"
				? `Your Needs-you ask ${row.id} was answered, but has no verified continuation receipt. Read its exact latest answer and current Work/source; act within existing authority, then post review_work_interaction(action: continued, responseId, evidenceId, note). Use an owner tool.completed event or your exact-session succeeded Work Attempt after the answer as evidence. Do not re-ask the human or send another status message. This wake grants no new authority.`
				: interactionReviewPrompt(row.id, row.version);
		let runId: string | null = null;
		const ownerTediId = await cardOwningTedi({ db }, row);
		if (ownerTediId) {
			const tedi = await getTediByIdForOrganization(db, ownerTediId, row.orgId);
			if (!tedi || tedi.status !== "active" || !env.TEDI_SERVICE) continue;
			const accepted = await assertWorkApprovalWakeAccepted(
				await env.TEDI_SERVICE.fetch(
					new Request("https://tedi/hooks/inject", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Service-Binding": "true",
							[CALLER_TRUST_HEADER]: "member",
							"X-Tedix-Host": `${tedi.slug}.tedi.${env.ENVIRONMENT === "production" ? "tedix.dev" : "tedix.tech"}`,
						},
						body: JSON.stringify({
							session_key:
								typeof row.metadata.sessionId === "string"
									? row.metadata.sessionId
									: `interaction-review:${row.id}`,
							client_request_id: key,
							async: true,
							text: prompt,
							metadata: { source: "interaction_review", requestId: row.id },
						}),
					}),
				),
			);
			runId = accepted.runId;
		} else if (row.creatorType === "external_agent") {
			// Existing directed inbox + host hooks retain the exact owner session.
			// A read-only hook is not an idle-host wake or an executed continuation.
			const id = await reviewInboxId(key);
			if (
				!(await getWorkInteraction(db, { orgId: row.orgId, interactionId: id }))
			)
				await createWorkInteraction(db, {
					id,
					orgId: row.orgId,
					workItemId: row.workItemId,
					caseId: row.caseId,
					projectId: row.projectId,
					kind: "question",
					subject: "Review your unanswered ask",
					prompt,
					creator: { type: "system", id: "tedix" },
					targetType: "external_agent",
					targetId: row.creatorId,
					metadata: {
						sessionId: row.creatorExternalSessionKey,
						reviewRequestId: row.id,
					},
					expiresAt: new Date(scheduledTime + 3 * 86_400_000).toISOString(),
					now: new Date(scheduledTime).toISOString(),
				});
		}
		await recordWorkInteractionReviewWake(
			db,
			row,
			new Date(scheduledTime).toISOString(),
			runId,
		);
		reviews++;
	}
	return { interactionReviews: reviews };
}

async function reviewInboxId(key: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`owner-inbox:${key}`),
		),
	);
	const hex = [...bytes.slice(0, 16)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
