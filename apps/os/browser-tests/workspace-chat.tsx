import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { WorkspaceChat } from "../src/components/workspace-chat";
import {
	WorkActorDirectoryContext,
	WorkActorOwnerContext,
} from "../src/components/work-actor-avatar";
import {
	canvasOutputsQueryOptions,
	tediNamesQueryOptions,
	tediRosterQueryOptions,
	workspacePresenceQueryOptions,
	workItemRunStepsQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const client = new QueryClient({
	defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});
client.setQueryData<unknown>(
	canvasOutputsQueryOptions("fictional-workspace").queryKey,
	{
		items: [{ id: "native-doc", title: "Planning notes", status: "active" }],
		truncated: false,
	},
);
const tedis = {
	data: [
		{
			id: "tedi-ops",
			displayName: "Operations Tedi",
			scope: "organization",
			status: "active",
		},
		{
			id: "tedi-personal",
			displayName: "Personal Tedi",
			scope: "personal",
			status: "active",
			ownerUserId: "person-subject",
		},
		{
			id: "tedi-other",
			displayName: "Other Person’s Tedi",
			scope: "personal",
			status: "active",
			ownerUserId: "other",
		},
	],
};
client.setQueryData<unknown>(tediNamesQueryOptions().queryKey, tedis);
client.setQueryData<unknown>(
	tediRosterQueryOptions(100, { status: "active" }).queryKey,
	tedis,
);
client.setQueryData<unknown>(
	workspacePresenceQueryOptions("fictional-workspace").queryKey,
	{
		workspaceId: "fictional-workspace",
		userId: "person-subject",
		displayName: "Ada Member",
		role: "owner",
	},
);
const directory = new Map([["user:person-subject", { name: "Ada Member" }]]);
client.setQueryData(workItemRunStepsQueryOptions("fixture-run-task").queryKey, {
	attemptId: "fixture-attempt",
	live: true,
	steps: [
		{
			seq: 1,
			at: Date.now(),
			kind: "started",
			text: "Reading the project files",
		},
	],
	messages: [],
});
const root = createRootRoute({
	component: () => (
		<QueryClientProvider client={client}>
			<WorkActorOwnerContext.Provider value="person-profile">
				<WorkActorDirectoryContext.Provider value={directory}>
					<WorkspaceChat
						workspaceId="fictional-workspace"
						conversationId="c1"
						listOpen={false}
						onOpenList={() => {}}
						onSelectConversation={() => {}}
						onBrowseResources={() => {}}
					/>
				</WorkActorDirectoryContext.Provider>
			</WorkActorOwnerContext.Provider>
		</QueryClientProvider>
	),
});
const router = createRouter({
	routeTree: root,
	history: createMemoryHistory(),
});
createRoot(document.getElementById("root")!).render(
	<RouterProvider router={router} />,
);
