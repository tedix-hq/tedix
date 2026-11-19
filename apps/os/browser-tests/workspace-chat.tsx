import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WorkspaceChat } from "../src/components/workspace-chat";
import { WorkActorOwnerContext } from "../src/components/work-actor-avatar";
import {
	canvasOutputsQueryOptions,
	tediNamesQueryOptions,
	tediRosterQueryOptions,
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
			ownerUserId: "person",
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
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<WorkActorOwnerContext.Provider value="person">
			<WorkspaceChat
				workspaceId="fictional-workspace"
				conversationId="c1"
				listOpen={false}
				onOpenList={() => {}}
				onSelectConversation={() => {}}
				onBrowseResources={() => {}}
			/>
		</WorkActorOwnerContext.Provider>
	</QueryClientProvider>,
);
