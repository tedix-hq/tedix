import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import { OutputContentView } from "../src/components/output-content";
import { SlidesEditor } from "../src/components/output-editor-slides";
import { initial } from "./slides-gadget-content";
import "../src/styles.css";
import "../src/components/output-editor.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.mode = theme;
document.documentElement.dataset.theme = "tedix";

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
