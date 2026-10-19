// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { PersonalAgentValue } from "./personal-agent-value";

const state = vi.hoisted(() => ({ data: [] as Record<string, unknown>[] }));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: state.data, isPending: false, isError: false }),
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: { personalAgentInbound: { value: { queryOptions: () => ({}) } } },
}));

describe("personal-agent summary", () => {
	it("keeps suppression unknown and shows the card denominator and observation window", () => {
		state.data = [
			{
				sourceAgentId: "cedar",
				sourceAgentName: "Cedar Scout",
				findings: 10,
				decisionFindings: 4,
				decisionCards: 4,
				fyiFindings: 6,
				decidedFromCard: 2,
				decidedFromCardPercent: 50,
				outcomes: 2,
				verifiedOutcomes: 1,
				corroboratedOutcomes: 0,
				emailsSent: 2,
				acknowledgedOutcomes: 1,
				agentReportedReminderRetirements: 1,
				windowStart: "2030-01-01T00:00:00.000Z",
				windowEnd: "2030-01-08T00:00:00.000Z",
			},
		];
		const html = renderToStaticMarkup(<PersonalAgentValue />);
		expect(html).toContain("Cedar Scout");
		expect(html).toContain("2 / 4 (50%)");
		expect(html).toContain("2030-01-01T00:00:00.000Z");
		expect(html).toContain("Reminders avoided: unknown");
		expect(html).toContain("Historical chat baseline: unavailable");
	});

	it("shows a zero denominator without inventing a percentage", () => {
		state.data = [
			{
				sourceAgentId: "cedar",
				sourceAgentName: "Cedar Scout",
				findings: 1,
				decisionFindings: 0,
				decisionCards: 0,
				fyiFindings: 1,
				decidedFromCard: 0,
				decidedFromCardPercent: null,
				outcomes: 0,
				verifiedOutcomes: 0,
				corroboratedOutcomes: 0,
				emailsSent: 0,
				acknowledgedOutcomes: 0,
				agentReportedReminderRetirements: 0,
				windowStart: "2030-01-01T00:00:00.000Z",
				windowEnd: "2030-01-08T00:00:00.000Z",
			},
		];
		expect(renderToStaticMarkup(<PersonalAgentValue />)).toContain(
			"0 / 0 (no decision cards)",
		);
	});
});
