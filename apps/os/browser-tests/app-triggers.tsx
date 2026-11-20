import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WorkspaceAppTriggers } from "../src/components/workspace-app-connections";
import "../src/styles.css";

const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="mx-auto max-w-3xl p-6">
			<WorkspaceAppTriggers
				workspaceId="11111111-1111-4111-8111-111111111111"
				gadgetId="22222222-2222-4222-8222-222222222222"
			/>
		</main>
	</QueryClientProvider>,
);
