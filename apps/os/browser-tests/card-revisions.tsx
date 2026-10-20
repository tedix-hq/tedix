import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DecisionContextRail } from "../src/components/decision-context-rail";
import { WorkDecisionCard } from "../src/components/work-decision-card";
import { osQuery } from "../src/lib/os-query-options";
import "../src/styles.css";

const requestId = "44444444-4444-4444-8444-444444444444";
const plan = new URLSearchParams(window.location.search).has("plan");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
function Example() {
	const query = useQuery(
		osQuery.workInteractions.get.queryOptions({ input: { requestId } }),
	);
	const request = query.data?.request;
	if (!request) return <p>Loading card…</p>;
	return (
		<main className="feed-deck mx-auto grid max-w-3xl gap-8 p-4 sm:p-6">
			<h1 className="type-tedix-page-title">
				{plan ? "Review a plan" : "Review a draft"}
			</h1>
			<WorkDecisionCard
				kind={plan ? "proposal" : "outbound"}
				title={plan ? "Prepare the report?" : "Send Morgan the use-case email?"}
				askedBy="Draft author"
				body={String(request.metadata.cardContent)}
				revisionTarget={{ requestId, version: request.version }}
				actions={
					plan
						? [
								{ id: "approve", label: "Approve plan", intent: "approve" },
								{ id: "reject", label: "Not this", intent: "reject" },
							]
						: [
								{ id: "send", label: "Send", intent: "approve" },
								{ id: "manual", label: "Approve, I'll send" },
								{ id: "reject", label: "Not this", intent: "reject" },
							]
				}
				onDecision={async () => {}}
			/>
			<WorkDecisionCard
				kind="question"
				title="Replace the Firecrawl key for the radar?"
				askedBy="Radar agent"
				body="Opens the existing connection settings so you can replace the key securely."
				onDecision={async () => {}}
			/>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<DecisionContextRail surface="deck">
			<Example />
		</DecisionContextRail>
	</QueryClientProvider>,
);
