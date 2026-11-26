import {
	isSameCanonicalParty,
	resolveCanonicalWorkParties,
} from "@tedix/db/queries/external-agent-identity/canonical-party";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import {
	recordWorkConfirmation,
	addWorkItemComment,
} from "@tedix/db/queries/work-items/comments";
import { workObservationPrincipal } from "../work-items-principal";
import { ErrorCodes, createError } from "../../orpc";
import { workExecutorReference } from "@tedix/api-contract/schemas/work-items";
import { updateWorkItemSpecification } from "@tedix/db/queries/work-items/crud";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { mentionedExecutor } from "../../../services/lane-dispatch-plan";
import { toJsonRecord } from "@tedix/db/utils/json";
import { verifiedWorkItemCommentAuthor } from "../work-items-principal";
import {
	assertWorkItemAccess,
	authOs,
	workItemStewardActor,
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkItemWriteError,
	rethrowWorkControlError,
} from "./policy-helpers";

async function recordCommentObservation(
	context: Parameters<typeof workObservationPrincipal>[0],
	workItem: Awaited<ReturnType<typeof assertWorkItemAccess>>,
	input: {
		body: string;
		evidenceRef: string;
		stance: "corroborates" | "contradicts";
	},
) {
	const principal = await workObservationPrincipal(context, workItem.orgId);
	const attempts = await listWorkItemAttempts(context.db, {
		orgId: workItem.orgId,
		workItemId: workItem.id,
	});
	const activeAttempt = attempts.data.find((attempt) =>
		["queued", "running", "waiting", "retrying"].includes(attempt.runtimeState),
	);
	// Owners and their owner-host agents are one party. Agreement adds no
	// independent credit; contradiction remains available to correct a claim.
	const externalExecutors = [
		...new Set(
			attempts.data
				.filter((attempt) => attempt.executorType === "external_agent")
				.map((attempt) => attempt.executorId),
		),
	]
		.slice(0, 49)
		.map((id) => ({ type: "external_agent", id }));
	const parties = await resolveCanonicalWorkParties(context.db, {
		organizationId: workItem.orgId,
		parties: [principal, ...externalExecutors],
	});
	const executorRef = (attempt: (typeof attempts.data)[number]) => ({
		type: attempt.executorType,
		id: attempt.executorId,
	});
	const selfCorroboration =
		(activeAttempt &&
			isSameCanonicalParty(parties, executorRef(activeAttempt), principal)) ||
		attempts.data.some(
			(attempt) =>
				parties.has(`external_agent:${attempt.executorId}`) &&
				attempt.executorType === "external_agent" &&
				isSameCanonicalParty(parties, executorRef(attempt), principal),
		);
	if (input.stance === "corroborates" && selfCorroboration) {
		throw createError(
			ErrorCodes.CONFLICT,
			"The active executor cannot corroborate its own Work Item; it may contradict it",
		);
	}
	try {
		const result = await recordWorkConfirmation(context.db, {
			id: crypto.randomUUID(),
			workItemId: workItem.id,
			orgId: workItem.orgId,
			principalType: principal.type,
			principalId: principal.id,
			sessionId: principal.sessionId,
			evidenceRef: input.evidenceRef,
			stance: input.stance,
			body: input.body,
			occurredAt: new Date().toISOString(),
		});
		return result.confirmation;
	} catch (error) {
		rethrowWorkControlError(error);
	}
}

export const addCommentProcedure = authOs.addComment.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		try {
			const author = await verifiedWorkItemCommentAuthor(
				context,
				workItem.orgId,
				input.metadata,
			);
			if (
				input.requestDelegation === true &&
				!workItem.executorId &&
				/\bdelegat(?:ed|ion)\b/i.test(input.body)
			) {
				const assignment =
					mentionedExecutor(input.body, []) ??
					mentionedExecutor(
						input.body,
						await getTedisByOrganization(context.db, workItem.orgId),
					);
				if (assignment) {
					const actor = await workItemStewardActor(
						context,
						workItem,
						"specification",
					);
					if (
						assignment.tediId &&
						assignment.tediId !== workItem.accountableOwnerId
					)
						await requireOwnerAdminWorkItemAuthor(
							context,
							workItem.orgId,
							"Tedi accountability assignment",
						);
					await updateWorkItemSpecification(context.db, {
						orgId: workItem.orgId,
						workItemId: workItem.id,
						actor,
						expectedWorkItemVersion: workItem.version,
						...(assignment.tediId
							? {
									executorReference: {
										type: "tedi" as const,
										id: assignment.tediId,
									},
								}
							: {
									executorReference: workExecutorReference(assignment.executor),
								}),
						...(assignment.tediId
							? {
									accountableOwnerType: "tedi" as const,
									accountableOwnerId: assignment.tediId,
								}
							: {}),
					});
				}
			}
			const observation = input.observation
				? await recordCommentObservation(context, workItem, {
						...input.observation,
						body: input.body,
					})
				: undefined;
			const comment = await addWorkItemComment(context.db, {
				id: crypto.randomUUID(),
				workItemId: input.id,
				orgId: workItem.orgId,
				authorType: author.authorType,
				authorId: author.authorId,
				recordActivity: true,
				body: input.body,
				metadata: toJsonRecord({
					...author.metadata,
					...(observation ? { observationId: observation.id } : {}),
				}),
				createdAt: new Date().toISOString(),
			});

			return comment;
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);
