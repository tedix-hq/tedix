/**
 * Business-only terms shown on every Stripe Checkout page.
 *
 * Tedix sells to entrepreneurs under § 14 BGB only (terms.astro), so Checkout
 * collects the invoice address and an optional tax ID and states the business
 * declaration next to the pay button. The operator is a Kleinunternehmer, so
 * the same text says no VAT is charged. `consent_collection` is deliberately
 * absent: Stripe rejects it unless a terms URL is set in the Stripe account.
 */
const CHECKOUT_SUBMIT_MESSAGE =
	"Tedix is offered to businesses only (§ 14 BGB). By continuing you confirm you are ordering as a business and accept the [Terms](https://tedix.dev/terms/) and [Privacy Policy](https://tedix.dev/privacy/). No VAT is charged (Kleinunternehmer, § 19 UStG).";

export function checkoutBusinessTermsParams(options: {
	hasExistingCustomer: boolean;
}) {
	return {
		billing_address_collection: "required" as const,
		tax_id_collection: { enabled: true },
		// Stripe requires this to save collected details on an existing customer.
		...(options.hasExistingCustomer
			? { customer_update: { name: "auto" as const, address: "auto" as const } }
			: {}),
		custom_text: { submit: { message: CHECKOUT_SUBMIT_MESSAGE } },
	};
}
