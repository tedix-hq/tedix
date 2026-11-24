import { claimDelegatedApproval } from "@tedix/db/queries/work-items/delegated-approvals";
import {
	getWorkItemById,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import { requireOrgId } from "../rpc/org-scope";
import { call } from "@orpc/server";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
} from "@tedix/api-contract/schemas/os-decision-deck";
import {
	getWorkInteraction,
	listWorkInteractionResponses,
	respondToWorkInteraction,
	type RespondWorkInteractionParams,
} from "@tedix/db/queries/work-items/interactions";
import { laneHoldDecision } from "@tedix/api-contract/utils/lane-hold-decision";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import {
	recheckDecisionAction,
	staleDecisionError,
} from "./decision-action-recheck";

type Effect = NonNullable<DecisionEnvelope["options"][number]["effect"]>;
type Response = Omit<RespondWorkInteractionParams, "id" | "now">;

async function dispatchEffect(
	context: BaseContext,
	effect: Effect,
	requestId: string,
	proposal: string,
	ownerId: string,
	scope?: string,
) {
	switch (effect.kind) {
		case "create_owner_task": {
			const orgId = requireOrgId(context);
			const source = await getWorkItemById(
				context.db,
				effect.workItemId,
				orgId,
			);
			if (!source)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"The source task is unavailable",
				);
			const sourceIntentId = `decision-owner-task:${requestId}`;
			const lookup = () =>
				getWorkItemBySourceIntentId(context.db, { orgId, sourceIntentId });
			let task = await lookup();
			if (!task) {
				const { createProcedure } =
					await import("../rpc/routers/work-items/creation-reads");
				try {
					task = await call(
						createProcedure,
						{
							title: effect.title,
							description: effect.description,
							workKind: "communication",
							riskLevel: "low",
							parentWorkItemId: source.id,
							projectId: source.projectId ?? undefined,
							accountableOwnerType: "user",
							accountableOwnerId: ownerId,
							sourceIntentId,
							metadata: {
								source: "decision-owner-task",
								requestId,
								sendingReservedForOwner: true,
							},
						},
						{ context },
					);
				} catch (error) {
					task = await lookup();
					if (!task) throw error;
				}
			}
			return { kind: effect.kind, targetId: task.id, state: task.disposition };
		}
		case "accept_work": {
			const { workItemsContractRouter } =
				await import("../rpc/routers/work-items");
			const row = await call(
				workItemsContractRouter.accept,
				{
					id: effect.workItemId,
					acceptanceContract: {
						version: 1,
						doneLooksLike: effect.doneLooksLike,
					},
				},
				{ context },
			);
			return { kind: effect.kind, targetId: row.id, state: row.disposition };
		}
		case "complete_work": {
			const { workItemsContractRouter } =
				await import("../rpc/routers/work-items");
			const row = await call(
				workItemsContractRouter.complete,
				{ id: effect.workItemId },
				{ context },
			);
			return { kind: effect.kind, targetId: row.id, state: row.disposition };
		}
		case "record_adr": {
			const { workItemsContractRouter } =
				await import("../rpc/routers/work-items");
			const row = await call(
				workItemsContractRouter.addComment,
				{
					id: effect.workItemId,
					body: `Architecture decision approved: ${proposal}\nCommit: ${effect.commitSha}`,
					metadata: {
						schema: "tedix.adr-decision.v1",
						requestId,
						commitSha: effect.commitSha,
						decision: "approved",
					},
				},
				{ context },
			);
			return {
				kind: effect.kind,
				targetId: effect.workItemId,
				receiptId: row.id,
				state: "approved",
			};
		}
		case "record_review": {
			const { osWorkspacesContractRouter } =
				await import("../rpc/routers/os-workspaces");
			const output = await call(
				osWorkspacesContractRouter.outputs.get,
				{ outputId: effect.outputId },
				{ context },
			);
			if (output.currentRevision.id !== effect.revisionId)
				throw createError(
					ErrorCodes.CONFLICT,
					"This document changed; review its current revision",
				);
			const { workItemsContractRouter } =
				await import("../rpc/routers/work-items");
			const row = await call(
				workItemsContractRouter.addComment,
				{
					id: effect.workItemId,
					body: `Review approved: ${proposal}\nOutput: ${effect.outputId}; revision: ${effect.revisionId}.`,
					metadata: {
						schema: "tedix.document-review.v1",
						requestId,
						outputId: effect.outputId,
						revisionId: effect.revisionId,
						decision: "approved",
					},
				},
				{ context },
			);
			return {
				kind: effect.kind,
				targetId: effect.workItemId,
				receiptId: row.id,
				state: "approved",
			};
		}
		case "file_request": {
			const { workAgentSessionsContractRouter } =
				await import("../rpc/routers/work-agent-sessions");
			const result = await call(
				workAgentSessionsContractRouter.fileRequest,
				{
					id: effect.requestId,
					projectId: effect.projectId,
					expectedProjectId: effect.expectedProjectId,
				},
				{ context },
			);
			return {
				kind: effect.kind,
				targetId: result.request.id,
				projectId: result.request.projectId ?? null,
				state: "filed",
			};
		}
		case "delegate_work": {
			const orgId = requireOrgId(context);
			const card = await getWorkInteraction(context.db, {
				orgId,
				interactionId: requestId,
			});
			const work = await getWorkItemById(context.db, effect.workItemId, orgId);
			if (!work || card?.workItemId !== work.id)
				throw createError(ErrorCodes.NOT_FOUND, "The task is unavailable");
			if (
				work.accountableOwnerType !== "user" ||
				work.accountableOwnerId !== ownerId
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only the task's accountable owner can allow this",
				);
			if (
				work.disposition !== "accepted" ||
				work.version !== effect.workVersion ||
				work.executorId !== effect.executor
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"The task changed since this card was made; the runner will ask again if it still needs permission",
				);
			const note = delegationScope(scope ?? proposal);
			const { workItemsContractRouter } =
				await import("../rpc/routers/work-items");
			const row = await call(
				workItemsContractRouter.addComment,
				{
					id: work.id,
					body: `Delegation: ${effect.executor} work-version=${work.version} ${note}`,
					metadata: {
						schema: "tedix.lane-delegation.v1",
						requestId,
						executor: effect.executor,
						workVersion: work.version,
					},
				},
				{ context },
			);
			return {
				kind: effect.kind,
				targetId: work.id,
				receiptId: row.id,
				state: "delegated",
			};
		}
		case "restart_work":
		case "cancel_work":
		case "own_work": {
			const orgId = requireOrgId(context);
			const card = await getWorkInteraction(context.db, {
				orgId,
				interactionId: requestId,
			});
			const work = await getWorkItemById(context.db, effect.workItemId, orgId);
			if (!work || card?.workItemId !== work.id)
				throw createError(ErrorCodes.NOT_FOUND, "The task is unavailable");
			if (
				work.disposition !== "accepted" ||
				work.version !== effect.workVersion
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"The task changed since this card was made; open the task to see where it stands",
				);
			// Each procedure applies the task's own owner, admin and steward rules.
			const { workItemsContractRouter } =
				await import("../rpc/routers/work-items");
			const row =
				effect.kind === "cancel_work"
					? await call(
							workItemsContractRouter.cancel,
							{
								id: work.id,
								reason: `Closed from the card “${proposal}”.`.slice(0, 2000),
							},
							{ context },
						)
					: await call(
							workItemsContractRouter.updateSpecification,
							{
								id: work.id,
								expectedWorkItemVersion: work.version,
								...(effect.kind === "own_work"
									? {
											accountableOwnerType: "user" as const,
											accountableOwnerId: ownerId,
										}
									: {
											// A changed agent queues the task for it; the same
											// agent only needs the runner's hold lifted.
											...(effect.executor === work.executorId
												? {}
												: {
														executorReference: {
															type: "external_agent" as const,
															id: effect.executor,
														},
													}),
											laneDispatch: { state: "ready" as const },
										}),
							},
							{ context },
						);
			return {
				kind: effect.kind,
				targetId: work.id,
				state:
					effect.kind === "own_work"
						? "owned"
						: effect.kind === "restart_work"
							? "queued"
							: row.disposition,
			};
		}
		case "publish_docs": {
			const { docsContractRouter } = await import("../rpc/routers/docs");
			const published = await call(
				docsContractRouter.publishBuild,
				{ siteId: effect.siteId, buildId: effect.buildId },
				{ context },
			);
			return {
				kind: effect.kind,
				targetId: effect.siteId,
				receiptId: published.release.id,
				state: "published",
			};
		}
		case "raise_budget_limit": {
			const { getWorkBudgetEnvelopeById } =
				await import("@tedix/db/queries/work-items/budgets");
			const envelope = await getWorkBudgetEnvelopeById(context.db, {
				orgId: requireOrgId(context),
				envelopeId: effect.envelopeId,
			});
			if (!envelope?.enabled)
				throw createError(ErrorCodes.NOT_FOUND, "This budget was removed");
			if (envelope.limitMicros !== effect.expectedLimitMicros)
				throw createError(
					ErrorCodes.CONFLICT,
					"This budget's limit already changed; check it under Work › Capacity",
				);
			// The budget API's own owner/admin check applies.
			const { putBudgetEnvelopeProcedure } =
				await import("../rpc/routers/work-items/factory-lifecycle");
			const raised = await call(
				putBudgetEnvelopeProcedure,
				{
					scopeType: envelope.scopeType,
					scopeId: envelope.scopeId,
					limitMicros: effect.limitMicros,
					reservationMicros: envelope.reservationMicros,
					expectedVersion: envelope.version,
				},
				{ context },
			);
			return {
				kind: effect.kind,
				targetId: raised.id,
				state: "raised",
			};
		}
		case "publish_support": {
			const { supportContractRouter } = await import("../rpc/routers/support");
			const { supportReplyPublishVersion } =
				await import("./support-draft-decision");
			const card = await getWorkInteraction(context.db, {
				orgId: requireOrgId(context),
				interactionId: requestId,
			});
			const receipt = await call(
				supportContractRouter.publish,
				{
					ticketId: effect.ticketId,
					expectedVersion: card
						? await supportReplyPublishVersion(context, card, effect)
						: effect.expectedVersion,
					idempotencyKey: `decision:${requestId}`,
				},
				{ context },
			);
			return {
				kind: effect.kind,
				targetId: effect.ticketId,
				state: receipt.status,
			};
		}
	}
}

