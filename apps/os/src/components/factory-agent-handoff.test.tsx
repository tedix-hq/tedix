import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import { CardReviewSourceSchema } from "@tedix/api-contract/schemas/os-card-review";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { osQuery, userProfileQueryOptions } from "@/lib/os-query-options";
import { FactoryAgentHandoff } from "./factory-agent-handoff";

const source = (agentDecidableClasses: string[]) =>
	CardReviewSourceSchema.parse({
		label: "Forum",
		workspaceId: "11111111-1111-4111-8111-111111111111",
		cardSheetPrefix: "Forum cards ",
		columns: {
			type: "Type",
			source: "Thread",
			why: "Why",
			useful: "Useful?",
			reason: "Reason",
			done: "Done?",
		},
		doIt: "approve",
		scoring: { agentDecidableClasses },
	});

function verdict(
	i: number,
	decisionClass: string,
	decisionChoice: string,
	sharedReason?: string,
): LearningInteractionEvent {
	return {
		id: `verdict-${decisionClass}-${i}`,
		organizationId: "fictional-harbor",
		actorType: "user",
		actorId: "river",
		tediId: null,
		clientEventId: `client-${i}`,
		signalClass: "quality",
		eventKind: decisionChoice === "not_useful" ? "rejected" : "accepted",
		scopeKind: "personal",
		scopeId: "river",
		issueKey: null,
		surface: "decision_deck",
		targetType: "output",
		targetId: `sheet-${i}`,
		threadId: null,
		runId: null,
		metadata: {
			decisionClass,
			decisionChoice,
			rowIndex: i,
			...(sharedReason ? { sharedReason } : {}),
		},
		occurredAt: `2026-10-20T10:0${i}:00Z`,
		createdAt: "2026-10-20T10:00:00Z",
	};
}

function render(
	sources: ReturnType<typeof source>[],
	events: LearningInteractionEvent[],
) {
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: "river",
		email: "river@example.test",
		name: null,
		avatarUrl: null,
		revision: 1,
		updatedAt: null,
	});
	client.setQueryData(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: {
				scopeKind: "personal",
				limit: 200,
				surfaces: ["decision_deck", "decision_learning"],
			},
		}).queryKey,
		{ events },
	);
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<FactoryAgentHandoff sources={sources} />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

describe("FactoryAgentHandoff", () => {
	it("shows earned, eligible and reserved classes for the signed-in person", () => {
		const events = [
			...Array.from({ length: 5 }, (_, i) =>
				verdict(i, "factory:Forum:upvote", "do_it"),
			),
			verdict(1, "factory:Forum:follow", "not_useful", "agent_could_do"),
			verdict(2, "factory:Forum:follow", "not_useful", "agent_could_do"),
		];
		const doc = render([source(["upvote", "follow", "payment"])], events);
		const status = (value: string) =>
			doc.querySelector(`[data-factory-class-status="${value}"]`)
				?.textContent ?? "";
		expect(status("earned")).toContain("An agent may decide Forum upvote");
		expect(status("eligible")).toContain("Eligible to hand to an agent");
		expect(status("blocked")).toContain("Stays with you");
	});
	it("explains learning and reserved classes before any personal events", () => {
		const doc = render([source(["upvote", "payment"])], []);
		expect(
			doc.querySelector('[data-factory-class-status="candidate"]')?.textContent,
		).toContain("0 of 5 unchanged Do it verdicts");
		expect(
			doc.querySelector('[data-factory-class-status="blocked"]')?.textContent,
		).toContain("Stays with you");
	});
	it("renders nothing when no class is listed", () => {
		const doc = render(
			[source([])],
			[verdict(0, "factory:Forum:upvote", "do_it")],
		);
		expect(doc.querySelector("[data-factory-agent-handoff]")).toBeNull();
	});
});
