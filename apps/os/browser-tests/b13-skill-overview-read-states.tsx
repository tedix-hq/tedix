import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { SkillOverviewPage } from "../src/components/skill-overview-page";
import {
	Page,
	PageHeader,
	PageTitle,
	PageSection,
} from "../src/components/kumo/page";
import { setOsFormattingPreferences } from "../src/lib/format";
import {
	skillReliabilityQueryOptions,
	skillRunsQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";
setOsFormattingPreferences({ locale: "en-US", timezone: "America/New_York" });
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
function Surface() {
	return (
		<Page width="md">
			<PageHeader>
				<PageTitle>Skill overview</PageTitle>
			</PageHeader>
			<PageSection>
				<SkillOverviewPage />
			</PageSection>
		</Page>
	);
}
const rootRoute = createRootRoute({ component: Outlet });
const session = createRoute({
	getParentRoute: () => rootRoute,
	id: "_session",
	component: Outlet,
});
const tenant = createRoute({
	getParentRoute: () => session,
	id: "_tenant",
	component: Outlet,
});
const skill = createRoute({
	getParentRoute: () => tenant,
	path: "skills/$skillId",
	component: Surface,
});
const runs = createRoute({
	getParentRoute: () => tenant,
	path: "skills/$skillId/runs",
	component: () => null,
});
const router = createRouter({
	routeTree: rootRoute.addChildren([
		session.addChildren([tenant.addChildren([skill, runs])]),
	]),
	history: createMemoryHistory({ initialEntries: ["/skills/alpha"] }),
});
Object.assign(window, {
	overviewFixture: {
		refreshReliability: () =>
			client.refetchQueries(skillReliabilityQueryOptions("alpha")),
		refreshRuns: () => client.refetchQueries(skillRunsQueryOptions("alpha")),
		navigate: (skillId: string) =>
			router.navigate({ to: "/skills/$skillId", params: { skillId } }),
	},
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
