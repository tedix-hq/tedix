import type { BillingGatewayReconciliationRow } from "@tedix/db/schema/billing-gateway-reconciliations";

export function hasMaterialGatewayDrift({
	coverage,
	gatewayCostMicros,
	gatewayRequestCount,
}: Pick<
	BillingGatewayReconciliationRow,
	"coverage" | "gatewayCostMicros" | "gatewayRequestCount"
>): boolean {
	if (!coverage) return false;
	return (
		(coverage.missingCostMicros > 1_000_000 &&
			coverage.missingCostMicros * 20 > gatewayCostMicros) ||
		coverage.missingCallCount * 20 > gatewayRequestCount
	);
}
