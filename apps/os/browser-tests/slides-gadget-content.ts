import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";

export const initial = OsOutputContentSchema.parse({
	kind: "presentation",
	slides: [
		{
			title: "Design for what comes next",
			bullets: ["A conference deck typography proof"],
			notes: "Open with the title, then pause before the premise.",
		},
		{
			title: "Wins",
			bullets: [
				"Three new accounts signed",
				"Onboarding time cut to four days",
				"Support backlog cleared",
			],
		},
		{
			title: "Next 30 days",
			bullets: [
				"Launch the partner programme",
				"Hire two account managers",
				"Ship the reporting refresh",
			],
		},
	],
	deck: {
		activeSlideId: "cover",
		theme: {
			headingFont: "Space Grotesk, sans-serif",
			bodyFont: "DM Sans, sans-serif",
		},
		slides: [
			{
				id: "cover",
				name: "Cover",
				layout: "blank",
				background: "linear-gradient(135deg, #111827 0%, #172554 100%)",
				elements: [
					{
						id: "eyebrow",
						type: "label",
						x: 80,
						y: 64,
						width: 390,
						height: 44,
						text: "TEDIX / CONFERENCE 2026",
						style: {
							fontFamily: "DM Mono, monospace",
							fontSize: 16,
							fontWeight: "medium",
							letterSpacing: 1.4,
							color: "#fde68a",
						},
					},
					{
						id: "title",
						type: "title",
						x: 80,
						y: 140,
						width: 1040,
						height: 330,
						text: "Design for\nwhat comes next",
						style: {
							fontSize: 86,
							fontWeight: "light",
							lineHeight: 0.95,
							letterSpacing: -3,
							color: "#f8fafc",
							padding: 36,
							verticalAlign: "middle",
							borderColor: "#38bdf8",
							borderWidth: 1,
						},
					},
					{
						id: "rule",
						type: "divider",
						x: 80,
						y: 520,
						width: 180,
						height: 4,
						style: { background: "#f59e0b" },
					},
					{
						id: "footer",
						type: "text",
						x: 80,
						y: 558,
						width: 1040,
						height: 42,
						text: "A conference deck typography proof",
						style: {
							fontSize: 20,
							color: "#cbd5e1",
						},
					},
				],
			},
			...[
				["wins", "Wins"],
				["next", "Next 30 days"],
			].map(([id, title]) => ({
				id,
				name: title,
				layout: "title-content",
				background: "#ffffff",
				elements: [
					{
						id: `${id}-title`,
						type: "title",
						x: 80,
						y: 72,
						width: 1040,
						height: 100,
						text: title,
						style: { fontSize: 48, fontWeight: "semibold" },
					},
				],
			})),
		],
	},
});
