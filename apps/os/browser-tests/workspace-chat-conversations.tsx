import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceChat } from "../src/components/workspace-chat";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const client = new QueryClient({
	defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});

function Pane() {
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [listOpen, setListOpen] = useState(true);
	return (
		<WorkspaceChat
			workspaceId="fictional-workspace"
			conversationId={conversationId}
			listOpen={listOpen}
			onOpenList={() => setListOpen(true)}
			onSelectConversation={(id) => {
				setConversationId(id);
				setListOpen(false);
			}}
		/>
	);
}

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<Pane />
	</QueryClientProvider>,
);
