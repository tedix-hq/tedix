import type { ConfigureCreditBillingInput } from "@tedix/api-contract/schemas/credit-billing-activation";
import { configureCreditBilling } from "@tedix/db/queries/billing/credit-activation";
import type { BaseContext } from "../../context";
/** Caller must run platform billing authority and fleet authority middleware. */
export async function configureCreditBillingHandler(
	context: BaseContext,
	input: ConfigureCreditBillingInput,
	actor: string,
) {
	return configureCreditBilling(
		context.db,
		input,
		actor,
		new Date().toISOString(),
	);
}
