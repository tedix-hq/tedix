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
import { SkillVersionsPage } from "../src/components/skill-versions-page";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false },
		mutations: { retry: false },
	},
});
const rootRoute = createRootRoute({ component: Outlet });
const session = createRoute({
	getParentRoute: () => rootRoute,
	id: "_session",
});
const tenant = createRoute({ getParentRoute: () => session, id: "_tenant" });
const skill = createRoute({
	getParentRoute: () => tenant,
	path: "skills/$skillId",
	component: () => (
		<main className="mx-auto grid max-w-3xl gap-4 p-4">
			<SkillVersionsPage />
		</main>
	),
});
const router = createRouter({
	routeTree: rootRoute.addChildren([
		session.addChildren([tenant.addChildren([skill])]),
	]),
	history: createMemoryHistory({ initialEntries: ["/skills/fictional-skill"] }),
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
