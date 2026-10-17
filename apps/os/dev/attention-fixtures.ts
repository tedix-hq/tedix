import type { AttentionResult } from "@tedix/api-contract/schemas/work-attention";
import {
	DEFAULT_ATTENTION_LAYOUT,
	type AttentionLayout,
} from "@tedix/api-contract/schemas/attention-layout";

let layout = structuredClone(DEFAULT_ATTENTION_LAYOUT);
let revision = 0;
let previousVisitAt: string | null = null;
const boot = Date.now();
export function resetAttentionFixtures() {
	layout = structuredClone(DEFAULT_ATTENTION_LAYOUT);
	revision = 0;
	previousVisitAt = null;
}
export function getAttentionFixtureLayout() {
	return { layout, revision };
}
export function updateAttentionFixtureLayout(input: {
	layout: AttentionLayout;
	expectedRevision: number;
}) {
	if (input.expectedRevision !== revision)
		throw new Error("Layout changed elsewhere");
	layout = structuredClone(input.layout);
	revision++;
	return { layout, revision };
}
export function visitAttentionFixture() {
	const before = previousVisitAt;
	previousVisitAt = new Date().toISOString();
	return { previousVisitAt: before };
}
export function attentionFixture(workspaceId?: string): AttentionResult {
	const now = Date.now();
	const at = (minutes: number) =>
		new Date(now - minutes * 60_000).toISOString();
	const start = (minutes: number) =>
		new Date(boot - minutes * 60_000).toISOString();
	const phase = Math.floor((now - boot) / 12_000) % 3;
	const cards: AttentionResult["cards"] = [
		{
			id: "fixture-reply",
			who: "Mira",
			title: "Review the supplier shortlist",
			projectId: "project-supply",
			column: "waiting",
			startedAt: start(24),
			heartbeatAt: at(0.1),
			note: "Three suppliers are ready. Your choice unlocks the next step.",
			href: "/work/needs-you",
			source: "run",
			activitySource: "cloud_tedi",
			tediName: "Mira",
		},
		{
			id: "fixture-codex",
			who: "Codex",
			title: "Build the search review kit",
			projectId: "project-search",
			column: "moving",
			startedAt: start(14),
			heartbeatAt: at(0.05),
			note: [
				"Checking the review flow on a phone",
				"Search results now keep your filters",
				"Running the accessibility checks",
			][phase]!,
			href: "/work/portfolio",
			source: "session",
			activitySource: "local_codex",
		},
		{
			id: "fixture-claude",
			who: "Claude",
			title: "Write the installation guide",
			projectId: "project-search",
			column: "blocked",
			startedAt: start(48),
			heartbeatAt: start(6),
			note: "Draft saved. Last step: verify the setup commands.",
			href: "/work/portfolio",
			source: "session",
			activitySource: "local_claude",
		},
		{
			id: "fixture-factory",
			who: "Mira",
			title: "Check today's supplier records",
			projectId: "project-supply",
			column: "moving",
			startedAt: start(35),
			heartbeatAt: at(0.02),
			note: [
				"Matching delivery dates",
				"Checking the next supplier batch",
				"Saving the evidence for review",
			][phase]!,
			href: "/work/executions",
			source: "skill",
			activitySource: "factory",
			factoryName: "Supplier checks",
			tediName: "Mira",
			workspaceId: "workspace-supply",
		},
		{
			id: "fixture-schedule",
			who: "Aster",
			title: "Prepare the daily planning brief",
			projectId: "project-supply",
			column: "moving",
			startedAt: start(9),
			heartbeatAt: at(0.03),
			note: [
				"Reading today's open commitments",
				"Collecting the latest progress",
				"Updating the planning brief",
			][phase]!,
			href: "/work/executions",
			source: "skill",
			activitySource: "coordinator",
			factoryName: "Daily planning",
			tediName: "Aster",
		},
		{
			id: "fixture-done",
			who: "Aster",
			title: "Reconcile yesterday's deliveries",
			projectId: "project-supply",
			column: "done",
			startedAt: start(80),
			heartbeatAt: start(40),
			finishedAt: start(40),
			note: "All delivery records match. Evidence saved.",
			href: "/work/executions",
			source: "run",
			activitySource: "cloud_tedi",
			tediName: "Aster",
		},
		{
			id: "fixture-backlog",
			who: "",
			title: "Plan the next customer interviews",
			projectId: "project-outreach",
			column: "backlog",
			startedAt: start(100),
			heartbeatAt: null,
			note: "Ready for someone to pick up",
			href: "/work/projects",
			source: "backlog",
		},
	];
	return {
		cards: workspaceId
			? cards.filter(
					(c) =>
						c.workspaceId === workspaceId || c.projectId === "project-supply",
				)
			: cards,
		projects: [
			{
				id: "project-search",
				name: "Search",
				status: "active",
				active: 1,
				recent: 2,
				lastAttentionAt: at(0.05),
			},
			{
				id: "project-supply",
				name: "Supply",
				status: "active",
				active: 3,
				recent: 4,
				lastAttentionAt: at(0.02),
			},
			{
				id: "project-outreach",
				name: "Outreach",
				status: "active",
				active: 0,
				recent: 0,
				lastAttentionAt: at(3 * 1440),
			},
		],
		unfiled: [],
		truncated: false,
	};
}
