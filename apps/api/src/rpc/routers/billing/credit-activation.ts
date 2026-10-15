import type {
	ConfigureCreditBillingInput,
	RepriceCreditBillingInput,
} from "@tedix/api-contract/schemas/credit-billing-activation";
import {
	configureCreditBilling,
	repriceCreditBilling,
} from "@tedix/db/queries/billing/credit-activation";
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
/** Caller must run platform billing authority and fleet authority middleware. */
export async function repriceCreditBillingHandler(
	context: BaseContext,
	input: RepriceCreditBillingInput,
	actor: string,
) {
	return repriceCreditBilling(
		context.db,
		input,
		actor,
		new Date().toISOString(),
	);
}
