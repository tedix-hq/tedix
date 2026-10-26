import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WebPushSettings } from "../src/components/web-push-settings";
import { Page } from "../src/components/kumo/page";
import {
	activeWorkspacesQueryOptions,
	osQuery,
	projectListQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const client = new QueryClient({
	defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});
const disabled = new URLSearchParams(location.search).has("disabled");
const status = {
	enabled: !disabled,
	publicKey: disabled ? null : "B".repeat(87),
	preferences: {
		mutedProjectIds: [] as string[],
		mutedWorkspaceIds: [] as string[],
	},
};
client.setQueryData(
	osQuery.webPush.getStatus.queryOptions({ input: {} }).queryKey,
	status,
);
client.setQueryData(projectListQueryOptions(100).queryKey, {
	data: [
		{ id: "00000000-0000-4000-8000-000000000001", name: "Example Project" },
	],
} as never);
client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
	items: [
		{
			id: "00000000-0000-4000-8000-000000000002",
			name: "Example Workspace",
		},
	],
	truncated: false,
} as never);
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<Page width="md">
			<WebPushSettings />
		</Page>
	</QueryClientProvider>,
);
