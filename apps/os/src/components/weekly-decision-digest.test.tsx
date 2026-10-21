import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { osQuery } from "@/lib/os-query-options";
import { WeeklyDecisionDigest } from "./weekly-decision-digest";

const now = "2026-10-21T12:00:00.000Z";
const cutoff = "2026-10-14T12:00:00.000Z";

function approval(
	id: string,
	occurredAt: string,
	classId = "supplier-review",
): LearningInteractionEvent {
	return {
		id,
		organizationId: "fictional-harbor",
		actorType: "user",
		actorId: "river",
		tediId: null,
		clientEventId: id,
		signalClass: "quality",
		eventKind: "accepted",
		scopeKind: "personal",
		scopeId: "river",
		issueKey: null,
		surface: "decision_capture",
		targetType: "work_interaction",
		targetId: id,
		threadId: null,
		runId: null,
		metadata: {
			answerSource: "os-decision-card",
			decisionClass: classId,
			decisionChoice: "approve",
			feedbackSignal: "approve-as-is",
		},
		occurredAt,
		createdAt: now,
	};
}

function measured(id: string, occurredAt: string, elapsedMs: number) {
	return {
		...approval(id, occurredAt),
		surface: "decision_deck_action",
		metadata: {
			decisionChoice: "approve",
			firstViewedAt: Date.parse(occurredAt) - elapsedMs,
			elapsedMs,
			railOpenedBeforeDecision: false,
		},
	};
}

function digest(events: LearningInteractionEvent[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	client.setQueryData(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}).queryKey,
		{ events },
	);
	try {
		return new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<WeeklyDecisionDigest />
				</QueryClientProvider>,
			),
			"text/html",
		);
	} finally {
		client.clear();
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(now));
});
afterEach(() => vi.useRealTimers());

describe("WeeklyDecisionDigest", () => {
	it("counts and links only this week's approvals, excluding old-only classes", () => {
		const doc = digest([
			approval("old", "2026-10-01T12:00:00.000Z"),
			approval("recent", "2026-10-20T12:00:00.000Z"),
			approval("old-only", "2026-10-01T12:00:00.000Z", "archived-review"),
		]);
		expect(doc.body.textContent).toContain(
			"supplier review: 1 unchanged approvals",
		);
		expect(doc.body.textContent).not.toContain("archived review");
		expect(
			[...doc.querySelectorAll("a")].map((link) => link.getAttribute("href")),
		).toEqual(["/work/interactions/recent"]);
	});

	it("includes the cutoff and now, excluding older, future and invalid timestamps", () => {
		const doc = digest([
			approval("before", "2026-10-14T11:59:59.999Z"),
			approval("boundary", cutoff),
			approval("now", now),
			approval("future", "2026-10-21T12:00:00.001Z", "future-review"),
			approval("invalid", "invalid", "invalid-review"),
		]);
		expect(doc.body.textContent).toContain(
			"supplier review: 2 unchanged approvals",
		);
		expect(doc.body.textContent).not.toContain("future review");
		expect(doc.body.textContent).not.toContain("invalid review");
		expect(doc.querySelector("a")?.getAttribute("href")).toBe(
			"/work/interactions/now",
		);
	});

	it("selects the latest receipt by occurredAt regardless of input order", () => {
		const events = [
			approval("earlier", "2026-10-20T10:00:00.000Z"),
			approval("latest", "2026-10-20T13:00:00.000+02:00"),
			approval("middle", "2026-10-20T10:30:00.000Z"),
		];
		for (const rows of [events, [...events].reverse()]) {
			const doc = digest(rows);
			expect(doc.body.textContent).toContain("3 unchanged approvals");
			expect(doc.querySelector("a")?.getAttribute("href")).toBe(
				"/work/interactions/latest",
			);
		}
	});

	it("breaks receipt timestamp ties by event id", () => {
		const events = [approval("receipt-b", now), approval("receipt-a", now)];
		for (const rows of [events, [...events].reverse()]) {
			expect(digest(rows).querySelector("a")?.getAttribute("href")).toBe(
				"/work/interactions/receipt-a",
			);
		}
	});

	it("uses the same bounded week for measured decision time", () => {
		const doc = digest([
			measured("old", "2026-10-14T11:59:59.999Z", 90_000),
			measured("boundary", cutoff, 2_000),
			measured("now", now, 4_000),
			measured("future", "2026-10-21T12:00:00.001Z", 90_000),
		]);
		expect(doc.body.textContent).toContain(
			"Median decision time 3 s; 100% decided without opening details.",
		);
		expect(doc.querySelector("a")).toBeNull();
	});

	it("hides empty and old-only history without measured decisions", () => {
		for (const events of [
			[],
			[approval("old", "2026-10-01T12:00:00.000Z")],
			[measured("old", "2026-10-01T12:00:00.000Z", 2_000)],
		]) {
			expect(digest(events).body.textContent).toBe("");
		}
	});

	it("shows weekly class evidence without inventing measured decision times", () => {
		const doc = digest([approval("recent", now)]);
		expect(doc.body.textContent).toContain("1 unchanged approvals");
		expect(doc.body.textContent).not.toContain("Median decision time");
	});
});
