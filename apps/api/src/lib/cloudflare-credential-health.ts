/**
 * Immediate Cloudflare credential-drift finding for the AI Gateway cost probe.
 *
 * The provider error is deliberately classified, then discarded. Persisted and
 * delivered text contains only stable Worker/binding/gateway identifiers and a
 * remediation URL — never a response body, request header, account id, or token.
 */

import type { DbClient } from "@tedix/db/client";
import {
	getAlertState,
	markAlertsResolved,
	recordAlertState,
} from "@tedix/db/queries/ops-alert-state";
import type { GatewayIngestionResult } from "../jobs/gateway-cost-ingestion";
import { sendOpsAlert } from "./ops-alert-egress";

export const CLOUDFLARE_CREDENTIAL_CONDITION_KEY =
	"cloudflare-credential-drift:tedix-api-production:ai-gateway";
export const CLOUDFLARE_CREDENTIAL_REMEDIATION_URL =
	"https://developers.cloudflare.com/ai-gateway/configuration/authentication/";

type CredentialBinding = "CF_ACCOUNT_ID" | "CF_AI_GATEWAY_TOKEN";

export interface CloudflareCredentialFinding {
	conditionKey: typeof CLOUDFLARE_CREDENTIAL_CONDITION_KEY;
	workerName: "tedix-api-production";
	bindingNames: CredentialBinding[];
	gatewayIds: string[];
	remediationUrl: typeof CLOUDFLARE_CREDENTIAL_REMEDIATION_URL;
	detail: string;
}

export type CloudflareCredentialProbe =
	| { status: "firing"; finding: CloudflareCredentialFinding }
	| { status: "healthy" }
	| { status: "indeterminate" };

function bindingsForFailure(failure: string): CredentialBinding[] {
	const bindings = new Set<CredentialBinding>();
	if (/CF_AI_GATEWAY_TOKEN is not set/i.test(failure)) {
		bindings.add("CF_AI_GATEWAY_TOKEN");
	}
	if (/\b(?:7000|7003)\b/.test(failure)) {
		bindings.add("CF_ACCOUNT_ID");
	}
	if (/\b9106\b|authentication failed/i.test(failure)) {
		bindings.add("CF_AI_GATEWAY_TOKEN");
	}
	return [...bindings].sort();
}

/** Classify the provider result without retaining its raw error text. */
export function classifyCloudflareCredentialProbe(
	results: GatewayIngestionResult[],
): CloudflareCredentialProbe {
	if (results.length === 0) return { status: "indeterminate" };
	if (results.every((result) => result.failure === null)) {
		return { status: "healthy" };
	}

	const bindingNames = new Set<CredentialBinding>();
	const gatewayIds = new Set<string>();
	for (const result of results) {
		if (!result.failure) continue;
		const matched = bindingsForFailure(result.failure);
		if (matched.length === 0) continue;
		gatewayIds.add(result.gatewayId);
		for (const binding of matched) bindingNames.add(binding);
	}
	if (bindingNames.size === 0) return { status: "indeterminate" };

	const bindings = [...bindingNames].sort();
	const gateways = [...gatewayIds].sort();
	const workerName = "tedix-api-production" as const;
	const remediationUrl = CLOUDFLARE_CREDENTIAL_REMEDIATION_URL;
	return {
		status: "firing",
		finding: {
			conditionKey: CLOUDFLARE_CREDENTIAL_CONDITION_KEY,
			workerName,
			bindingNames: bindings,
			gatewayIds: gateways,
			remediationUrl,
			detail: `Cloudflare credential drift: worker=${workerName}; bindings=${bindings.join(",")}; gateways=${gateways.join(",")}; repair=${remediationUrl}`,
		},
	};
}

export interface CloudflareCredentialFindingResult {
	lifecycle: "new" | "ongoing" | "resolved" | "unchanged";
	finding: CloudflareCredentialFinding | null;
}

/**
 * Reconcile one deterministic finding. A recognized mismatch opens/refreshes;
 * only a fully successful two-gateway probe resolves. Indeterminate failures
 * preserve prior state so a network incident cannot impersonate a repair.
 */
export async function reconcileCloudflareCredentialFinding(
	db: DbClient,
	env: CloudflareEnv,
	results: GatewayIngestionResult[],
	nowIso: string,
): Promise<CloudflareCredentialFindingResult> {
	const probe = classifyCloudflareCredentialProbe(results);
	if (probe.status === "indeterminate") {
		return { lifecycle: "unchanged", finding: null };
	}

	const previous = await getAlertState(db, CLOUDFLARE_CREDENTIAL_CONDITION_KEY);
	if (probe.status === "healthy") {
		if (previous?.status !== "open") {
			return { lifecycle: "unchanged", finding: null };
		}
		await markAlertsResolved(db, [CLOUDFLARE_CREDENTIAL_CONDITION_KEY], nowIso);
		await sendOpsAlert(env, {
			subject: "[Tedix Health] resolved · Cloudflare credential drift",
			text: `RESOLVED: ${previous.detail}\n\nA complete AI Gateway logs probe succeeded at ${nowIso}.`,
			emailRecipients: env.HEALTH_ALERT_EMAIL,
			webhookUrl: env.HEALTH_ALERT_WEBHOOK,
			meta: {
				conditionKey: CLOUDFLARE_CREDENTIAL_CONDITION_KEY,
				lifecycle: "resolved",
			},
		});
		console.log(
			JSON.stringify({
				signal: "platform.health.finding",
				conditionKey: CLOUDFLARE_CREDENTIAL_CONDITION_KEY,
				lifecycle: "resolved",
				asOf: nowIso,
			}),
		);
		return { lifecycle: "resolved", finding: null };
	}

	const finding = probe.finding;
	const isNew = previous?.status !== "open";
	await recordAlertState(db, {
		conditionKey: finding.conditionKey,
		severity: "P1",
		metricBucket: "1",
		detail: finding.detail,
		status: "open",
		firstSeenAt: isNew ? nowIso : previous.firstSeenAt,
		lastSeenAt: nowIso,
		lastNotifiedAt: isNew ? nowIso : previous.lastNotifiedAt,
		notifyCount: isNew ? 1 : previous.notifyCount,
	});
	if (isNew) {
		await sendOpsAlert(env, {
			subject: "[Tedix Health] P1 · Cloudflare credential drift",
			text: `NEW: ${finding.detail}\n\nNo secret values or provider response bodies are included in this finding.`,
			emailRecipients: env.HEALTH_ALERT_EMAIL,
			webhookUrl: env.HEALTH_ALERT_WEBHOOK,
			meta: {
				conditionKey: finding.conditionKey,
				workerName: finding.workerName,
				bindingNames: finding.bindingNames,
				gatewayIds: finding.gatewayIds,
				remediationUrl: finding.remediationUrl,
				lifecycle: "new",
			},
		});
	}
	const logFinding = isNew ? console.warn : console.log;
	logFinding(
		JSON.stringify({
			signal: "platform.health.finding",
			conditionKey: finding.conditionKey,
			lifecycle: isNew ? "new" : "ongoing",
			workerName: finding.workerName,
			bindingNames: finding.bindingNames,
			gatewayIds: finding.gatewayIds,
			remediationUrl: finding.remediationUrl,
			asOf: nowIso,
		}),
	);
	return { lifecycle: isNew ? "new" : "ongoing", finding };
}
