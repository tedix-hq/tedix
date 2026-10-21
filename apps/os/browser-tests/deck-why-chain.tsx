import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DecisionContextRail } from "../src/components/decision-context-rail";
import { WorkInteractionDecisionCard } from "../src/components/work-interaction-decision-card";
import {
	osQuery,
	workInteractionDetailQueryOptions,
} from "../src/lib/os-query-options";
import { GITHUB_CARD } from "../dev/decision-graph-fixture";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const client = new QueryClient({
	defaultOptions: {
		queries: { enabled: false, retry: false, staleTime: Infinity },
	},
});
client.setQueryDefaults(osQuery.decisionGraph.key(), { enabled: true });
client.setQueryData(
	workInteractionDetailQueryOptions(GITHUB_CARD.request.id).queryKey,
	{
		request: GITHUB_CARD.request,
		effectiveState: GITHUB_CARD.effectiveState,
		canRespond: true,
		canCancel: false,
		latestDraft: null,
		responses: { data: [], nextCursor: null, hasMore: false },
	},
);
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="feed-deck mx-auto max-w-6xl p-4 sm:p-6">
			<DecisionContextRail surface="deck">
				<WorkInteractionDecisionCard
					requestId={GITHUB_CARD.request.id}
					preview={GITHUB_CARD}
				/>
			</DecisionContextRail>
		</main>
	</QueryClientProvider>,
);
