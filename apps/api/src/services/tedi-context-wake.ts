import type { DbClient } from "@tedix/db/client";
import {
	getCommitmentFollowupTarget,
	recordCommitmentFollowupAttention,
	type CommitmentChange,
} from "@tedix/db/queries/work-items/commitment-changes";
import { createWorkInteraction } from "@tedix/db/queries/work-items/interactions";

export async function ensureCommitmentFollowup(
	db: DbClient,
	change: CommitmentChange,
	now: string,
): Promise<string | null> {
	const work = await getCommitmentFollowupTarget(db, change, now);
	if (!work) return null;
	const commitmentKey =
		change.kind === "interaction"
			? `interaction:${change.objectId}`
			: `work:${work.id}`;
	const dedupeKey = `${commitmentKey}:${now.slice(0, 10)}`;
	const decisionClass =
		change.state === "overdue"
			? "deadline.owner.commitment"
			: "personal.proposal.commitment";
	if (work.openInteractionId) {
		await recordCommitmentFollowupAttention(db, {
			orgId: change.orgId,
			interactionId: work.openInteractionId,
			commitmentKey,
			dedupeKey,
			decisionClass,
		});
		return work.openInteractionId;
	}
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${change.orgId}:${dedupeKey}`),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	const interaction = await createWorkInteraction(db, {
		id,
		orgId: change.orgId,
		workItemId: work.id,
		kind: "question",
		subject: `Follow up: ${work.title}`,
		prompt: `This commitment is ${change.state === "overdue" ? "past its due date" : "idle for more than 48 hours with no active Attempt"}. What is the current status or next step?`,
		creator: { type: "tedi", id: change.tediId },
		targetType: "user",
		targetId: work.personId,
		metadata: {
			source: "commitment_followup",
			commitmentKey,
			dedupeKey,
			decisionClass,
			reason:
				"Your accepted commitment needs a current status or a revised next step.",
		},
		now,
	});
	return interaction.id;
}
