import { buildInternalServiceBindingContext } from "../rpc/routers/kernel/runtime-shared";
import { createContext } from "../rpc/orpc";
import {
	pruneProviderEvents,
	dueProviderEventSubscriptions,
	claimProviderEventSubscription,
	updateProviderEventSubscription,
} from "@tedix/db/queries/provider-events";
import { resolveProviderEventCredential } from "../services/provider-events/credentials";
import {
	renewSubscription,
	queueReconciliation,
	dispatchProviderEventDeliveries,
	recordSubscriptionFailure,
	RECONCILE_INTERVAL_MS,
	RENEW_BEFORE_MS,
} from "../services/provider-events/subscriptions";
export async function maintainProviderEvents(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	const context = createContext(
		new Request("https://api/internal/provider-events"),
		env,
	);
	const now = new Date().toISOString();
	let renewed = 0,
		reconciled = 0,
		failed = 0;
	for (const row of await dueProviderEventSubscriptions(context.db, now)) {
		if (
			!(await claimProviderEventSubscription(
				context.db,
				row.organizationId,
				row.id,
				now,
				new Date(Date.now() + 60_000).toISOString(),
			))
		)
			continue;
		try {
			const internal = buildInternalServiceBindingContext(
				context,
				row.organizationId,
			);
			const token = await resolveProviderEventCredential(internal, row);
			if (
				row.deliveryMode === "push" &&
				(!row.expiresAt ||
					Date.parse(row.expiresAt) < Date.now() + RENEW_BEFORE_MS)
			) {
				await renewSubscription(internal, row, token);
				renewed++;
			}
			if (
				await queueReconciliation(internal, row, `poll:${row.nextReconcileAt}`)
			)
				reconciled++;
			await updateProviderEventSubscription(
				context.db,
				row.organizationId,
				row.id,
				{
					status: "active",
					lastError: null,
					nextReconcileAt: new Date(
						Date.now() + RECONCILE_INTERVAL_MS,
					).toISOString(),
					leaseUntil: null,
				},
			);
		} catch (error) {
			failed++;
			await recordSubscriptionFailure(context, row, error);
		}
	}
	const pruned = await pruneProviderEvents(
		context.db,
		now,
		new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
	);
	return {
		prunedChannels: pruned.channels,
		prunedDeliveries: pruned.deliveries,
		renewed,
		reconciled,
		failed,
		dispatched: await dispatchProviderEventDeliveries(context),
	};
}
