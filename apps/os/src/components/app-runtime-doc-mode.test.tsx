import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRuntimeSandbox } from "./app-runtime-panel";
import {
	workspaceResourcesQueryOptions,
	workspaceOpenQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";

vi.mock("@/components/app-runtime-frame", () => ({
	AppRuntimeFrame: ({ html }: { html: string }) => (
		<div data-gadget-client>{html}</div>
	),
}));
vi.mock("@/components/doc-writing-editor", () => ({
	DocWritingEditor: () => <div data-native-doc-editor />,
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
});

describe("Doc gadget client selection", () => {
	it("runs the v3 revision's own client file and keeps native editing as an explicit separate link", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		const workspaceId = "11111111-1111-4111-8111-111111111111",
			gadgetId = "22222222-2222-4222-8222-222222222222",
			outputId = "33333333-3333-4333-8333-333333333333";
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
			{ role: "build", isOwner: true },
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
		const render = (code: string) =>
			act(() =>
				root.render(
					<QueryClientProvider client={client}>
						<AppRuntimeSandbox
							workspaceId={workspaceId}
							gadget={{ id: gadgetId, name: "Doc" }}
							revision={3}
							revisionId="app-v3"
							manifest={{
								entry: "tedix:runtime/v1",
								capabilities: [],
								operations: [
									{
										name: "readDocument",
										description: "Read the document.",
										input: {
											type: "object",
											properties: {},
											additionalProperties: false,
										},
										effect: "read",
										outputSlot: "document",
									},
								],
								config: {
									version: 1,
									settings: { slot: "document", editor: "document-v3" },
								},
								resourceGrants: [
									{
										slot: "document",
										operations: ["outputs.read", "outputs.write"],
									},
								],
							}}
							files={{ "client.js": code, "server.js": "export class App {}" }}
						/>
					</QueryClientProvider>,
				),
			);
		render('document.body.dataset.customClient = "first";');
		expect(host.querySelector("[data-gadget-client]")?.textContent).toContain(
			'customClient = "first"',
		);
		expect(host.querySelector("[data-native-doc-editor]")).toBeNull();
		render('document.body.dataset.customClient = "customized";');
		expect(host.querySelector("[data-gadget-client]")?.textContent).toContain(
			'customClient = "customized"',
		);
		const fallback = host.querySelector<HTMLAnchorElement>(
			'a[title*="native editor"]',
		);
		expect(fallback?.href).toContain("workpiece=output%3A");
		expect(fallback?.target).toBe("_blank");
	});
});
