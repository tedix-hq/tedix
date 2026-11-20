import { createFileRoute } from "@tanstack/react-router";
import { ComputePage, type UsageTab } from "@/components/compute-page";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/usage")({
	validateSearch: ({ tab }: Record<string, unknown>): { tab?: UsageTab } =>
		tab === "overview" || tab === "tedis" || tab === "members" ? { tab } : {},
	component: UsageRoute,
	pendingComponent: DetailPending,
});

function UsageRoute() {
	const { tab } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ComputePage
			tab={tab ?? "overview"}
			onTabChange={(next) => void navigate({ search: { tab: next } })}
		/>
	);
}
