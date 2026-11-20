import type { SearchSchemaInput } from "@tanstack/react-router";

export type BillingCheckoutState =
	| "success"
	| "cancelled"
	| "topup-success"
	| "topup-cancelled";

export type AdminBillingSection =
	| "overview"
	| "plan"
	| "credit-packs"
	| "limits"
	| "invoices";

export type AdminBillingSearch = {
	checkout?: BillingCheckoutState;
	tab?: AdminBillingSection;
};

export function validateAdminBillingSearch(
	search: AdminBillingSearch & SearchSchemaInput,
): AdminBillingSearch {
	const { checkout: raw, tab, section } = search as Record<string, unknown>;
	const checkout =
		raw === "success" ||
		raw === "cancelled" ||
		raw === "topup-success" ||
		raw === "topup-cancelled"
			? raw
			: undefined;

	if (
		tab === "overview" ||
		tab === "plan" ||
		tab === "credit-packs" ||
		tab === "limits" ||
		tab === "invoices"
	) {
		return { checkout, tab };
	}
	if (section === "invoices") return { checkout, tab: "invoices" };
	if (
		section === "subscription" ||
		checkout === "success" ||
		checkout === "cancelled"
	) {
		return { checkout, tab: "plan" };
	}
	if (checkout === "topup-success" || checkout === "topup-cancelled") {
		return { checkout, tab: "credit-packs" };
	}
	return {};
}
