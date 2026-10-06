/**
 * Retryable provider-ledger settlement and Stripe meter outbox drain.
 *
 * Gateway ingestion remains an append-only provider ledger. This job can
 * always reconstruct missing customer charges from unbilled rows, so a
 * transient D1/Stripe failure cannot be hidden by an advanced Gateway cursor.
 */

import type { DbClient } from "@tedix/db/client";
import {
	claimStripeMeterOutbox,
	markStripeMeterOutboxFailed,
	markStripeMeterOutboxSent,
	STRIPE_METER_OUTBOX_MAX_ATTEMPTS,
} from "@tedix/db/queries/billing/meter-outbox";
import {
	recordBillingProviderUsage,
	recordBillingUsageQuarantines,
} from "@tedix/db/queries/billing/provider-usage";
import { settleBillingUsage } from "@tedix/db/queries/billing/settlement";
import {
	listLegacyUnreservedGatewayCalls,
	listUnrecordedProviderUsageCalls,
	listUnsettledBillableGatewayCalls,
} from "@tedix/db/queries/platform-job-storage";
import type { TediCallCost } from "@tedix/db/schema/tedis";
import type { StripeEnvironment } from "@tedix/api-contract/schemas/billing";

import { getStripe } from "../lib/stripe";

const SETTLEMENT_BATCH_SIZE = 500;
const PROVIDER_USAGE_BATCH_SIZE = 100;
const LEGACY_QUARANTINE_BATCH_SIZE = 5_000;
const STRIPE_OUTBOX_BATCH_SIZE = 100;
const STRIPE_LEASE_MS = 5 * 60 * 1_000;

function billingSource(
	row: TediCallCost,
):
	| "operator"
	| "automation"
	| "observer"
	| "compaction"
	| "kernel"
	| "evaluation"
	| "system" {
	if (
		row.source === "provider-response:runtime:skill-ranking" ||
		row.source === "provider-response:memory:graph-link"
	)
		return "system";
	if (row.sessionType === "tedi_observer") return "observer";
	if (row.sessionType === "kernel") return "kernel";
	if (row.source.includes("compaction")) return "compaction";
	if (
		row.source.includes("cron:") ||
		row.source.includes("schedule") ||
		row.source.includes("automation")
	) {
		return "automation";
	}
	if (row.source.includes("evaluation")) return "evaluation";
	if (row.sessionType === "tedi") return "operator";
	return "system";
}

export interface BillingSettlementResult {
	settled: number;
	failed: number;
	quarantined: number;
	providerUsageRecorded: number;
	remainingAtLeast: number;
	errorSummaries: Array<{ signature: string; count: number }>;
}

function deterministicSettlementFailure(
	error: unknown,
):
	| "missing_billing_account"
	| "missing_plan_version"
	| "invalid_attribution"
	| null {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("Billing account not found")) {
		return "missing_billing_account";
	}
	if (message.startsWith("Billing plan version not found")) {
		return "missing_plan_version";
	}
	if (
		message.startsWith("Billing reservation not found") ||
		message.includes("cannot settle from") ||
		message.includes("FOREIGN KEY constraint failed")
	) {
		return "invalid_attribution";
	}
	return null;
}

function settlementErrorSignature(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>").slice(0, 240);
}

/** A quality hold never authorizes a zero-cost posting or a reservation transition. */
function unpricedUsageReason(call: TediCallCost): string | null {
	if (call.dataQuality !== "ok") return "held_data_quality";
	if (
		typeof call.estimatedCostUsd !== "number" ||
		!Number.isFinite(call.estimatedCostUsd) ||
		call.estimatedCostUsd < 0 ||
		!Number.isSafeInteger(Math.round(call.estimatedCostUsd! * 1_000_000))
	)
		return "invalid_provider_cost";
	if (call.provider !== "workers-ai") {
		if (call.usageKind != null) return "missing_provider_unit_rate";
		if (
			call.costBasis !== "governed_estimate" ||
			!call.rateVersionId ||
			!call.executionId
		)
			return "missing_model_rate";
	}
	return null;
}

async function holdUnpricedUsage(
	db: DbClient,
	call: TediCallCost,
	reason: string,
	now: string,
): Promise<number> {
	return recordBillingUsageQuarantines(db, [
		{
			gatewayLogId: call.gatewayLogId,
			organizationId: call.orgId,
			reason: "unpriced_usage",
			sourceSnapshotAt: call.snapshotAt,
			createdAt: now,
			metadata: {
				classificationReason: reason,
				billingReservationId: call.billingReservationId,
				model: call.model,
				provider: call.provider,
				dataQuality: call.dataQuality,
				usageKind: call.usageKind ?? null,
				usageUnit: call.usageUnit ?? null,
				usageQuantity: call.usageQuantity ?? null,
			},
		},
	]);
}

