import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	canvasGadgetDetailQueryOptions,
} from "@/lib/os-query-options";
import type {
	OsWorkspace,
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { BoardAppLinks } from "./board-app-links";

it("renders configured resources for one fictional org and no app for another", () => {
	const workspaceId = "11111111-1111-4111-8111-111111111111";
	const creator = {
		organizationId: "org-supplier",
		createdByKind: "user" as const,
		createdById: "supplier-owner",
		createdAt: "2026-10-01T10:00:00Z",
	};
	const workspace: OsWorkspace = {
		...creator,
		id: workspaceId,
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
	const gadget: OsGadget = {
		...creator,
		id: "22222222-2222-4222-8222-222222222222",
		workspaceId,
		name: "Supplier replies",
		description: null,
		status: "active",
		currentRevisionId: "33333333-3333-4333-8333-333333333333",
		sourceBlueprintRevisionId: null,
		updatedAt: creator.createdAt,
	};
	const currentRevision: OsGadgetRevision = {
		...creator,
		id: gadget.currentRevisionId!,
		gadgetId: gadget.id,
		revision: 1,
		sourceArtifactRef: null,
		manifest: {
			capabilities: [],
			entry: "tedix:app/outbound-review",
			navigation: { board: true },
			config: { version: 1 },
		},
	};

	const render = (configured: boolean) => {
		const client = new QueryClient({
			defaultOptions: { queries: { staleTime: Infinity, retry: false } },
		});
		client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
			items: [workspace],
			truncated: false,
		});
		client.setQueryData(canvasGadgetsQueryOptions(workspaceId).queryKey, {
			items: configured ? [gadget] : [],
			truncated: false,
		});
		client.setQueryData(
			canvasGadgetDetailQueryOptions(workspaceId, gadget.id).queryKey,
			{ gadget, currentRevision },
		);
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<BoardAppLinks />
			</QueryClientProvider>,
		);
	};
	expect(render(true)).toContain("Supplier replies");
	expect(render(true)).toContain(`workpiece=gadget:${gadget.id}`);
	expect(render(false)).not.toContain("Supplier replies");
});
