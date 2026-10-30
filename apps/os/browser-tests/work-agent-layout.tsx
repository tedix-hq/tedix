import { createRoot } from "react-dom/client";
import { WorkAgentsBoard } from "../src/components/work-agents-page";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const now = new Date("2026-06-15T12:34:00.000Z");

createRoot(document.getElementById("root")!).render(
	<main className="grid min-w-0 gap-6 bg-kumo-base p-4 text-kumo-default">
		<WorkAgentsBoard
			now={now}
			data={{
				counts: {
					working: 1,
					idle: 0,
					needs_you: 0,
					done: 0,
					error: 0,
					ended: 0,
				},
				sessions: [
					{
						id: "00000001-0000-4000-8000-000000000001",
						harness: "codex",
						sessionKey: "layout-fixture",
						label: "Layout fixture",
						state: "working",
						effectiveState: "working",
						summary: "Check the spacing of the agent board",
						projectId: null,
						workItemId: null,
						stateSince: "2026-06-15T12:00:00.000Z",
						lastEventAt: "2026-06-15T12:33:00.000Z",
						telemetry: {
							executor: "codex",
							model: "fixture-model",
							provider: "fixture-provider",
							reasoningEffort: null,
							brief: "Inspect the agent board at phone and desktop widths.",
							startedAt: "2026-06-15T12:00:00.000Z",
							heartbeatAt: "2026-06-15T12:33:00.000Z",
							finishedAt: null,
							outcome: "succeeded",
							finalMessage: "Checked the board without changing any feedback.",
							tools: { inspect_layout: 2 },
							usage: { input: 1200, output: 300, cached: 200, reasoning: 100 },
							shas: [],
							workItems: [],
							corrections: [],
							source: "wrapper",
							estimatedCostUsd: 0.01,
							rateVersionId: null,
							lesson: "Separate the summary from the detailed result.",
							lessonStatus: "extracted",
						},
					},
				],
			}}
		/>
	</main>,
);
