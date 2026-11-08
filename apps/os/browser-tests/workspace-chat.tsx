import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WorkspaceChat } from "../src/components/workspace-chat";
import { canvasOutputsQueryOptions } from "../src/lib/os-query-options";
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
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<WorkspaceChat
			workspaceId="fictional-workspace"
			conversationId="c1"
			listOpen={false}
			onOpenList={() => {}}
			onSelectConversation={() => {}}
			onBrowseResources={() => {}}
		/>
	</QueryClientProvider>,
);
