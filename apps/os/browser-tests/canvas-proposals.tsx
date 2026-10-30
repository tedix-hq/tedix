import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CanvasProposals } from "../src/components/canvas-proposals";
import {
	collaborationProposalsQueryOptions,
	outputDetailQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const client = new QueryClient({
	defaultOptions: { queries: { staleTime: Infinity, enabled: false } },
});
client.setQueryData(
	collaborationProposalsQueryOptions({
		workspaceId,
		documentType: "output",
		documentId,
		limit: 20,
	}).queryKey,
	{
		items: [
			{
				id: "33333333-3333-4333-8333-333333333333",
				organizationId: "example",
				workspaceId,
				documentType: "output",
				documentId,
				baseRevisionId: "44444444-4444-4444-8444-444444444444",
				baseRevision: 1,
				status: "accepted",
				sourceKind: "user",
				sourceId: "example-user",
				content: { text: "A suggested update" },
				sequence: 1,
				createdByKind: "user",
				createdById: "example-user",
				createdAt: "2026-10-30T12:00:00Z",
				updatedAt: "2026-10-30T12:00:00Z",
				decisionRationale: "Ready for review",
				decisionEvidenceRefs: [],
				decidedByKind: "user",
				decidedById: "example-user",
				decidedAt: "2026-10-30T12:00:00Z",
				mergeRationale: null,
				mergeEvidenceRefs: [],
				mergedByKind: null,
				mergedById: null,
				mergedAt: null,
				resultRevisionId: null,
				resultRevision: null,
			},
		],
		truncated: false,
	},
);
client.setQueryData(outputDetailQueryOptions(documentId).queryKey, {
	currentRevision: null,
});
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="mx-auto max-w-3xl p-4">
			<CanvasProposals
				workspaceId={workspaceId}
				documentType="output"
				documentId={documentId}
				onMerged={() => {}}
			/>
		</main>
	</QueryClientProvider>,
);
