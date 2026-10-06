import { createFileRoute } from "@tanstack/react-router";
import { AdminBillingPage } from "@/components/admin-billing-page";
import { validateAdminBillingSearch } from "@/lib/admin-billing-search";
import { prefetchAdminBillingRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/admin/billing")({
	validateSearch: validateAdminBillingSearch,
	// Stripe returns through a full-page navigation. Let SessionBoundary restore
	// the broker session before billing queries run instead of caching a loader
	// 401 while the session cookie is being renewed.
	loaderDeps: ({ search }) => ({ checkout: search.checkout }),
	loader: ({ context, deps }) =>
		deps.checkout ? undefined : prefetchAdminBillingRoute(context.queryClient),
	component: AdminBillingRoute,
	pendingComponent: ListPending,
});

function AdminBillingRoute() {
	const { checkout, section } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AdminBillingPage
			checkout={checkout}
			section={section ?? "usage"}
			onSectionChange={(nextSection) =>
				void navigate({
					search: nextSection === "usage" ? {} : { section: nextSection },
				})
			}
			onClearCheckout={() =>
				void navigate({
					search: section ? { section } : {},
					replace: true,
				})
			}
		/>
	);
}
