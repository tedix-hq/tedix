import {
	type BillingSettlementMode,
	type RuntimeEntitlementGrant,
} from "@tedix/api-contract/schemas/runtime-entitlements";

export interface BillingSettlementBindings {
	TEDIX_BILLING_SETTLEMENT_MODE?: string;
	TEDIX_RUNTIME_ENTITLEMENT_GRANTS?: string;
}

/** Explicit non-secret deployment policy. Missing or invalid mode fails closed. */
export function resolveBillingSettlementMode(
	env: BillingSettlementBindings,
): BillingSettlementMode {
	switch (env.TEDIX_BILLING_SETTLEMENT_MODE) {
		case "managed":
		case "external":
		case "disabled":
			return env.TEDIX_BILLING_SETTLEMENT_MODE;
		default:
			throw new Error(
				"TEDIX_BILLING_SETTLEMENT_MODE must be explicitly set to managed, external, or disabled",
			);
	}
}

export function resolveInstallationEntitlementGrants(
	env: BillingSettlementBindings,
): RuntimeEntitlementGrant[] {
	if (!env.TEDIX_RUNTIME_ENTITLEMENT_GRANTS?.trim()) return [];
	let value: unknown;
	try {
		value = JSON.parse(env.TEDIX_RUNTIME_ENTITLEMENT_GRANTS);
	} catch {
		throw new Error("TEDIX_RUNTIME_ENTITLEMENT_GRANTS must be valid JSON");
	}
	if (!Array.isArray(value)) {
		throw new Error("TEDIX_RUNTIME_ENTITLEMENT_GRANTS must be a JSON array");
	}
	return value.map((grant) => {
		if (
			!grant ||
			typeof grant !== "object" ||
			Array.isArray(grant) ||
			typeof (grant as Record<string, unknown>).key !== "string"
		) {
			throw new Error(
				"TEDIX_RUNTIME_ENTITLEMENT_GRANTS contains an invalid grant",
			);
		}
		const record = grant as Record<string, unknown>;
		if (
			(record.status !== "active" && record.status !== "inactive") ||
			!(["license", "managed-plan", "operator", "internal"] as const).includes(
				record.source as "license" | "managed-plan" | "operator" | "internal",
			)
		) {
			throw new Error(
				"TEDIX_RUNTIME_ENTITLEMENT_GRANTS contains an invalid grant",
			);
		}
		return {
			key: record.key,
			status: record.status,
			source: record.source,
		} as RuntimeEntitlementGrant;
	});
}
