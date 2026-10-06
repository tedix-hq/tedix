import { createRouterClient } from "@orpc/server";
import type { ProviderEventRegister } from "@tedix/api-contract/schemas/provider-events";
import { ProviderEventStatusSchema } from "@tedix/api-contract/schemas/provider-events";
import {
	createProviderEventSubscription,
	getProviderEventSubscription,
	updateProviderEventSubscription,
	addProviderEventChannel,
	listProviderEventChannels,
	updateProviderEventChannel,
	addProviderEventDelivery,
	listPendingProviderEventDeliveries,
	claimProviderEventDelivery,
	settleProviderEventDelivery,
} from "@tedix/db/queries/provider-events";
import type { BaseContext } from "../../rpc/orpc";
import { buildInternalServiceBindingContext } from "../../rpc/routers/kernel/runtime-shared";
import { resolveProviderEventCredential } from "./credentials";
import { googleCalendarAdapter } from "./google-calendar";
import { microsoftCalendarAdapter } from "./microsoft-calendar";
import {
	callbackTokenHash,
	type Subscription,
	type ProviderAdapter,
} from "./types";
export const RECONCILE_INTERVAL_MS = 5 * 60_000;
export const RENEW_BEFORE_MS = 60 * 60_000;
export function statusProjection(row: Subscription) {
	return ProviderEventStatusSchema.parse(row);
}
export function adapterFor(adapter: Subscription["adapter"]): ProviderAdapter {
	return adapter === "google_calendar"
		? googleCalendarAdapter()
		: microsoftCalendarAdapter();
}
export async function loadSubscription(
	context: BaseContext,
	organizationId: string,
	id: string,
) {
	const row = await getProviderEventSubscription(
		context.db,
		organizationId,
		id,
	);
	if (!row) throw new Error("Calendar subscription not found");
	return row;
}
export async function registerSubscription(
	context: BaseContext,
	organizationId: string,
	input: ProviderEventRegister,
) {
	const now = new Date().toISOString();
	const personal = input.connectionScope === "user";
	if (
		personal &&
		(!input.personalDelegation ||
			context.authType !== "user" ||
			!context.user?.sub ||
			context.tediId)
	)
		throw new Error(
			"Personal subscription installation requires its authenticated account owner and exact consent",
		);
	if (
		!personal &&
		(input.personalDelegation || input.resourceDelegationIds?.length)
	)
		throw new Error(
			"Personal consent cannot be attached to an organization subscription",
		);
	const { personalDelegation, resourceDelegationIds, ...registration } = input;
	const row: Subscription = {
		...registration,
		connectionScope: personal ? "user" : "tenant",
		personalOwnerUserId: personal ? context.user!.sub! : null,
		workspaceId: personalDelegation?.workspaceId ?? null,
		workspaceResourceId: personalDelegation?.resourceId ?? null,
		delegationId: personalDelegation?.delegationId ?? null,
		executionToolId: personalDelegation?.toolId ?? null,
		resourceDelegationIds: personal
			? [
					...new Set([
						personalDelegation!.delegationId,
						...(resourceDelegationIds ?? []),
					]),
				]
			: [],
		id: crypto.randomUUID(),
		organizationId,
		connectionInstanceId: input.connectionInstanceId,
		status: "registering",
		expiresAt: null,
		lastNotificationAt: null,
		lastDispatchAt: null,
		lastError: null,
		leaseUntil: null,
		nextReconcileAt: now,
		createdAt: now,
		updatedAt: now,
	};
	// A personal standing lease is validated from its exact persisted pending record.
	// Pending rows do not admit provider callbacks or execution until validation succeeds.
	let token: string;
	if (!personal) {
		token = await resolveProviderEventCredential(context, row);
		await adapterFor(row.adapter).validateCalendar(token, row);
	}
	await createProviderEventSubscription(context.db, row);
	try {
		if (personal) {
			token = await resolveProviderEventCredential(context, row);
			await adapterFor(row.adapter).validateCalendar(token, row);
		}
		if (row.deliveryMode === "push")
			await renewSubscription(context, row, token!);
		else
			await updateProviderEventSubscription(
				context.db,
				organizationId,
				row.id,
				{ status: "active" },
			);
		await queueReconciliation(context, row, `initial:${row.id}`);
	} catch (error) {
		await recordSubscriptionFailure(context, row, error);
	}
	return statusProjection(
		await loadSubscription(context, organizationId, row.id),
	);
}
export async function recordSubscriptionFailure(
	context: BaseContext,
	row: Subscription,
	error: unknown,
) {
	// Never persist/log upstream response bodies, bearer tokens or callback secrets.
	console.error("[provider-events] operation failed", {
		subscriptionId: row.id,
		adapter: row.adapter,
	});
	const message =
		error instanceof Error &&
		/^Provider request failed \(\d+\)$/.test(error.message)
			? error.message
			: "Calendar event operation failed; verify connection, workflow and provider permissions";
	await updateProviderEventSubscription(
		context.db,
		row.organizationId,
		row.id,
		{
			status: "error",
			lastError: message,
			nextReconcileAt: new Date(
				Date.now() + RECONCILE_INTERVAL_MS,
			).toISOString(),
			leaseUntil: null,
		},
	);
}
export async function renewSubscription(
	context: BaseContext,
	row: Subscription,
	credential?: string,
) {
	const token =
		credential ?? (await resolveProviderEventCredential(context, row));
	const origin = new URL(context.env.API_URL);
	if (origin.protocol !== "https:")
		throw new Error("Public HTTPS API origin required");
	const channelId = crypto.randomUUID();
	const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	await addProviderEventChannel(context.db, {
		id: channelId,
		subscriptionId: row.id,
		organizationId: row.organizationId,
		tokenHash: await callbackTokenHash(secret),
		status: "pending",
		expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		createdAt: now,
	});
	const callback = new URL(
		`/webhooks/provider-events/${row.adapter}/${channelId}`,
		origin,
	).href;
	const result = await adapterFor(row.adapter).register(
		token,
		row,
		channelId,
		secret,
		callback,
	);
	// Disabled while provider registration was in flight: stop instead of reviving.
	const current = await loadSubscription(context, row.organizationId, row.id);
	if (current.status === "disabled") {
		await adapterFor(row.adapter).stop(
			token,
			result.providerChannelId,
			result.resourceId,
		);
		await updateProviderEventChannel(
			context.db,
			row.organizationId,
			channelId,
			{ status: "stopped" },
		);
		return;
	}
	await updateProviderEventChannel(context.db, row.organizationId, channelId, {
		...result,
		status: "active",
	});
	await updateProviderEventSubscription(
		context.db,
		row.organizationId,
		row.id,
		{ status: "active", expiresAt: result.expiresAt, lastError: null },
	);
	// Keep old registrations until replacement accepted. Failed cleanup stays retryable.
	await cleanupChannels(context, row, token, channelId);
}
export async function cleanupChannels(
	context: BaseContext,
	row: Subscription,
	token: string,
	keepId?: string,
) {
	for (const channel of await listProviderEventChannels(
		context.db,
		row.organizationId,
		row.id,
	)) {
		if (channel.id === keepId || channel.status === "stopped") continue;
		if (channel.providerChannelId)
			await adapterFor(row.adapter).stop(
				token,
				channel.providerChannelId,
				channel.resourceId,
			);
		await updateProviderEventChannel(
			context.db,
			row.organizationId,
			channel.id,
			{ status: "stopped" },
		);
	}
}
export async function disableSubscription(
	context: BaseContext,
	organizationId: string,
	id: string,
) {
	const row = await loadSubscription(context, organizationId, id);
	// Persist revocation before external cleanup; failure must never restore authority.
	await updateProviderEventSubscription(context.db, organizationId, id, {
		status: "disabled",
		leaseUntil: null,
	});
	try {
		await cleanupChannels(
			context,
			row,
			await resolveProviderEventCredential(context, row),
		);
	} catch {
		await updateProviderEventSubscription(context.db, organizationId, id, {
			lastError:
				"Disabled locally; provider cleanup awaits restored connection or channel expiry",
		});
	}
	return statusProjection(await loadSubscription(context, organizationId, id));
}
export async function queueReconciliation(
	context: BaseContext,
	row: Subscription,
	key: string,
) {
	const current = await loadSubscription(context, row.organizationId, row.id);
	if (current.status === "disabled") return false;
	const id = await callbackTokenHash(`${row.organizationId}:${row.id}:${key}`);
	const inserted = await addProviderEventDelivery(context.db, {
		id,
		organizationId: row.organizationId,
		subscriptionId: row.id,
		status: "pending",
		createdAt: new Date().toISOString(),
	});
	return inserted.length > 0;
}
export function reconciliationEvent(row: Subscription, deliveryId: string) {
	return {
		kind: "skill_workflow" as const,
		organizationId: row.organizationId,
		tediId: row.tediId,
		skillId: row.skillId,
		expectedSkillRevision: row.skillRevision,
		idempotencyKey: `provider-event:${deliveryId}`,
		source: `provider:${row.adapter}`,
		params: {
			providerEvent: {
				subscriptionId: row.id,
				adapter: row.adapter,
				providerId: row.providerId,
				connectionInstanceId: row.connectionInstanceId,
				calendarId: row.calendarId,
				skillRevision: row.skillRevision,
			},
		},
	};
}
export async function dispatchProviderEventDeliveries(context: BaseContext) {
	let sent = 0;
	const now = new Date().toISOString();
	for (const delivery of await listPendingProviderEventDeliveries(
		context.db,
		now,
	)) {
		if (
			!(await claimProviderEventDelivery(
				context.db,
				delivery.id,
				delivery.organizationId,
				now,
				new Date(Date.now() + 60_000).toISOString(),
			))
		)
			continue;
		const row = await getProviderEventSubscription(
			context.db,
			delivery.organizationId,
			delivery.subscriptionId,
		);
		if (delivery.attempts >= 10 && row) {
			await settleProviderEventDelivery(
				context.db,
				delivery.id,
				delivery.organizationId,
				"discarded",
				now,
			);
			await updateProviderEventSubscription(
				context.db,
				row.organizationId,
				row.id,
				{
					status: "error",
					lastError:
						"Notification delivery exhausted retries; restore access and reconcile manually",
				},
			);
			continue;
		}
		if (!row || row.status === "disabled") {
			await settleProviderEventDelivery(
				context.db,
				delivery.id,
				delivery.organizationId,
				"discarded",
				now,
			);
			continue;
		}
		try {
			await resolveProviderEventCredential(context, row);
			const current = await loadSubscription(
				context,
				row.organizationId,
				row.id,
			);
			if (current.status === "disabled") {
				await settleProviderEventDelivery(
					context.db,
					delivery.id,
					delivery.organizationId,
					"discarded",
					now,
				);
				continue;
			}
			const { cognitiveRuntimeContractRouter } =
				await import("../../rpc/routers/cognitive-runtime");
			const client = createRouterClient(cognitiveRuntimeContractRouter, {
				context: buildInternalServiceBindingContext(
					context,
					row.organizationId,
				),
			});
			await client.emitAutomationEvent({
				event: reconciliationEvent(row, delivery.id),
			});
			await settleProviderEventDelivery(
				context.db,
				delivery.id,
				delivery.organizationId,
				"sent",
				now,
			);
			await updateProviderEventSubscription(
				context.db,
				row.organizationId,
				row.id,
				{ lastDispatchAt: now },
			);
			sent++;
		} catch (error) {
			await settleProviderEventDelivery(
				context.db,
				delivery.id,
				delivery.organizationId,
				"pending",
				now,
			);
			await recordSubscriptionFailure(context, row, error);
		}
	}
	return sent;
}
