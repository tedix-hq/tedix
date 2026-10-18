import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vite-plus/test";
import { activeWorkspacesQueryOptions } from "./os-query-options";
import { useVisibleCardSources } from "./use-visible-card-sources";

it("keeps a member's own factories and shared work while excluding another person's factories", () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
		items: ["luz-inbox", "luz-social", "shared-radar"].map((id) => ({
			id,
			organizationId: "fictional-org",
			name: id,
			description: null,
			status: "active" as const,
			sourceBlueprintId: null,
			sourceBlueprintRevisionId: null,
			sourceBlueprintRevisionNumber: null,
			instantiationPreflight: null,
			rollbackReference: null,
			blueprintDecision: null,
			createdByKind: "user" as const,
			createdById: "luz",
			createdAt: "2026-10-18T01:00:00Z",
			updatedAt: "2026-10-18T01:00:00Z",
			visibility:
				id === "shared-radar" ? ("org" as const) : ("private" as const),
			ownerUserId: id === "shared-radar" ? null : "luz",
		})),
		truncated: false,
	});
	const sources = [
		"owner-inbox",
		"owner-social",
		"luz-inbox",
		"luz-social",
		"shared-radar",
	].map((workspaceId) => ({ workspaceId }));
	function Preview() {
		const visible = useVisibleCardSources(
			sources,
			(source) => source.workspaceId,
		);
		return (
			<output>
				{visible.sources.map((source) => source.workspaceId).join(",")}
			</output>
		);
	}
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<Preview />
		</QueryClientProvider>,
	);
	expect(html).toContain("luz-inbox,luz-social,shared-radar");
	expect(html).not.toContain("owner-");
	client.clear();
});
