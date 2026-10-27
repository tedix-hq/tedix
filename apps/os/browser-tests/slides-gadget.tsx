import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import { OutputContentView } from "../src/components/output-content";
import { SlidesEditor } from "../src/components/output-editor-slides";
import type { PresentationContent } from "../src/lib/output-models";
import "../src/styles.css";
import "../src/components/output-editor.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.mode = theme;
document.documentElement.dataset.theme = "tedix";

const initial: PresentationContent = {
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
							fontFamily: "Space Grotesk, sans-serif",
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
							fontFamily: "DM Sans, sans-serif",
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
};

/** The gadget's two states: the committed deck, and the editor over a draft. */
function Gadget() {
	const [mode, setMode] = useState<"view" | "edit">(
		params.get("mode") === "edit" ? "edit" : "view",
	);
	const [value, setValue] = useState(initial);
	return (
		<main
			className="bg-kumo-base text-kumo-default"
			style={{
				display: "grid",
				height: "100dvh",
				gridTemplateRows: "auto minmax(0, 1fr)",
			}}
			data-mode={mode}
		>
			<header
				className="flex items-center justify-between gap-2 border-kumo-line border-b"
				style={{ padding: "8px 16px", minHeight: 48 }}
			>
				<h1 className="m-0 font-medium text-sm">Weekly update</h1>
				{mode === "edit" ? (
					<Button size="sm" variant="secondary" onClick={() => setMode("view")}>
						Done
					</Button>
				) : null}
			</header>
			<div
				className={mode === "edit" ? "output-detail-workshop" : undefined}
				style={
					mode === "edit"
						? { display: "grid", minHeight: 0 }
						: { minHeight: 0, overflow: "auto", padding: 16 }
				}
				data-output-kind="presentation"
			>
				{mode === "edit" ? (
					<div
						className="output-workshop-stage"
						style={{ display: "grid", minHeight: 0 }}
					>
						<SlidesEditor value={value} onChange={setValue} />
					</div>
				) : (
					<OutputContentView content={value} onEdit={() => setMode("edit")} />
				)}
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Gadget />);
