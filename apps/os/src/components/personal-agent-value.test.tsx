// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setOsFormattingPreferences } from "@/lib/format";
import { PersonalAgentValue } from "./personal-agent-value";

const state = vi.hoisted(() => ({
	data: [] as Record<string, unknown>[],
	isPending: false,
	isError: false,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => state,
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: { personalAgentInbound: { value: { queryOptions: () => ({}) } } },
}));

describe("personal-agent summary", () => {
	afterEach(() => {
		state.data = [];
		state.isPending = false;
		state.isError = false;
		setOsFormattingPreferences({ locale: null, timezone: null });
	});
	it("uses skeletons while loading and an alert on failure", () => {
		state.isPending = true;
		const loading = renderToStaticMarkup(<PersonalAgentValue />);
		expect(loading).toContain('data-slot="skeleton"');
		expect(loading).not.toContain("No personal agents enrolled");
		state.isPending = false;
		state.isError = true;
		const error = renderToStaticMarkup(<PersonalAgentValue />);
		expect(error).toContain('role="alert"');
		expect(error).toContain("Contributions could not be loaded");
		expect(error).not.toContain("No personal agents enrolled");
	});
	it("uses a quiet empty state when no agents are enrolled", () => {
		const html = renderToStaticMarkup(<PersonalAgentValue />);
		expect(html).toContain('data-appearance="quiet"');
		expect(html).toContain("No personal agents enrolled");
	});
	it("keeps suppression unknown and shows the card denominator and observation window", () => {
		setOsFormattingPreferences({
			locale: "de-DE",
			timezone: "America/Los_Angeles",
		});

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
		expect(html).toContain("31. Dez. 2029, 16:00");
		expect(html).toContain("7. Jan. 2030, 16:00");
		expect(html).not.toContain("2030-01-01T00:00:00.000Z");
		expect(html).not.toContain("(UTC");
		expect(html).toContain('data-slot="setting-row"');
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
