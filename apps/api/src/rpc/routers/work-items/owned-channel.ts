import { OwnedChannelAuthorizationReceiptSchema } from "@tedix/api-contract/schemas/mcp-governance";
import { WorkEventSchema } from "@tedix/api-contract/schemas/work-items";
import {
	OWNED_CHANNEL_AUTHORIZATION_EVENT,
	OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
	OWNED_CHANNEL_MAX_AUTHORIZATION_MS,
	getOrganizationOwnedChannel,
	type OrganizationOwnedChannel,
	recordOwnedChannelAuthorizationEvent,
	signOwnedChannelAuthorizationProof,
} from "@tedix/db/queries/mcp-governance";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../../orpc";
import {
	assertWorkItemAccess,
	authOs,
	requireOwnerAdminWorkItemAuthor,
} from "./policy-helpers";

const ownedChannelOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Owned-channel receipts require verified current organization owner/admin membership; all non-user principals are rejected in the handler",
		},
		"mcp:messaging.write",
	),
);

async function writeReceipt(
	context: BaseContext,
	input: { id: string; campaignKey: string },
	eventType:
		| typeof OWNED_CHANNEL_AUTHORIZATION_EVENT
		| typeof OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
	bodyForTime: (
		now: string,
		ownedChannel: OrganizationOwnedChannel | null,
	) => string,
) {
	const item = await assertWorkItemAccess(context, input.id);
	const actorId = await requireOwnerAdminWorkItemAuthor(
		context,
		item.orgId,
		"Owned-channel authorization",
	);
	const campaign = item.metadata?.marketingCampaign;
	if (
		!campaign ||
		typeof campaign !== "object" ||
		Array.isArray(campaign) ||
		campaign.key !== input.campaignKey
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Campaign key must match Work Item metadata.marketingCampaign.key",
		);
	}
	const occurredAt = new Date().toISOString();
	const body = bodyForTime(
		occurredAt,
		await getOrganizationOwnedChannel(context.db, item.orgId),
	);
	const id = crypto.randomUUID();
	const signature = await signOwnedChannelAuthorizationProof(
		context.env.SECRETS_MASTER_KEY,
		{
			commentId: id,
			workItemId: item.id,
			organizationId: item.orgId,
			authorId: actorId,
			eventType,
			body,
			createdAt: occurredAt,
		},
	);
	return WorkEventSchema.parse(
		await recordOwnedChannelAuthorizationEvent(context.db, {
			id,
			orgId: item.orgId,
			workItemId: item.id,
			actorId,
			eventType,
			body,
			signature,
			occurredAt,
		}),
	);
}

export const authorizeOwnedChannelProcedure =
	ownedChannelOs.authorizeOwnedChannel.handler(async ({ input, context }) =>
		writeReceipt(
			context,
			input,
			OWNED_CHANNEL_AUTHORIZATION_EVENT,
			(now, ownedChannel) => {
				if (!ownedChannel?.collection) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Set the organization's owned channel and collection (metadata.ownedChannel.channel and .collection) before authorizing publishing",
					);
				}
				const expiry = Date.parse(input.validUntil);
				if (
					!Number.isFinite(expiry) ||
					expiry <= Date.parse(now) ||
					expiry > Date.parse(now) + OWNED_CHANNEL_MAX_AUTHORIZATION_MS
				) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Owned-channel authorization must expire in the future and within 30 days",
					);
				}
				return JSON.stringify(
					OwnedChannelAuthorizationReceiptSchema.parse({
						version: 1,
						campaignKey: input.campaignKey,
						channel: ownedChannel.channel,
						allowedAction: "content_publish",
						contentRisk: "low",
						collection: ownedChannel.collection,
						contentIds: [...new Set(input.contentIds)],
						validUntil: input.validUntil,
					}),
				);
			},
		),
	);

export const revokeOwnedChannelProcedure =
	ownedChannelOs.revokeOwnedChannel.handler(async ({ input, context }) =>
		writeReceipt(
			context,
			input,
			OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
			// Revocation never depends on configuration: any verified revocation
			// stops every earlier receipt, whatever channel it names.
			(_now, ownedChannel) =>
				JSON.stringify({
					version: 1,
					campaignKey: input.campaignKey,
					channel: ownedChannel?.channel ?? null,
					reason: input.reason,
				}),
		),
	);
