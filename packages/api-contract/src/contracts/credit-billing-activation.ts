import { oc } from "@orpc/contract";
import {
	ConfigureCreditBillingInputSchema,
	ConfigureCreditBillingResponseSchema,
	RepriceCreditBillingInputSchema,
	RepriceCreditBillingResponseSchema,
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
	repriceCreditBilling: oc
		.route({
			method: "POST",
			path: "/reprice-credit-billing",
			tags: ["internal"],
			description:
				"Platform billing authority: replace a live credit wallet's rate snapshot with newly bound published provider receipts. Balance, included credits, monthly cap and run budget are unchanged; in-flight reservations keep the price they were admitted at.",
		})
		.input(RepriceCreditBillingInputSchema)
		.output(RepriceCreditBillingResponseSchema),
};