/** One bounded sentence on one line; the lane needs at least ten characters. */
export function delegationScope(text: string) {
	const note = text.replace(/\s+/g, " ").trim().slice(0, 500);
	if (note.length < 10)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Write what the agent may do in one sentence",
		);
	return note;
}

/** Claim before any effect. A lost result stays visible and cannot execute twice. */
export async function executeDecisionCardEffect(
	context: BaseContext,
	input: Response,
) {
	const { decisionEffect: _untrustedReceipt, ...clientMetadata } =
		input.metadata ?? {};
	input = { ...input, metadata: clientMetadata };
	let request = await getWorkInteraction(context.db, {
		orgId: input.orgId,
		interactionId: input.interactionId,
	});
	// A runner's hold request is plain text; its answers are derived, not stored.
	const parsed = DecisionEnvelopeSchema.safeParse(
		request?.metadata.decisionDeck ??
			(request ? (laneHoldDecision(request) ?? undefined) : undefined),
	);
	if (request?.metadata.decisionDeck !== undefined && !parsed.success)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This decision has an invalid effect or envelope",
		);
	if (!parsed.success || !parsed.data.options.some((option) => option.effect))
		return input;
	const delegated =
		request && input.responder.type !== "user"
			? await claimDelegatedApproval(context.db, {
					request,
					actor: input.responder,
					expectedVersion: input.expectedVersion,
					now: new Date().toISOString(),
					cardAction:
						typeof input.metadata?.cardAction === "string"
							? input.metadata.cardAction
							: "",
				})
			: null;
	if (delegated) {
		request = delegated.request;
		input = { ...input, expectedVersion: request.version };
	}
	if (
		!delegated &&
		(context.authType !== "user" ||
			input.responder.type !== "user" ||
			context.tediId)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the addressed person can execute a decision card",
		);
	if (
		!request ||
		request.status !== "open" ||
		request.version !== input.expectedVersion ||
		request.targetType !== input.responder.type ||
		request.targetId !== input.responder.id ||
		(request.expiresAt && request.expiresAt <= new Date().toISOString())
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"This decision changed; reload the card",
		);
	const option = parsed.data.options.find(
		(option) => option.id === input.metadata?.cardAction,
	);
	if (input.metadata?.decisionChoice === "change") {
		if (input.resolvesRequest)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"An edited proposal needs a new reviewed decision",
			);
		return input;
	}
	if (!option || option.intent !== input.metadata?.decisionChoice)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Choose an action offered by this decision",
		);
	const metadata = input.metadata ?? {};
	if (!option.effect) return { ...input, metadata };
	if (
		typeof request.metadata.cardContent === "string" &&
		request.metadata.cardContent !==
			(parsed.data.preview?.body ?? request.prompt)
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"This wording changed. The agent must revise the source draft and request a fresh review before this action can run.",
		);
	// The owner may narrow a delegation's scope sentence; it is their own grant.
	const scope =
		option.effect.kind === "delegate_work"
			? typeof metadata.editedBody === "string"
				? metadata.editedBody
				: parsed.data.preview?.body
			: undefined;
	if (
		option.effect.kind !== "delegate_work" &&
		(metadata.feedbackSignal === "edited" ||
			(typeof metadata.editedBody === "string" &&
				metadata.editedBody !==
					(parsed.data.preview?.body ?? parsed.data.recommendation)))
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"An edited proposal needs a new reviewed decision before execution",
		);
	if (
		!input.resolvesRequest ||
		(option.intent !== "approve" &&
			!(
				option.intent === "reject" &&
				(option.effect.kind === "file_request" ||
					option.effect.kind === "cancel_work")
			)) ||
		input.responseKind !==
			(request.kind === "input" ? "input_provided" : "answer")
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"An effect requires an explicit approval of the reviewed proposal",
		);
	const prior = await listWorkInteractionResponses(context.db, {
		orgId: input.orgId,
		interactionId: request.id,
		limit: 100,
	});
	if (prior.some((row) => row.metadata.decisionEffect))
		throw createError(
			ErrorCodes.CONFLICT,
			"This action already started. Check its saved receipt before creating a new decision",
		);
	const reviewedThrough = input.metadata?.reviewedChangesThrough;
	const changed = await recheckDecisionAction(
		context.db,
		request,
		undefined,
		typeof reviewedThrough === "string" ? reviewedThrough : undefined,
	);
	if (changed) throw staleDecisionError(changed);
	const started = await respondToWorkInteraction(context.db, {
		...input,
		id: crypto.randomUUID(),
		now: new Date().toISOString(),
		body: "Decision action started; result pending.",
		resolvesRequest: false,
		metadata: {
			source: "decision-effect",
			decisionEffect: { kind: option.effect.kind, status: "started" },
		},
	});
	try {
		const receipt = await dispatchEffect(
			context,
			option.effect,
			request.id,
			parsed.data.proposal,
			delegated?.receipt.ownerId ?? input.responder.id,
			scope,
		);
		return {
			...input,
			expectedVersion: started.resolvedRequestVersion,
			metadata: {
				...metadata,
				decisionEffect: toJsonRecord({ ...receipt, status: "succeeded" }),
			},
		};
	} catch (error) {
		await respondToWorkInteraction(context.db, {
			...input,
			id: crypto.randomUUID(),
			now: new Date().toISOString(),
			expectedVersion: started.resolvedRequestVersion,
			resolvesRequest: false,
			body: "Decision action did not return a confirmed result. Check the target before retrying.",
			metadata: {
				source: "decision-effect",
				decisionEffect: { kind: option.effect.kind, status: "unconfirmed" },
			},
		});
		throw error;
	}
}
