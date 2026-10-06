/// <reference path="../../worker-configuration.d.ts" />
/**
 * Every-15-minute billing maintenance + AI Gateway cost ingestion tick,
 * owned by this module.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";

export async function runBillingAndGatewayCostTick(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	const { resolveBillingSettlementMode } =
		await import("../lib/billing-settlement-mode");
	const settlementMode = resolveBillingSettlementMode(env);
	try {
		const { createDbClient } = await import("@tedix/db/client");
		const db = createDbClient(env.DB);
		const billingNow = new Date().toISOString();
		const affected = {
			periodsRenewed: 0,
			trialsSuspended: 0,
			creditsExpired: 0,
			reservationsExpired: 0,
		};
		if (settlementMode === "managed") {
			const [
				{ expireBillingCredits },
				{ expireBillingReservations },
				{ rollBillingPeriods },
			] = await Promise.all([
				import("@tedix/db/queries/billing/credits"),
				import("@tedix/db/queries/billing/reservations"),
				import("@tedix/db/queries/billing/plans"),
			]);
			const periods = await rollBillingPeriods(db, billingNow);
			const expiredCredits = await expireBillingCredits(db, billingNow);
			const expiredReservations = await expireBillingReservations(
				db,
				billingNow,
			);
			if (
				periods.renewed > 0 ||
				periods.suspendedTrials > 0 ||
				expiredCredits > 0 ||
				expiredReservations > 0
			) {
				console.log(
					`[Scheduled] Billing maintenance: renewed=${periods.renewed} suspendedTrials=${periods.suspendedTrials} expiredCredits=${expiredCredits} expiredReservations=${expiredReservations}`,
				);
			}
			Object.assign(affected, {
				periodsRenewed: periods.renewed,
				trialsSuspended: periods.suspendedTrials,
				creditsExpired: expiredCredits,
				reservationsExpired: expiredReservations,
			});
		}

		const { ingestGatewayLogCosts } = await import("./gateway-cost-ingestion");
		const results = await ingestGatewayLogCosts(db, env);
		if (settlementMode === "managed") {
			const { resolveStripeEnvironment, getStripeEnvironmentConfig } =
				await import("../lib/stripe-environment");
			const { settleUnbilledGatewayCosts, drainStripeMeterOutbox } =
				await import("./billing-metering");
			const stripeEnvironment = resolveStripeEnvironment(env);
			const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
			const settlement = await settleUnbilledGatewayCosts(
				db,
				stripeEnvironment,
			);
			if (
				settlement.failed > 0 ||
				settlement.quarantined > 0 ||
				settlement.remainingAtLeast > 0
			) {
				console.warn(
					JSON.stringify({
						signal: "billing.settlement.summary",
						settled: settlement.settled,
						failed: settlement.failed,
						quarantined: settlement.quarantined,
						providerUsageRecorded: settlement.providerUsageRecorded,
						remainingAtLeast: settlement.remainingAtLeast,
						errorSummaries: settlement.errorSummaries,
					}),
				);
			}
			const stripe = await drainStripeMeterOutbox(
				db,
				stripeConfig.secretKey,
				stripeEnvironment,
				env,
			);
			if (stripe.failed > 0) {
				console.warn(
					`[gateway-cost-ingestion] Stripe outbox claimed=${stripe.claimed} sent=${stripe.sent} failed=${stripe.failed}`,
				);
			}
		}
		try {
			const { reconcileCloudflareCredentialFinding } =
				await import("../lib/cloudflare-credential-health");
			await reconcileCloudflareCredentialFinding(db, env, results, billingNow);
		} catch (findingError) {
			// Alert persistence/egress is fail-soft: it must never hide the actual
			// ingestion result or turn a healthy provider probe into a failed tick.
			console.warn({
				component: "api.billing-cron",
				event: "billing_credential_health_reconciliation_failed",
				exception: safeExceptionTopology(findingError),
			});
		}
		// A failed gateway must not report as a quiet one. Before this, a
		// persistent AI Gateway auth failure logged `ingested=0 skipped=0` at
		// console.log level every 15 min — indistinguishable from "nothing new"
		// — while the cost ledger stayed empty for days.
		const failed = results.filter((r) => r.failure);
		if (failed.length > 0) {
			console.error({
				component: "api.billing-cron",
				event: "gateway_cost_ingestion_failed",
				failedGateways: failed.length,
				totalGateways: results.length,
			});
			throw new Error(
				`Gateway cost ingestion failed for ${failed.length}/${results.length} gateway(s)`,
			);
		} else {
			const summary = results
				.map(
					(r) => `${r.gatewayId}: ingested=${r.ingested} skipped=${r.skipped}`,
				)
				.join(", ");
			console.log(`[Scheduled] Gateway cost ingestion: ${summary}`);
		}
		try {
			const [{ getBillingReservationFreshness }, { getCostLedgerFreshness }] =
				await Promise.all([
					import("@tedix/db/queries/billing/reservations"),
					import("@tedix/db/queries/tedi-usage"),
				]);
			const [reservations, ledger] = await Promise.all([
				getBillingReservationFreshness(db, Date.parse(billingNow)),
				getCostLedgerFreshness(db, Date.parse(billingNow)),
			]);
			const { reconcileBillingMeteringFreshness } =
				await import("../lib/billing-metering-health");
			await reconcileBillingMeteringFreshness(
				db,
				env,
				{
					reservationCount30d: reservations.count30d,
					maxReservationAt: reservations.maxCreatedAt,
					maxGatewaySnapshotAt: ledger.maxSnapshotAt,
				},
				billingNow,
			);
		} catch (freshnessError) {
			console.warn({
				component: "api.billing-cron",
				event: "billing_metering_freshness_reconciliation_failed",
				exception: safeExceptionTopology(freshnessError),
			});
		}
		return {
			...affected,
			gatewayRowsIngested: results.reduce(
				(sum, result) => sum + result.ingested,
				0,
			),
		};
	} catch (err) {
		console.warn({
			component: "api.billing-cron",
			event: "billing_gateway_cost_tick_failed",
			exception: safeExceptionTopology(err),
		});
		throw err;
	}
}
