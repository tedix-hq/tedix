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
import { SkillSchedulePage } from "../src/components/skill-schedule-page";
import {
	Page,
	PageHeader,
	PageTitle,
	PageSection,
} from "../src/components/kumo/page";
import { setOsFormattingPreferences } from "../src/lib/format";
import {
	skillSpecificSchedulesQueryOptions,
	tediNamesQueryOptions,
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
client.setQueryData(tediNamesQueryOptions().queryKey, {
	data: [{ id: "worker", name: "Example worker" }],
});
function Surface() {
	return (
		<Page width="md">
			<PageHeader>
				<PageTitle>Skill schedules</PageTitle>
			</PageHeader>
			<PageSection>
				<SkillSchedulePage />
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
const router = createRouter({
	routeTree: rootRoute.addChildren([
		session.addChildren([tenant.addChildren([skill])]),
	]),
	history: createMemoryHistory({ initialEntries: ["/skills/alpha"] }),
});
Object.assign(window, {
	scheduleFixture: {
		refresh: () =>
			client.refetchQueries(skillSpecificSchedulesQueryOptions("alpha")),
		navigate: () =>
			router.navigate({ to: "/skills/$skillId", params: { skillId: "beta" } }),
	},
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
