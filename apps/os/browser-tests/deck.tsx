import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { OsGadgetManifestSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { WorkspaceAppRenderer } from "../src/components/workspace-app-renderer";
import {
	osQuery,
	pendingApprovalsQueryOptions,
	projectListQueryOptions,
	userProfileQueryOptions,
} from "../src/lib/os-query-options";
import { DECISION_DECK_EXAMPLES } from "../dev/decision-deck-fixture";
import "../src/styles.css";

const client = new QueryClient({
	defaultOptions: {
		queries: { enabled: false, staleTime: Infinity, retry: false },
	},
});
for (const state of ["open", "resolved"])
	client.setQueryData(
		osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: undefined,
				limit: 50,
				states: [state as "open" | "resolved"],
			},
		}).queryKey,
		{ data: [], hasMore: false },
	);
client.setQueryData(pendingApprovalsQueryOptions().queryKey, { data: [] });
client.setQueryData(projectListQueryOptions(100).queryKey, { data: [] });
client.setQueryData(userProfileQueryOptions().queryKey, { id: "" });
client.setQueryData(
	osQuery.learningFeedback.listInteractions.queryOptions({
		input: { scopeKind: "personal", limit: 200 },
	}).queryKey,
	{ events: [] },
);
const manifest = OsGadgetManifestSchema.parse({
	entry: "tedix:app/decision-deck",
	navigation: { work: "deck" },
	config: DecisionDeckConfigSchema.parse({
		version: 1,
		examples: DECISION_DECK_EXAMPLES,
	}),
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="p-4">
			<WorkspaceAppRenderer manifest={manifest} />
		</main>
	</QueryClientProvider>,
);
