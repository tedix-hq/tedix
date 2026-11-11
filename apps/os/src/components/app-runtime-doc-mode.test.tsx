import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRuntimeSandbox } from "./app-runtime-panel";
import {
	workspaceResourcesQueryOptions,
	workspaceOpenQueryOptions,
	outputDetailQueryOptions,
	canvasOutputsQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

const capabilities = vi.hoisted(() => ({
	onCall: null as null | ((method: unknown, args: unknown) => Promise<unknown>),
	export: vi.fn(async () => ({
		filename: "document.pdf",
		revision: 7,
		format: "pdf",
	})),
	replace: vi.fn(async () => ({ revision: { revision: 8 } })),
}));
vi.mock("@/lib/app-runtime-export", () => ({
	exportAppRuntimeOutput: capabilities.export,
}));
vi.mock("@/lib/app-runtime-output", () => ({
	replaceAppRuntimeOutput: capabilities.replace,
}));

vi.mock("@/components/app-runtime-frame", () => ({
	AppRuntimeFrame: ({
		html,
		onCall,
	}: {
		html: string;
		onCall: (method: unknown, args: unknown) => Promise<unknown>;
	}) => {
		capabilities.onCall = onCall;
		return <div data-gadget-client>{html}</div>;
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

describe("Doc gadget client selection", () => {
	it.each([3, 4])(
		"runs the v%s revision's own client file with no native editor link",
		async (version) => {
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
			client.setQueryData<unknown>(
				canvasOutputsQueryOptions(workspaceId).queryKey,
				{
					items: [{ id: outputId, workspaceId, currentRevisionId: "revision" }],
				},
			);
			client.setQueryData<unknown>(
				outputDetailQueryOptions(outputId).queryKey,
				{
					output: { id: outputId, workspaceId },
					currentRevision: {
						id: "revision",
						revision: 7,
						content: { kind: "document", blocks: [] },
					},
				},
			);
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
								revision={version}
								revisionId={`app-v${version}`}
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
										settings: {
											slot: "document",
											editor: `document-v${version}`,
										},
									},
									resourceGrants: [
										{
											slot: "document",
											operations: ["outputs.read", "outputs.write"],
										},
									],
								}}
								files={{
									"client.js": code,
									"server.js": "export class App {}",
								}}
							/>
						</QueryClientProvider>,
					),
				);
			render('document.body.dataset.customClient = "first";');
			expect(host.querySelector("[data-gadget-client]")?.textContent).toContain(
				'customClient = "first"',
			);
			render('document.body.dataset.customClient = "customized";');
			expect(host.querySelector("[data-gadget-client]")?.textContent).toContain(
				'customClient = "customized"',
			);
			expect(host.textContent).not.toContain("native editor");
			const content = { kind: "document", blocks: [] };
			const invalidate = vi
				.spyOn(client, "invalidateQueries")
				.mockResolvedValue();
			await act(async () => {
				expect(
					await capabilities.onCall!("outputs.replace", {
						slot: "document",
						content,
						expectedRevision: 7,
					}),
				).toMatchObject({ ok: true });
				expect(
					await capabilities.onCall!("app.exportOutput", {
						slot: "document",
						format: "pdf",
						expectedRevision: 7,
					}),
				).toMatchObject({ ok: true });
			});
			expect(capabilities.replace).toHaveBeenCalledWith({
				workspaceId,
				outputId,
				content,
				expectedRevision: 7,
			});
			expect(capabilities.export).toHaveBeenCalledWith({
				workspaceId,
				outputId,
				format: "pdf",
				expectedRevision: 7,
			});
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: osQueryKeys.outputs(),
			});
		},
	);
});
