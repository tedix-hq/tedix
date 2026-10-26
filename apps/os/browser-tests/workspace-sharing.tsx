import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { KumoLinkProvider } from "../src/components/kumo/link-provider";
import { SharedWorkspacePage } from "../src/components/shared-workspace-page";
import { WorkspaceAccessBoundary } from "../src/components/workspace-access-boundary";
import { WorkspaceShareDialog } from "../src/components/workspace-share-dialog";
import "../src/styles.css";

const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<KumoLinkProvider>
			{params.get("view") === "workspace" ? (
				<WorkspaceAccessBoundary workspaceId={WORKSPACE_ID}>
					<div data-live-workspace>Workspace editor and chat</div>
				</WorkspaceAccessBoundary>
			) : params.get("view") === "page" ? (
				<SharedWorkspacePage workspaceId={WORKSPACE_ID} />
			) : (
				<WorkspaceShareDialog
					workspaceId={WORKSPACE_ID}
					workspaceName="Reddit research"
					open
					onOpenChange={() => undefined}
				/>
			)}
		</KumoLinkProvider>
	</QueryClientProvider>,
);
