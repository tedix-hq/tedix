import { oc } from "@orpc/contract";
import {
	ConfigureCreditBillingInputSchema,
	ConfigureCreditBillingResponseSchema,
} from "../schemas/credit-billing-activation";
export const creditBillingActivationContract = {
	configureCreditBilling: oc
		.route({
			method: "POST",
			path: "/configure-credit-billing",
			tags: ["internal"],
			description:
				"Platform billing authority: opt one account into EUR credit pricing (verified USD provider receipts converted at a named ECB rate) without changing its Stripe subscription. Included credits carry forward.",
		})
		.input(ConfigureCreditBillingInputSchema)
		.output(ConfigureCreditBillingResponseSchema),
};
