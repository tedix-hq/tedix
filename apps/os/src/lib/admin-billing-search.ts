import type { SearchSchemaInput } from "@tanstack/react-router";

/**
 * URL state for /admin/billing: the Stripe return handshake.
 *
 * Stripe Checkout and the Billing Portal are full-page handoffs, so the ONLY
 * channel a completed flow has back into the SPA is the return URL. apps/api
 * mints `/admin/billing?checkout=success|cancelled` (see
 * `apps/api/src/lib/billing-urls.ts`) and the page reacts once — invalidate
 * the billing reads on success, show a notice, then clear the param with a
 * replace navigation so refresh/back does not replay the handshake.
 *
 * Hand-guarded rather than zod: this module is reachable from the route
 * config in the shared entry chunk, and a two-literal check needs no schema
 * machinery. An unrecognized value degrades to "no handshake", never an
 * error page.
 */

export type BillingCheckoutState =
	| "success"
	| "cancelled"
	| "topup-success"
	| "topup-cancelled";

export type AdminBillingSection = "usage" | "subscription" | "invoices";

export type AdminBillingSearch = {
	checkout?: BillingCheckoutState;
	section?: Exclude<AdminBillingSection, "usage">;
};

export function validateAdminBillingSearch(
	search: AdminBillingSearch & SearchSchemaInput,
): AdminBillingSearch {
	const raw = (search as Record<string, unknown>).checkout;
	const section = (search as Record<string, unknown>).section;
	const checkout =
		raw === "success" ||
		raw === "cancelled" ||
		raw === "topup-success" ||
		raw === "topup-cancelled"
			? raw
			: undefined;
	return {
		...(checkout ? { checkout } : {}),
		...(section === "subscription" || section === "invoices"
			? { section }
			: {}),
	};
}
