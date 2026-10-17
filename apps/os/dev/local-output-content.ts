import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";

export const documentContent: OsOutputContent = {
	kind: "document",
	blocks: [
		{ type: "heading", level: 1, text: "Q3 Revenue Narrative" },
		{
			type: "paragraph",
			text: "Revenue held at 412,000 MXN for week 32, up 6% week over week. Subscription renewals carried the growth while walk-in volume stayed flat.",
		},
		{
			type: "list",
			ordered: false,
			items: [
				"Renewals: 212 active, 9 recovered from dunning",
				"Wholesale: 3 new cafés onboarded",
				"Churn watch: 4 accounts flagged, 2 saved",
			],
		},
		{
			type: "quote",
			text: "Hold the wholesale discount at 12% until the churn cohort stabilizes.",
		},
	],
};

export const sheetContent: OsOutputContent = {
	kind: "sheet",
	columns: ["Week", "Revenue (MXN)", "Orders", "Notes"],
	rows: [
		["W29", 371500, 502, "Baseline"],
		["W30", 384200, 517, "Promo weekend"],
		["W31", 388900, 509, null],
		["W32", 412000, 541, "Wholesale onboarding"],
	],
};

/** A factory's card sheet and rules, read by the Card review app fixture. */
export const cardsContent: OsOutputContent = {
	kind: "sheet",
	columns: [
		"#",
		"Type",
		"Source (link)",
		"Who",
		"Why (rule)",
		"Draft",
		"Useful?",
		"Reason",
		"Did it?",
	],
	rows: [
		[
			1,
			"reply",
			"https://www.linkedin.com/feed/update/example-1",
			"Ada Example, Head of Support at Example Coffee",
			"R2: asked when wholesale pricing changes; no reply after two days.",
			"Thanks, Ada. Wholesale pricing stays at 12% through Q3; I will share the Q4 plan next week.",
			"",
			"",
			"",
		],
		[
			2,
			"comment on a post",
			"https://x.com/example/status/1",
			"Bo Sample",
			"R4: posted about café loyalty programmes yesterday.",
			"Our renewals rose once loyalty points carried over between cafés.",
			"",
			"",
			"",
		],
		[
			3,
			"post idea",
			"https://example.com/news/roasting",
			"Public: roasting cost report, 9 Aug",
			"R5: fresh news tied to the wholesale discount decision.",
			"Bean prices rose 8% this month. Here is how we kept our wholesale price steady.",
			"",
			"",
			"",
		],
	],
};

export const rulesContent: OsOutputContent = {
	kind: "sheet",
	columns: ["Rule id", "Rule", "Source", "Date", "Status"],
	rows: [
		[
			"R2",
			"Reply card for an unanswered direct question.",
			"seed",
			"2026-08-01",
			"seed",
		],
		[
			"R4",
			"Comment card for a post at most 7 days old on a profile topic.",
			"seed",
			"2026-08-01",
			"seed",
		],
		[
			"R5",
			"Post idea tied to fresh public news, at most 2 per run.",
			"seed",
			"2026-08-01",
			"seed",
		],
		[
			"R11",
			"Skip post ideas on weekends.",
			"factory",
			"2026-08-11",
			"proposed",
		],
	],
};

export const deckContent: OsOutputContent = {
	kind: "presentation",
	slides: [
		{
			title: "Solstice Coffee — August Update",
			bullets: ["Revenue +6% WoW", "3 new wholesale cafés", "Churn saves: 2/4"],
			notes: "Open with the wholesale story; it explains the whole delta.",
		},
		{
			title: "Digital worker operations",
			bullets: [
				"Nova: ops coordination, 6 decisions/day",
				"Miles: revenue reporting on a weekly workflow",
				"Juno: support triage across 2 inboxes",
			],
		},
		{
			title: "Next 30 days",
			bullets: [
				"Automate dunning recovery",
				"Ship churn-watch to daily cadence",
			],
		},
	],
};
