import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	ListIcon,
	Plus,
	SquaresFour,
	TrashSimple,
	X,
} from "@phosphor-icons/react";
import { Button } from "../src/components/kumo/button";
import { SegmentedControl } from "../src/components/kumo/segmented-control";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";

function Fixture() {
	const [layout, setLayout] = useState<"list" | "grid">("list");
	return (
		<main className="grid gap-6 bg-kumo-base p-4 text-kumo-default">
			<div data-fixture="header" className="flex flex-wrap items-center gap-2">
				<Button icon={<Plus size={14} />}>New document</Button>
				<SegmentedControl
					ariaLabel="Layout"
					iconOnly
					value={layout}
					onValueChange={setLayout}
					options={[
						{
							value: "list",
							label: "List view",
							icon: <ListIcon aria-hidden size={16} />,
						},
						{
							value: "grid",
							label: "Grid view",
							icon: <SquaresFour aria-hidden size={16} />,
						},
					]}
				/>
			</div>
			<div data-fixture="icons" className="flex flex-wrap items-center gap-2">
				{(["icon-xs", "icon-sm", "icon", "icon-lg"] as const).map((size) => (
					<Button
						key={size}
						aria-label={`Delete ${size}`}
						size={size}
						variant="outline"
					>
						<TrashSimple aria-hidden size={14} />
					</Button>
				))}
				<Button aria-label="Close" size="icon-sm" variant="ghost">
					<X aria-hidden size={14} />
				</Button>
			</div>
			<p className="m-0 type-tedix-body">
				Workspaces could not be loaded.{" "}
				<Button size="sm" variant="link">
					Try again
				</Button>
			</p>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
