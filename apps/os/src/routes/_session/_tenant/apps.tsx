import { createFileRoute } from "@tanstack/react-router";
import { AppsPage } from "@/components/apps-page";
import { validateAppsSearch } from "@/lib/apps-search";

export const Route = createFileRoute("/_session/_tenant/apps")({
	validateSearch: validateAppsSearch,
	component: AppsRoute,
});

function AppsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AppsPage
			search={search}
			onSearchChange={(q) =>
				void navigate({ search: { q }, replace: true, resetScroll: false })
			}
		/>
	);
}
