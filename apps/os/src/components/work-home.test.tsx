import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import type {
	OsWorkspace,
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { WorkHome } from "./work-home";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	canvasGadgetDetailQueryOptions,
} from "@/lib/os-query-options";

vi.mock("./workspace-app-renderer", () => ({
	WorkspaceAppRenderer: ({ manifest }: { manifest: { entry: string } }) => (
		<p data-rendered-app={manifest.entry}>Configured app</p>
	),
}));

it("opens the configured Deck first and never borrows a different viewer's apps", () => {
	const creator = {
		organizationId: "org-supplier",
		createdByKind: "user" as const,
		createdById: "supplier-owner",
		createdAt: "2026-10-01T10:00:00Z",
	};
	const workspace: OsWorkspace = {
		...creator,
		id: "11111111-1111-4111-8111-111111111111",
		name: "Supplier desk",
		description: null,
		status: "active",
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		rollbackReference: null,
		blueprintDecision: null,
		updatedAt: creator.createdAt,
		visibility: "org",
		ownerUserId: null,
	};
	const render = (configured: boolean, view?: "deck" | "feed") => {
		const client = new QueryClient({
			defaultOptions: { queries: { staleTime: Infinity, retry: false } },
		});
		client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
			items: configured ? [workspace] : [],
			truncated: false,
		});
		const gadgets: OsGadget[] = ["deck", "feed"].map((role, i) => ({
			...creator,
			id:
				i === 0
					? "22222222-2222-4222-8222-222222222222"
					: "33333333-3333-4333-8333-333333333333",
			workspaceId: workspace.id,
			name: role,
			description: null,
			status: "active",
			currentRevisionId: null,
			sourceBlueprintRevisionId: null,
			updatedAt: creator.createdAt,
		}));
		client.setQueryData(canvasGadgetsQueryOptions(workspace.id).queryKey, {
			items: gadgets,
			truncated: false,
		});
		for (const [i, role] of (["deck", "feed"] as const).entries()) {
			const gadget = gadgets[i]!;
			const currentRevision: OsGadgetRevision = {
				...creator,
				id: "44444444-4444-4444-8444-444444444444",
				gadgetId: gadget.id,
				revision: 1,
				sourceArtifactRef: null,
				manifest: {
					capabilities: [],
					entry: `fictional:${role}`,
					navigation: { work: role },
				},
			};
			client.setQueryData(
				canvasGadgetDetailQueryOptions(workspace.id, gadget.id).queryKey,
				{ gadget, currentRevision },
			);
		}
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkHome view={view} />
			</QueryClientProvider>,
		);
	};
	expect(render(true)).toContain('data-rendered-app="fictional:deck"');
	expect(render(true, "feed")).toContain('data-rendered-app="fictional:feed"');
	expect(render(false)).not.toContain("data-rendered-app");
});
