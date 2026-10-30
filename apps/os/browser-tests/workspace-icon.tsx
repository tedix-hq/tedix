import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { EntityAvatar } from "../src/shared/entity-avatar";
import { KumoLinkProvider } from "../src/components/kumo/link-provider";
import { WorkspaceIconField } from "../src/components/workspace-icon-field";
import { osQuery } from "../src/lib/os-query-options";
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

/** The dialog's icon control beside the tile the breadcrumb and lists show. */
function Harness() {
	const workspace = useQuery(
		osQuery.osWorkspaces.workspaces.get.queryOptions({
			input: { workspaceId: WORKSPACE_ID },
		}),
	).data?.workspace;
	if (!workspace) return null;
	return (
		<main className="grid gap-6 bg-kumo-base p-4 text-kumo-default">
			<div className="flex items-center gap-2" data-testid="breadcrumb">
				<EntityAvatar
					id={workspace.id}
					name={workspace.name}
					image={workspace.iconUrl}
					imageFit="contain"
					kind="workspace"
					className="size-6 rounded-md"
				/>
				<span>{workspace.name}</span>
			</div>
			<WorkspaceIconField workspace={workspace} />
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<KumoLinkProvider>
			<Harness />
		</KumoLinkProvider>
	</QueryClientProvider>,
);
