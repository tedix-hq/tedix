import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CanvasWorkspaceControls } from "../src/components/canvas-workspace-controls";
import { KumoLinkProvider } from "../src/components/kumo/link-provider";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import "../src/styles.css";

// `?fromBlueprint` renders a workspace made from version 1 of a blueprint,
// in the compact header the workspace page uses.
const fromBlueprint = new URLSearchParams(location.search).has("fromBlueprint");
const workspace: OsWorkspace = {
	id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	organizationId: "fictional-org",
	name: "Research",
	description: null,
	status: "active",
	sourceBlueprintId: fromBlueprint
		? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		: null,
	sourceBlueprintRevisionId: fromBlueprint
		? "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
		: null,
	sourceBlueprintRevisionNumber: fromBlueprint ? 1 : null,
	instantiationPreflight: null,
	rollbackReference: null,
	blueprintDecision: null,
	createdByKind: "user",
	createdById: "fictional-member",
	createdAt: "2030-01-01",
	updatedAt: "2030-01-01",
	visibility: "org",
	ownerUserId: null,
};
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider
		client={
			new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			})
		}
	>
		<KumoLinkProvider>
			<main className="p-4">
				<h1>Research</h1>
				<CanvasWorkspaceControls
					workspace={workspace}
					showCreate={false}
					compactActions={fromBlueprint}
					onSelected={() => {}}
					onArchived={() => {}}
				/>
			</main>
		</KumoLinkProvider>
	</QueryClientProvider>,
);
