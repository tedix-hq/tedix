import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WorkspaceChat } from "../src/components/workspace-chat";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={new QueryClient()}>
		<WorkspaceChat
			workspaceId="fictional-workspace"
			conversationId="c1"
			listOpen={false}
			onOpenList={() => {}}
			onSelectConversation={() => {}}
		/>
	</QueryClientProvider>,
);
