import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateAdminBillingSearch } from "@/lib/admin-billing-search";

export const Route = createFileRoute("/_session/_tenant/settings/billing")({
	validateSearch: validateAdminBillingSearch,
	beforeLoad: ({ search }) => {
		throw redirect({ to: "/admin/billing", search, replace: true });
	},
});
