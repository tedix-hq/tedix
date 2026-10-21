import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { WorkspaceLibraryPage } from "../src/components/workspace-library-page";
import { KumoLinkProvider } from "../src/components/kumo/link-provider";
import {
	activeWorkspacesQueryOptions,
	archivedWorkspacesQueryOptions,
	workspacePreferencesQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false },
		mutations: { retry: false },
	},
});
if (params.has("rejectReconciliation")) {
	client.invalidateQueries = async () => {
		throw new Error("Local reconciliation rejected");
	};
}
// Test-only read refreshes exercise the real component's cached-error branches.
window.addEventListener("library-refresh", (event) => {
	const kind = (event as CustomEvent<string>).detail;
	const options =
		kind === "active"
			? activeWorkspacesQueryOptions()
			: kind === "archived"
				? archivedWorkspacesQueryOptions()
				: workspacePreferencesQueryOptions();
	void client.refetchQueries({ queryKey: options.queryKey, exact: true });
});
const rootRoute = createRootRoute({
	component: () => (
		<QueryClientProvider client={client}>
			<KumoLinkProvider>
				<WorkspaceLibraryPage />
			</KumoLinkProvider>
		</QueryClientProvider>
	),
});
const router = createRouter({
	routeTree: rootRoute,
	history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(
	<RouterProvider router={router} />,
);
