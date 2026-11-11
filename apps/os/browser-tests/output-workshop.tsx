import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import { Input } from "../src/components/kumo/input";
import {
	OutputWorkshopActions,
	OutputWorkshopCommandBar,
	OutputWorkshopIdentity,
	OutputWorkshopStatus,
} from "../src/components/output-workshop";
import "../src/styles.css";
import "../src/components/output-editor.css";
import "../src/components/output-detail.css";
import "../src/components/canvas-page.css";

const theme = new URLSearchParams(location.search).get("theme") ?? "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.mode = theme;
document.documentElement.dataset.theme = "tedix";

function Fixture() {
	const [action, setAction] = useState("");
	return (
		<main className="grid gap-8 bg-kumo-base p-4 text-kumo-default">
			{["standalone", "workspace"].map((surface) => (
				<section
					key={surface}
					aria-label={surface}
					className={surface === "standalone" ? "output-detail-workshop" : ""}
				>
					<OutputWorkshopCommandBar
						className={surface === "workspace" ? "canvas-document-header" : ""}
					>
						<OutputWorkshopIdentity
							className={
								surface === "workspace" ? "canvas-document-identity" : undefined
							}
						>
							{surface === "workspace" ? (
								<Input
									aria-label="Output title"
									className="canvas-document-title-input"
									defaultValue="PricePilot quarterly supplier review and renewal recommendations"
								/>
							) : (
								<h1>
									PricePilot quarterly supplier review and renewal
									recommendations
								</h1>
							)}
						</OutputWorkshopIdentity>
						<OutputWorkshopStatus
							className={
								surface === "workspace" ? "canvas-document-status" : undefined
							}
						>
							<span>Draft · Save changes</span>
						</OutputWorkshopStatus>
						<OutputWorkshopActions
							className={
								surface === "workspace" ? "canvas-document-actions" : undefined
							}
						>
							{(surface === "workspace"
								? ["Save version", "Export", "Share", "Resources", "Focus"]
								: ["Export", "Share"]
							).map((label) => (
								<Button key={label} size="sm" onClick={() => setAction(label)}>
									{label}
								</Button>
							))}
						</OutputWorkshopActions>
					</OutputWorkshopCommandBar>
				</section>
			))}
			<output aria-label="Last action">{action}</output>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
