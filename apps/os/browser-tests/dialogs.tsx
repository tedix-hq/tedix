import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { SupportGetHelp } from "../src/components/support-get-help";
import { installViewportMetrics } from "../src/lib/viewport-metrics";
import "../src/styles.css";

installViewportMetrics();
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={new QueryClient()}>
		<main style={{ height: "200vh" }}>
			<SupportGetHelp organization="Example team" />
		</main>
	</QueryClientProvider>,
);
