import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceFileUpload } from "../src/components/workspace-file-upload";
import {
	activeOutputLibraryQueryOptions,
	canvasOutputsQueryOptions,
	workspaceResourcesQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false },
		mutations: { retry: false },
	},
});
// The proof intercepts the real read reconciliation: every confirmed upload
// refreshes three readers and `rejectReconciliation` fails that many calls.
const reconciliation = {
	attempts: 0,
	rejected: Number(params.get("rejectReconciliation") ?? "0"),
};
const invalidate = client.invalidateQueries.bind(client);
client.invalidateQueries = async (filters, options) => {
	reconciliation.attempts++;
	if (reconciliation.rejected > 0) {
		reconciliation.rejected--;
		throw new Error("Local reconciliation rejected");
	}
	return invalidate(filters, options);
};
(
	window as unknown as { __reconciliation: typeof reconciliation }
).__reconciliation = reconciliation;

function Fixture() {
	const [workspaceId, setWorkspaceId] = useState(
		params.get("workspace") ?? "11111111-1111-4111-8111-111111111111",
	);
	const [receipt, setReceipt] = useState<{
		outputId: string;
		name: string;
		url: string;
	} | null>(null);
	useEffect(() => {
		const listener = (event: Event) => {
			setWorkspaceId((event as CustomEvent<string>).detail);
			setReceipt(null);
		};
		window.addEventListener("upload-switch-workspace", listener);
		return () =>
			window.removeEventListener("upload-switch-workspace", listener);
	}, []);
	useQuery(workspaceResourcesQueryOptions(workspaceId));
	useQuery(canvasOutputsQueryOptions(workspaceId));
	useQuery(activeOutputLibraryQueryOptions());
	return (
		<main className="grid min-h-screen content-start gap-4 p-4">
			<WorkspaceFileUpload workspaceId={workspaceId} onUploaded={setReceipt} />
			{receipt ? (
				<p className="m-0 grid gap-1">
					<span>Uploaded {receipt.name}</span>
					<a href={receipt.url}>Open output</a>
				</p>
			) : null}
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<Fixture />
	</QueryClientProvider>,
);
