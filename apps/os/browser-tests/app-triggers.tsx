import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
	RegisteredAppSchedule,
	WorkspaceAppTriggers,
} from "../src/components/workspace-app-connections";
import { WorkspaceActivity } from "../src/components/workspace-activity";
import {
	canvasOutputsQueryOptions,
	workspacePresenceQueryOptions,
	tediNamesQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const workspaceId = "11111111-1111-4111-8111-111111111111";
const gadgetId = "22222222-2222-4222-8222-222222222222";
const surface = new URLSearchParams(location.search).get("surface");
client.setQueryData(canvasOutputsQueryOptions(workspaceId).queryKey, {
	items: [],
});
client.setQueryData(workspacePresenceQueryOptions(workspaceId).queryKey, {
	userId: "person",
});
client.setQueryData(tediNamesQueryOptions().queryKey, { data: [] });
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="mx-auto max-w-3xl p-6">
			{surface === "activity" ? (
				<WorkspaceActivity workspaceId={workspaceId} />
			) : surface === "chat" ? (
				<RegisteredAppSchedule
					workspaceId={workspaceId}
					gadgetId={gadgetId}
					triggerId="morning"
					name="Planner"
				/>
			) : (
				<WorkspaceAppTriggers workspaceId={workspaceId} gadgetId={gadgetId} />
			)}
		</main>
	</QueryClientProvider>,
);