export async function settleUnbilledGatewayCosts(
	db: DbClient,
	stripeEnvironment: StripeEnvironment = "live",
): Promise<BillingSettlementResult> {
	const now = new Date().toISOString();
	const rows = await listUnsettledBillableGatewayCalls(
		db,
		SETTLEMENT_BATCH_SIZE,
	);

	let settled = 0;
	let failed = 0;
	let quarantined = 0;
	let providerUsageRecorded = 0;
	const errorCounts = new Map<string, number>();
	for (const call of rows) {
		if (!call.orgId) continue;
		try {
			const holdReason = unpricedUsageReason(call);
			if (holdReason) {
				quarantined += await holdUnpricedUsage(db, call, holdReason, now);
				continue;
			}
			await settleBillingUsage(db, {
				stripeEnvironment,
				id: crypto.randomUUID(),
				organizationId: call.orgId,
				tediId: call.tediId,
				reservationId: call.billingReservationId,
				gatewayLogId: call.gatewayLogId,
				provider: call.provider ?? "unknown",
				model: call.model,
				source: billingSource(call),
				inputTokens: call.inputTokens,
				outputTokens: call.outputTokens,
				providerCostMicros: Math.round(call.estimatedCostUsd! * 1_000_000),
				usageQuality: [
					"provider-response:kernel:context-ranking",
					"provider-response:runtime:skill-ranking",
					"provider-response:kernel:action-selection",
					"provider-response:system:tool-output-quality",
					"provider-response:catalog:category",
					"provider-response:memory:graph-link",
				].includes(call.source ?? "")
					? "provider_reported"
					: "gateway_reported",
				providerCostQuality:
					call.provider === "workers-ai" ? "gateway_reported" : "estimated",
				meteringReady: call.totalTokens > 0,
				rateCardVersion: call.rateVersionId ?? "gateway-reported",
				occurredAt: call.snapshotAt,
				metadata: {
					gatewayId: call.gatewayId,
					providerResource: call.providerResource,
					deployment: call.deployment,
					dataQuality: call.dataQuality,
					cacheReadTokens: call.cacheReadTokens,
					cacheWriteTokens: call.cacheWriteTokens,
					runId: call.runId,
					workItemId: call.workItemId,
				},
				now,
			});
			settled++;
		} catch (error) {
			const deterministicReason = deterministicSettlementFailure(error);
			if (deterministicReason) {
				quarantined += await recordBillingUsageQuarantines(db, [
					{
						gatewayLogId: call.gatewayLogId,
						organizationId: call.orgId,
						reason: deterministicReason,
						sourceSnapshotAt: call.snapshotAt,
						metadata: {
							billingReservationId: call.billingReservationId,
							model: call.model,
							provider: call.provider,
							error: settlementErrorSignature(error),
						},
						createdAt: now,
					},
				]);
				continue;
			}
			failed++;
			const signature = settlementErrorSignature(error);
			errorCounts.set(signature, (errorCounts.get(signature) ?? 0) + 1);
		}
	}

	const providerRows = await listUnrecordedProviderUsageCalls(
		db,
		PROVIDER_USAGE_BATCH_SIZE,
	);
	for (const call of providerRows) {
		try {
			const holdReason = unpricedUsageReason(call);
			if (holdReason) {
				quarantined += await holdUnpricedUsage(db, call, holdReason, now);
				continue;
			}
			await recordBillingProviderUsage(db, {
				id: crypto.randomUUID(),
				organizationId: call.orgId,
				tediId: call.tediId,
				reservationId: call.billingReservationId,
				gatewayLogId: call.gatewayLogId,
				provider: call.provider ?? "unknown",
				model: call.model,
				usageKind: call.usageKind as
					| "voice_stt"
					| "voice_tts"
					| "image_generation"
					| "workstation_compute"
					| "other",
				unit: call.usageUnit as
					| "seconds"
					| "characters"
					| "images"
					| "compute_seconds"
					| "units",
				quantity: call.usageQuantity ?? 0,
				providerCostMicros: Math.round(call.estimatedCostUsd! * 1_000_000),
				providerCostQuality:
					call.provider === "workers-ai" ? "gateway_reported" : "estimated",
				occurredAt: call.snapshotAt,
				metadata: {
					gatewayId: call.gatewayId,
					source: call.source,
					dataQuality: call.dataQuality,
				},
				now,
			});
			providerUsageRecorded++;
		} catch (error) {
			failed++;
			const signature = settlementErrorSignature(error);
			errorCounts.set(signature, (errorCounts.get(signature) ?? 0) + 1);
		}
	}

	const errorSummaries = [...errorCounts.entries()]
		.map(([signature, count]) => ({ signature, count }))
		.sort(
			(a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
		);
	if (errorSummaries.length > 0) {
		console.error(
			JSON.stringify({
				signal: "billing.settlement.failed",
				failed,
				errorSummaries,
			}),
		);
	}
	return {
		settled,
		failed,
		quarantined,
		providerUsageRecorded,
		remainingAtLeast:
			rows.length === SETTLEMENT_BATCH_SIZE ||
			providerRows.length === PROVIDER_USAGE_BATCH_SIZE
				? 1
				: 0,
		errorSummaries,
	};
}

export interface LegacyBillingQuarantineResult {
	selected: number;
	quarantined: number;
	remainingAtLeast: number;
}

/**
 * Classify historical pre-reservation Gateway rows outside the 15-minute
 * ingestion/settlement hot path. The bounded daily batch lets the permanent
 * quarantine converge without repeatedly scanning legacy history on every
 * Gateway poll.
 */
export async function quarantineLegacyGatewayCosts(
	db: DbClient,
	limit = LEGACY_QUARANTINE_BATCH_SIZE,
): Promise<LegacyBillingQuarantineResult> {
	const batchSize = Math.max(
		1,
		Math.min(LEGACY_QUARANTINE_BATCH_SIZE, Math.floor(limit)),
	);
	const now = new Date().toISOString();
	const legacyRows = await listLegacyUnreservedGatewayCalls(db, batchSize);
	const quarantined = await recordBillingUsageQuarantines(
		db,
		legacyRows.map((call) => ({
			gatewayLogId: call.gatewayLogId,
			organizationId: call.orgId,
			reason: "missing_reservation" as const,
			sourceSnapshotAt: call.snapshotAt,
			metadata: {
				model: call.model,
				provider: call.provider,
				inputTokens: call.inputTokens,
				outputTokens: call.outputTokens,
				providerCostMicros:
					call.estimatedCostUsd === null
						? null
						: Math.max(0, Math.round(call.estimatedCostUsd * 1_000_000)),
			},
			createdAt: now,
		})),
	);

	return {
		selected: legacyRows.length,
		quarantined,
		remainingAtLeast: legacyRows.length === batchSize ? 1 : 0,
	};
}

export interface StripeOutboxDrainResult {
	claimed: number;
	sent: number;
	failed: number;
}

interface StripeOutboxAlertEnv {
	EMAIL?: SendEmail;
	HEALTH_ALERT_EMAIL?: string;
	HEALTH_ALERT_WEBHOOK?: string;
}

function retryAt(attemptCount: number, nowMs: number): string {
	const delayMs = Math.min(
		24 * 60 * 60 * 1_000,
		30_000 * 2 ** Math.min(attemptCount, 10),
	);
	return new Date(nowMs + delayMs).toISOString();
}

export async function drainStripeMeterOutbox(
	db: DbClient,
	stripeSecretKey: string | undefined,
	stripeEnvironment: StripeEnvironment = "live",
	alertEnv?: StripeOutboxAlertEnv,
): Promise<StripeOutboxDrainResult> {
	if (!stripeSecretKey?.trim()) return { claimed: 0, sent: 0, failed: 0 };
	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	const rows = await claimStripeMeterOutbox(db, {
		stripeEnvironment,
		now,
		leaseExpiresAt: new Date(nowMs + STRIPE_LEASE_MS).toISOString(),
		limit: STRIPE_OUTBOX_BATCH_SIZE,
	});
	const stripe = await getStripe(stripeSecretKey);
	let sent = 0;
	let failed = 0;
	for (const row of rows) {
		try {
			const event = await stripe.billing.meterEvents.create(
				{
					event_name: row.eventName,
					identifier: row.idempotencyKey,
					payload: {
						stripe_customer_id: row.stripeCustomerId,
						value: String(row.quantity),
					},
				},
				{ idempotencyKey: row.idempotencyKey },
			);
			await markStripeMeterOutboxSent(db, {
				id: row.id,
				stripeEventId: event.identifier,
				now: new Date().toISOString(),
			});
			sent++;
		} catch (error) {
			failed++;
			const message = error instanceof Error ? error.message : String(error);
			await markStripeMeterOutboxFailed(db, {
				id: row.id,
				error: message,
				nextAttemptAt: retryAt(row.attemptCount + 1, nowMs),
				now: new Date().toISOString(),
			});
			if (row.attemptCount + 1 >= STRIPE_METER_OUTBOX_MAX_ATTEMPTS) {
				console.error(
					`[billing-metering] Stripe meter outbox row DEAD-LETTERED after ${row.attemptCount + 1} attempts — operator intervention required id=${row.id} identifier=${row.idempotencyKey}:`,
					message,
				);
				if (alertEnv) {
					const { sendOpsAlert } = await import("../lib/ops-alert-egress");
					await sendOpsAlert(alertEnv, {
						subject: "[Tedix Health] P1 · Stripe meter export dead-lettered",
						text:
							`Stripe meter outbox row ${row.id} reached ${row.attemptCount + 1} attempts in ${stripeEnvironment} mode and requires operator intervention. ` +
							"Tedix usage remains durable in D1, but Stripe aggregation is no longer advancing for this row.",
						emailRecipients: alertEnv.HEALTH_ALERT_EMAIL,
						webhookUrl: alertEnv.HEALTH_ALERT_WEBHOOK,
						meta: {
							signal: "billing.stripe_meter_outbox.dead",
							outboxId: row.id,
							attempts: row.attemptCount + 1,
							stripeEnvironment,
						},
					});
				}
			} else {
				console.error(
					`[billing-metering] Stripe meter outbox failed id=${row.id} attempt=${row.attemptCount + 1}:`,
					message,
				);
			}
		}
	}
	return { claimed: rows.length, sent, failed };
}
