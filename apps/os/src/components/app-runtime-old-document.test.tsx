import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AppRuntimeSandbox } from "./app-runtime-panel";
import {
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
	workspaceOpenQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

const install = vi.hoisted(() => vi.fn());
vi.mock("@/components/office-editor-upgrade", () => ({
	officeEditorUpgrade: () => null,
	OfficeEditorUpgrade: (props: Record<string, string>) => {
		install(props);
		return null;
	},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
	vi.clearAllMocks();
});

const workspaceId = "11111111-1111-4111-8111-111111111111",
	gadgetId = "22222222-2222-4222-8222-222222222222",
	outputId = "33333333-3333-4333-8333-333333333333";

async function open(role: "build" | "use") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData<unknown>(
		workspaceResourcesQueryOptions(workspaceId).queryKey,
		{
			items: [
				{
					id: "resource",
					workspaceId,
					slot: "document",
					providerId: "tedix",
					resourceType: "output",
					providerResourceId: outputId,
					status: "active",
				},
			],
		},
	);
	client.setQueryData<unknown>(
		workspaceOpenQueryOptions(workspaceId, gadgetId).queryKey,
		{ role, isOwner: false },
	);
	client.setQueryData<unknown>(
		canvasOutputsQueryOptions(workspaceId).queryKey,
		{ items: [{ id: outputId, workspaceId, currentRevisionId: "revision" }] },
	);
	client.setQueryData<unknown>(outputDetailQueryOptions(outputId).queryKey, {
		output: { id: outputId, workspaceId },
		currentRevision: {
			id: "revision",
			revision: 7,
			content: { kind: "document", blocks: [] },
		},
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AppRuntimeSandbox
					workspaceId={workspaceId}
					gadget={{ id: gadgetId, name: "Doc" }}
					revision={1}
					revisionId="app-v1"
					manifest={{
						entry: "tedix:runtime/v1",
						capabilities: [],
						config: {
							version: 1,
							settings: { slot: "document", editor: "document-v2" },
						},
						resourceGrants: [
							{ slot: "document", operations: ["outputs.read"] },
						],
					}}
					files={{ "client.js": "", "server.js": "export class App {}" }}
				/>
			</QueryClientProvider>,
		),
	);
	return host;
}

it("replaces an app set to the removed document editor for someone who can build", async () => {
	const host = await open("build");
	expect(install).toHaveBeenCalledWith({
		workspaceId,
		outputId,
		gadgetId,
		kind: "document",
		revisionId: "app-v1",
	});
	expect(host.querySelector('[aria-label="Loading document"]')).not.toBeNull();
});

it("tells someone who cannot build that the document is waiting for its editor", async () => {
	const host = await open("use");
	expect(install).not.toHaveBeenCalled();
	expect(host.textContent).toContain("Document unavailable");
});
