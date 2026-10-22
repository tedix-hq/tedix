import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { createRoot } from "react-dom/client";
import { WorkspacePersonalAccess } from "../src/components/workspace-personal-access";
import { osQuery } from "../src/lib/os-query-options";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const resource: OsWorkspaceResource = {
	id: "22222222-2222-4222-8222-222222222222",
	organizationId: "fictional-org",
	workspaceId: WORKSPACE_ID,
	slot: "mail",
	providerId: "sample-mail",
	connectionScope: "user",
	personalOwnerUserId: "fictional-owner",
	connectionInstanceId: "33333333-3333-4333-8333-333333333333",
	providerAccess: null,
	requiredScopes: [],
	resourceType: "mailbox",
	providerResourceId: "sample-mailbox",
	name: "Sample mailbox",
	metadata: {},
	status: "active",
	createdByKind: "user",
	createdById: "fictional-owner",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	removedAt: null,
};

const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false },
		mutations: { retry: false },
	},
});
// The spec's local dispatcher drives read-only refreshes through this event.
window.addEventListener("access-refresh", () => {
	void client.refetchQueries({
		queryKey: osQuery.personalResourceDelegations.list.key(),
	});
});
// …and waits on this probe so assertions always run after a fetch settled.
(window as unknown as { accessReadsPending: () => number }).accessReadsPending =
	() => client.isFetching();
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="mx-auto max-w-md p-4">
			<WorkspacePersonalAccess workspaceId={WORKSPACE_ID} resource={resource} />
		</main>
	</QueryClientProvider>,
);
