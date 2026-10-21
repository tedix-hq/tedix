import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import { OutputExportButtons } from "../src/components/output-export-buttons";
import "../src/styles.css";

const mode =
	new URLSearchParams(location.search).get("theme") === "dark"
		? "dark"
		: "light";
document.documentElement.classList.toggle("dark", mode === "dark");
document.documentElement.dataset.mode = mode;
document.documentElement.dataset.theme = "tedix";
const client = new QueryClient({
	defaultOptions: { mutations: { retry: false } },
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="mx-auto grid max-w-3xl gap-4 p-4 text-kumo-default">
			<h1 className="text-lg font-medium">Output export</h1>
			{[false, true].map((compact) => (
				<section
					key={String(compact)}
					data-variant={compact ? "compact" : "normal"}
					className="min-w-0 rounded-lg border border-kumo-line bg-kumo-base p-4"
				>
					<h2 className="mb-4 text-sm font-medium">
						{compact ? "Compact" : "Normal"}
					</h2>
					<div className="flex items-start gap-2">
						<OutputExportButtons
							outputId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
							kind="document"
							compact={compact}
						/>
						<Button size="sm" variant="secondary">
							Share
						</Button>
					</div>
				</section>
			))}
		</main>
	</QueryClientProvider>,
);
