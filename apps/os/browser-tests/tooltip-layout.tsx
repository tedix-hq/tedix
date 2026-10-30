import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../src/components/kumo/tooltip";
import { WORK_COUNT_DEFINITIONS } from "../src/lib/work-counts";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const longText =
	"This descriptive hint is deliberately longer than a short action label so the tooltip must wrap within a readable width instead of spanning the page.";
const longToken = `https://example.invalid/${"record-".repeat(60)}`;

function Fixture() {
	const [count, setCount] = useState(0);
	return (
		<TooltipProvider>
			<main className="flex min-h-screen flex-col items-end gap-6 bg-kumo-base p-4 text-kumo-default">
				<Button
					aria-label="Long action"
					aria-describedby="existing-description"
					title={longText}
					onClick={() => setCount((value) => value + 1)}
				>
					Action
				</Button>
				<Button aria-label="Long icon" title={longToken} size="icon-sm">
					<svg aria-hidden width="16" height="16">
						<circle cx="8" cy="8" r="6" />
					</svg>
				</Button>
				<Button
					aria-label="Long link"
					render={<a href="#preview" />}
					title={longToken}
				>
					Preview
				</Button>
				<Button aria-label="Disabled action" title={longText} disabled>
					Unavailable
				</Button>
				<Tooltip>
					<TooltipTrigger render={<Button />}>Explicit tooltip</TooltipTrigger>
					<TooltipContent>{longToken}</TooltipContent>
				</Tooltip>
				<Button aria-label="Approvals" title={WORK_COUNT_DEFINITIONS.approvals}>
					Approvals
				</Button>
				<p id="existing-description">Existing action guidance.</p>
				<output aria-label="Action count">{count}</output>
			</main>
		</TooltipProvider>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
