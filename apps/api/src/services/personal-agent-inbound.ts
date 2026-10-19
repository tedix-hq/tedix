import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import {
	PersonalAgentContributionSchema,
	PersonalAgentEnrollmentSchema,
	PersonalAgentFindingSchema,
	type PersonalAgentContribution,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import type { DbClient } from "@tedix/db/client";
import {
	capturePersonalAgentFinding,
	PERSONAL_AGENT_NAMESPACE,
	personalAgentConfigKey,
} from "@tedix/db/queries/personal-agent-inbound";
import { getUserConfig } from "@tedix/db/queries/user-configs";
import { getOrgSecret } from "@tedix/db/queries/organization-secrets";
import {
	decryptSecret,
	timingSafeCompare,
} from "@tedix/db/utils/secrets-encryption";
import { HTTPException } from "hono/http-exception";

export async function receivePersonalAgentFinding(
	db: DbClient,
	masterKey: string,
	input: {
		orgId: string;
		userId: string;
		enrollmentId: string;
		token: string;
		finding: unknown;
		channel: PersonalAgentContribution["sourceChannel"];
	},
) {
	const denied = () =>
		new HTTPException(401, { message: "Invalid or revoked enrollment" });
	const row = await getUserConfig(db, {
		userId: input.userId,
		namespace: PERSONAL_AGENT_NAMESPACE,
		key: personalAgentConfigKey(input.orgId, input.enrollmentId),
	});
	const parsed = PersonalAgentEnrollmentSchema.safeParse(row?.value);
	if (!row || !parsed.success || !parsed.data.active) throw denied();
	const e = parsed.data;
	if (
		e.orgId !== input.orgId ||
		e.representedUserId !== input.userId ||
		e.id !== input.enrollmentId
	)
		throw denied();
	const secret = await getOrgSecret(db, e.orgId, e.secretName);
	if (
		!secret ||
		!timingSafeCompare(
			await decryptSecret(masterKey, e.orgId, secret.encryptedValue),
			input.token,
		)
	)
		throw denied();
	const finding = PersonalAgentFindingSchema.safeParse(input.finding);
	if (!finding.success)
		throw new HTTPException(400, { message: "Invalid finding" });
	const capturedAt = new Date().toISOString();
	const contribution: PersonalAgentContribution = {
		sourceAgentId: e.id,
		sourceAgentName: e.sourceAgentName,
		representedUserId: e.representedUserId,
		sourceChannel: input.channel,
		capturedAt,
		evidenceUrl: finding.data.evidenceUrl,
		externalFindingId: finding.data.externalFindingId,
		kind: finding.data.kind,
	};
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([e.id, finding.data.externalFindingId]),
		),
	);
	const sourceIntentId = `personal-agent:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
	const result = await capturePersonalAgentFinding(db, {
		enrollment: e,
		revision: row.revision,
		finding: finding.data,
		contribution,
		sourceIntentId,
	});
	if (!result) throw denied();
	const saved = PersonalAgentContributionSchema.safeParse(
		result.work.provenance?.personalAgentContribution,
	);
	if (
		saved.success &&
		saved.data.kind === "proposal" &&
		!(await getWorkInteraction(db, {
			orgId: e.orgId,
			interactionId: result.work.id,
		}))
	) {
		const source = saved.data;
		const decision = DecisionEnvelopeSchema.parse({
			version: 1,
			kind: "proposal",
			classId: "personal.proposal",
			proposal: `Explore ${result.work.title.slice(0, 66).replace(/[?.]+$/, "")}?`,
			whyNow: `${source.sourceAgentName} submitted this finding for your decision.`,
			preview: {
				body: "Adds this finding to your tasks for follow-up. No outside action is taken.",
			},
			recommendation:
				"Your personal agent marked this as a proposal, rather than an update.",
			reversibility: "two_way",
			protectedEffects: [],
			blastRadius: "Your research tasks",
			confidence: null,
			costOfWaiting: "The opportunity remains unexplored.",
			reasoning: result.work.description ?? result.work.title,
			options: [
				{
					id: "explore",
					label: "Explore",
					intent: "approve",
					consequence:
						"Accepts the research task for your follow-up; sends nothing.",
					cost: "Your review time",
					effect: {
						kind: "accept_work",
						workItemId: result.work.id,
						doneLooksLike:
							"The owner reviews the finding and records the next step.",
					},
				},
				{
					id: "skip",
					label: "Skip",
					intent: "reject",
					consequence: "Closes this decision without acting on the finding.",
					cost: "None",
				},
			],
		});
		try {
			await createWorkInteraction(db, {
				id: result.work.id,
				orgId: e.orgId,
				workItemId: result.work.id,
				kind: "question",
				subject: decision.proposal,
				prompt: `${decision.reasoning}\n\nSource: ${source.evidenceUrl}`,
				creator: { type: "system", id: "tedix" },
				targetType: "user",
				targetId: e.representedUserId,
				metadata: {
					source: "personal-agent-inbound",
					personalAgentContribution: source,
					reason: decision.whyNow,
					decisionDeck: decision,
				},
				now: capturedAt,
			});
		} catch (error) {
			if (
				!(await getWorkInteraction(db, {
					orgId: e.orgId,
					interactionId: result.work.id,
				}))
			)
				throw error;
		}
	}
	return {
		workItemId: result.work.id,
		externalFindingId: finding.data.externalFindingId,
		capturedAt: result.work.createdAt,
		duplicate: result.duplicate,
		disposition: "proposed" as const,
	};
}
