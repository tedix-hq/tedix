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
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";

type Effect = NonNullable<DecisionEnvelope["options"][number]["effect"]>;
type Response = Omit<RespondWorkInteractionParams, "id" | "now">;

async function dispatchEffect(
	context: BaseContext,
	effect: Effect,
	requestId: string,
	proposal: string,
	ownerId: string,
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

/** Claim before any effect. A lost result stays visible and cannot execute twice. */
export async function executeDecisionCardEffect(
	context: BaseContext,
	input: Response,
) {
	const { decisionEffect: _untrustedReceipt, ...clientMetadata } =
		input.metadata ?? {};
	input = { ...input, metadata: clientMetadata };
	const request = await getWorkInteraction(context.db, {
		orgId: input.orgId,
		interactionId: input.interactionId,
	});
	const parsed = DecisionEnvelopeSchema.safeParse(
		request?.metadata.decisionDeck,
	);
	if (request?.metadata.decisionDeck !== undefined && !parsed.success)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This decision has an invalid effect or envelope",
		);
	if (!parsed.success || !parsed.data.options.some((option) => option.effect))
		return input;
	if (
		context.authType !== "user" ||
		input.responder.type !== "user" ||
		context.tediId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the addressed person can execute a decision card",
		);
	if (
		!request ||
		request.status !== "open" ||
		request.version !== input.expectedVersion ||
		request.targetType !== "user" ||
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
	if (
		metadata.feedbackSignal === "edited" ||
		(typeof metadata.editedBody === "string" &&
			metadata.editedBody !==
				(parsed.data.preview?.body ?? parsed.data.recommendation))
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"An edited proposal needs a new reviewed decision before execution",
		);
	if (
		!input.resolvesRequest ||
		(option.intent !== "approve" &&
			!(option.intent === "reject" && option.effect.kind === "file_request")) ||
		input.responseKind !== "answer"
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
			input.responder.id,
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
