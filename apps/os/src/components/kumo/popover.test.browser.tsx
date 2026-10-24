import { KumoPortalProvider } from "@cloudflare/kumo/utils";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	Popover,
	PopoverContent,
	PopoverTitle,
	PopoverTrigger,
} from "./popover";
import "../../styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
	"dark",
	params.get("theme") === "dark",
);

function Fixture() {
	const [provider, setProvider] = useState<HTMLDivElement | null>(null);
	const [explicit, setExplicit] = useState<HTMLDivElement | null>(null);
	const initialFocus = useRef<HTMLInputElement>(null);
	const finalFocus = useRef<HTMLButtonElement>(null);
	const target = params.get("target");
	const focus = params.get("focus");
	return (
		<main style={{ minHeight: "200vh", padding: 24 }}>
			<div id="style-reference" className="shadow-tedix-floating" hidden />
			<div id="provider-portal" ref={setProvider} />
			<div id="explicit-portal" ref={setExplicit} />
			<button ref={finalFocus}>After popup</button>
			<KumoPortalProvider container={provider}>
				<Popover>
					<PopoverTrigger
						openOnHover={params.has("hover")}
						style={{ position: "fixed", right: 8, bottom: 8 }}
					>
						Open popup
					</PopoverTrigger>
					<PopoverContent
						container={
							target === "explicit"
								? explicit
								: target === "body"
									? document.body
									: undefined
						}
						initialFocus={
							focus === "custom"
								? initialFocus
								: focus === "none"
									? false
									: undefined
						}
						finalFocus={
							focus === "custom"
								? finalFocus
								: focus === "none"
									? false
									: undefined
						}
						align="end"
						className="w-[40rem] gap-2"
					>
						<PopoverTitle>Adapter popup</PopoverTitle>
						<input aria-label="First field" />
						<input aria-label="Chosen field" ref={initialFocus} />
						<div style={{ minHeight: 1200 }}>Scrollable popup content</div>
					</PopoverContent>
				</Popover>
			</KumoPortalProvider>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
