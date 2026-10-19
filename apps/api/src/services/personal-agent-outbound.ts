import {
	PersonalAgentContributionSchema,
	PersonalAgentEnrollmentSchema,
	PersonalAgentOutcomeSchema,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	listPersonalAgentOutcomeSources,
	listPersonalAgentOutcomes,
	recordPersonalAgentOutcome,
	listPendingPersonalAgentEmails,
	getPersonalAgentEmailDestination,
	claimPersonalAgentEmail,
	finishPersonalAgentEmail,
} from "@tedix/db/queries/personal-agent-outbound";
import { sendTransactionalEmail } from "../lib/email";

/** Bounded reconciliation rides the existing outcome-maintenance tick. */
export async function reconcilePersonalAgentOutcomes(
	db: DbQueryClient,
	env: { EMAIL?: SendEmail },
	now = new Date(),
) {
	let recorded = 0;
	for (const row of await listPersonalAgentOutcomeSources(db)) {
		const enrollment = PersonalAgentEnrollmentSchema.parse(
			JSON.parse(row.enrollment),
		);
		const contribution = PersonalAgentContributionSchema.parse(
			JSON.parse(row.contribution),
		);
		const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
		const [previous] = await listPersonalAgentOutcomes(db, {
			orgId: row.orgId,
			userId: row.userId,
			enrollmentId: enrollment.id,
			workItemId: row.workItemId,
			newestFirst: true,
			limit: 1,
		});
		const outcome = PersonalAgentOutcomeSchema.parse({
			id: `pa-outcome:${row.sourceKey}`,
			sourceAgentId: enrollment.id,
			externalFindingId: contribution.externalFindingId,
			workItemId: row.workItemId,
			interactionId: row.interactionId,
			responseId: row.responseId,
			decision:
				typeof metadata.decisionChoice === "string"
					? metadata.decisionChoice
					: row.body,
			option:
				typeof metadata.cardAction === "string" ? metadata.cardAction : null,
			decidedBy: row.userId,
			decidedAt: row.decidedAt,
			sourceVersion: row.sourceVersion,
			correctsResponseId:
				typeof metadata.corrects === "string" ? metadata.corrects : null,
			supersedes: previous?.id ?? null,
			execution: {
				state: row.observationState ?? "unverified",
				evidenceId: row.evidenceId,
				evidenceUri: row.evidenceUri,
				evidenceVersion: row.evidenceVersion,
				observationSource: row.observationSource,
				observerType: row.observerType,
				observerId: row.observerId,
				verificationId: row.verificationId,
				observedAt: row.observedAt,
			},
			recordedAt: now.toISOString(),
		});
		await recordPersonalAgentOutcome(db, row.orgId, outcome);
		recorded++;
	}
	for (const row of await listPendingPersonalAgentEmails(db)) {
		const e = PersonalAgentEnrollmentSchema.parse(JSON.parse(row.enrollment));
		const outcome = PersonalAgentOutcomeSchema.parse(JSON.parse(row.payload));
		const destination = await getPersonalAgentEmailDestination(db, e);
		if (!destination || !env.EMAIL) continue;
		if (!(await claimPersonalAgentEmail(db, e, outcome))) continue;
		// Claim before I/O. A crash or ambiguous provider failure stays unknown;
		// automatic retries must not produce duplicate mail after an uncertain send.
		const result = await sendTransactionalEmail(env, {
			from: { email: destination.from },
			to: [{ email: destination.to }],
			subject: `Finding outcome: ${outcome.externalFindingId}`,
			text: JSON.stringify(outcome, null, 2),
			headers: {
				"Auto-Submitted": "auto-generated",
				"X-Tedix-Outcome-Id": outcome.id,
			},
		});
		await finishPersonalAgentEmail(
			db,
			row.orgId,
			outcome.id,
			result.ok
				? { status: "sent", messageId: result.messageId }
				: { status: "sending_or_unknown" },
		);
	}
	return { recorded };
}
