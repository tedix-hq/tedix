import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CardFaceContext } from "../src/components/deck-presentation-context";
import { WorkDecisionCard } from "../src/components/work-decision-card";
import "../src/styles.css";

/**
 * A Codex question as it reaches a person: identifiers, a raw URL, backticks
 * and an agent-to-agent note in the source; a written face on top. `?stale`
 * makes the first save fail the way a newer Work comment does.
 */
const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.has("dark"));
const now = new Date();
const due = new Date(now.getTime() - 3 * 86_400_000).toISOString();
const source = [
	"Work cbf08453 needs the signed pilot terms before share 57e61f8a can open.",
	'Run `shares.update` with guestSkillReadSlots ["research"] once you confirm (trace 894b5978-1c2d-4e5f-8a9b-0c1d2e3f4a5b, E151103).',
	"Proposal: https://example.os.tedix.dev/work/items/cbf08453-0000-4000-8000-000000000001",
	"Captured 2026-11-04T02:15:00.000Z by pat@Pats-Laptop.local.",
	"Then dispatch this Work to a lane admitted for the Willowbrook org.",
].join("\n\n");
const presentation = {
	version: 2 as const,
	title: "Give the research team read access to the pilot share?",
	context: "Willowbrook's pilot is waiting on this before Friday's review.",
	body: "Codex opens the research folder to the Willowbrook guests; nothing else changes.",
	recommendation:
		"Hold both — the signed terms and post-pilot outcome still need evidence",
	actionLabels: { approve: "Give access", reject: "Keep closed" },
};
let attempts = 0;
const saved: unknown[] = [];
(window as unknown as { saved: unknown[] }).saved = saved;
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={new QueryClient()}>
		<main data-slot="page" className="mx-auto max-w-3xl p-4 sm:p-6">
			<CardFaceContext.Provider
				value={
					query.has("noface")
						? null
						: {
								confidence: 0.7,
								presentation,
								dates: [due],
								now,
								lastRelatedDecision: {
									subject:
										"tedix · codex waiting: I've scoped the calculator to the pricing page and need",
									body: "Answered: keep it on the pricing page.",
									decidedAt: "2026-11-01T12:00:00.000Z",
								},
							}
				}
			>
				<div className="feed-deck fd-deck">
					<WorkDecisionCard
						kind={query.has("proposal") ? "proposal" : "question"}
						title={source.split("\n")[0]!}
						askedBy="Codex session"
						actor={{
							type: "external_agent",
							id: "7e2202f0-ce78-46de-8a49-4505bd534d83",
						}}
						source={{
							channel: "Decision capture",
							capturedAt: "2026-11-04T02:15:00.000Z",
							evidenceUrl:
								"/work/interactions/62abd3d8-0000-4000-8000-000000000001",
						}}
						at="2026-11-04T02:15:00.000Z"
						body={source}
						revisionTarget={{
							requestId: "62abd3d8-0000-4000-8000-000000000001",
							version: 2,
						}}
						actions={[
							{ id: "answer", label: "Answer", intent: "approve" },
							{ id: "not-needed", label: "No / Not needed", intent: "reject" },
						]}
						onDecision={async (feedback) => {
							attempts++;
							if (query.has("stale") && !feedback.reviewedChangesThrough)
								throw Object.assign(
									new Error(
										"The linked Work has a newer comment: Codex heartbeat https://x.example/a sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0 Work 47464594-e486-401b-97ba-5d286a6a41b1 trace 894b5978",
									),
									{
										code: "CONFLICT",
										data: {
											reason: "newer_comment",
											reviewedChangesThrough: "2026-11-04T09:20:00.000Z",
											note: "Codex: I re-ran the `pricing` checks on Work 47464594-e486-401b-97ba-5d286a6a41b1; all green. See https://ci.example/runs/123",
										},
									},
								);
							saved.push({ attempts, ...feedback });
							document.documentElement.dataset.saved = String(attempts);
						}}
					/>
				</div>
			</CardFaceContext.Provider>
		</main>
	</QueryClientProvider>,
);
