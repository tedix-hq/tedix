import { describe, expect, it } from "vite-plus/test";
import type { CardReviewConfig } from "@tedix/api-contract/schemas/os-card-review";
import {
	appKindLabel,
	appPurpose,
	cardReviewSummary,
	cardsWaitingLabel,
} from "./workspace-apps";

const INBOX_WS = "11111111-1111-4111-8111-111111111111";
const SOCIAL_WS = "22222222-2222-4222-8222-222222222222";

const columns = {
	source: "Source",
	why: "Why",
	useful: "Useful?",
	reason: "Reason",
	done: "Done?",
};

const config: CardReviewConfig = {
	version: 1,
	sources: [
		{
			label: "Inbox",
			workspaceId: INBOX_WS,
			cardSheetPrefix: "Inbox cards ",
			maxRuns: 3,
			columns,
			doIt: "approve",
		},
		{
			label: "Social",
			workspaceId: SOCIAL_WS,
			cardSheetPrefix: "Social cards ",
			maxRuns: 3,
			columns,
			doIt: "copy_and_open",
		},
	],
};

const sheet = (id: string, title: string) => ({
	id,
	title,
	kind: "sheet" as const,
	status: "active" as const,
	createdAt: "2026-10-16T08:00:00.000Z",
});

describe("appPurpose", () => {
	it("prefers the manifest's purpose, then the record, then the settings", () => {
		const manifest = {
			capabilities: [],
			entry: "tedix:app/card-review",
			description: "Decide on today's cards",
		};
		expect(appPurpose({ description: "Old" }, manifest, config)).toBe(
			"Decide on today's cards",
		);
		expect(
			appPurpose(
				{ description: "Old" },
				{ ...manifest, description: undefined },
				config,
			),
		).toBe("Old");
		expect(appPurpose({ description: null }, undefined, config)).toBe(
			"Decide on today's Inbox and Social cards",
		);
		expect(appPurpose({ description: null }, undefined, null)).toBeNull();
	});
});

describe("appKindLabel", () => {
	it("names the kind of app from its entry", () => {
		expect(
			appKindLabel({ capabilities: [], entry: "tedix:app/card-review" }),
		).toBe("Built-in app");
		expect(
			appKindLabel({
				capabilities: [],
				entry: "ui://widgets/mcp-app/x/index.html",
			}),
		).toBe("Interactive app");
		expect(appKindLabel({ capabilities: [], entry: "weekly-report" })).toBe(
			"Runs a skill",
		);
	});
});

describe("cardReviewSummary", () => {
	it("counts open cards across sources and picks the first in review order", () => {
		const summary = cardReviewSummary(
			config,
			[
				[sheet("in-1", "Inbox cards 2026-10-16")],
				[sheet("so-1", "Social cards 2026-10-16")],
			],
			new Map([
				[
					"in-1",
					{
						columns: ["Source", "Why", "Useful?", "Reason", "Done?"],
						rows: [
							["Pat Example · Invoice", "R1: overdue", "", "", ""],
							["Sam Example · Lunch", "R2: social", "yes", "", ""],
						],
					},
				],
				[
					"so-1",
					{
						columns: ["Source", "Why", "Useful?", "Reason", "Done?"],
						rows: [["https://example.com/post", "R4: reply", "", "", ""]],
					},
				],
			]),
		);
		expect(summary?.waiting).toBe(2);
		expect(summary?.next?.sourceText).toBe("Pat Example · Invoice");
	});

	it("waits until every card sheet has loaded", () => {
		expect(
			cardReviewSummary(
				config,
				[[sheet("in-1", "Inbox cards 1")], undefined],
				new Map(),
			),
		).toBeNull();
	});

	it("words the status line", () => {
		expect(cardsWaitingLabel(0)).toBe("No cards waiting");
		expect(cardsWaitingLabel(1)).toBe("1 card waiting");
		expect(cardsWaitingLabel(29)).toBe("29 cards waiting");
	});
});
