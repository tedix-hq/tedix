import { createRoot } from "react-dom/client";
import { CardFaceContext } from "../src/components/deck-presentation-context";
import { WorkDecisionCard } from "../src/components/work-decision-card";
import {
	DecisionCardComponent,
	DecisionDetailsComponent,
} from "../../mcp-ui/src/json-render/components/DecisionPrimitives";
import { Button } from "../src/components/kumo/button";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.has("dark"));
const source =
	"Source invocation: create_work_item with actor_scope=user and expected_revision=3. This only saves a task for you to check the profile and send the draft manually. Nothing is sent.";
const presentation = {
	version: 2 as const,
	title: "Save a follow-up task for Jules?",
	context: "You met yesterday at a workshop; Jules works at Willow.",
	body: "Adds your reminder to check the profile and send it yourself; nothing is sent.",
	recommendation: "Recommend yes while the meeting is fresh.",
	actionLabels: { approve: "Save task", later: "Decide later" },
};
createRoot(document.getElementById("root")!).render(
	<main data-slot="page" className="mx-auto max-w-3xl p-4 sm:p-6">
		{query.has("mcp") ? (
			<DecisionCardComponent
				ask={presentation.title}
				context={presentation.context}
				ifYes={presentation.body}
				why={presentation.recommendation}
				confidence={null}
			>
				<DecisionDetailsComponent>
					<p>{source}</p>
				</DecisionDetailsComponent>
				<div className="flex gap-3">
					<Button>Save task</Button>
					<Button variant="ghost">Decide later</Button>
				</div>
			</DecisionCardComponent>
		) : (
			<CardFaceContext.Provider
				value={
					query.has("before")
						? null
						: {
								confidence: null,
								presentation,
							}
				}
			>
				<div className="feed-deck fd-deck">
					<WorkDecisionCard
						kind="proposal"
						title="Create the relationship.followup Work item?"
						askedBy="Fictional assistant"
						body={source}
						content={<p>{source}</p>}
						allowEdits={false}
						actions={[
							{
								id: "yes",
								label: "Yes",
								intent: "approve",
								primary: true,
								description: "Create the canonical task record.",
							},
							{ id: "later", label: "Later", intent: "later" },
						]}
						onDecision={async () => {}}
					/>
				</div>
			</CardFaceContext.Provider>
		)}
	</main>,
);
