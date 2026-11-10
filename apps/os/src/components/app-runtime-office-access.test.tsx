import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRuntimeSandbox } from "./app-runtime-panel";
import {
	DocWritingDraftProvider,
	useAppRuntimeDrafts,
} from "./doc-writing-drafts";
import type { AppRuntimeDraft } from "@/lib/app-runtime-host";
import {
	canvasOutputsQueryOptions,
	workspaceResourcesQueryOptions,
	workspaceOpenQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";

const lifecycle = vi.hoisted(() => ({
	mounts: 0,
	onCall: null as null | ((method: unknown, args: unknown) => Promise<unknown>),
}));
vi.mock("./app-runtime-frame", () => ({
	AppRuntimeFrame: ({
		onCall,
	}: {
		onCall: (method: unknown, args: unknown) => Promise<unknown>;
	}) => {
		lifecycle.onCall = onCall;
		useEffect(() => {
			lifecycle.mounts++;
		}, []);
		return <div data-office-frame />;
	},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	document.body.replaceChildren();
	lifecycle.mounts = 0;
	vi.restoreAllMocks();
});

function setup(read: string) {
	const workspaceId = "11111111-1111-4111-8111-111111111111",
		gadgetId = "22222222-2222-4222-8222-222222222222",
		outputId = "33333333-3333-4333-8333-333333333333";
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const resourcesKey = workspaceResourcesQueryOptions(workspaceId).queryKey;
	const openKey = workspaceOpenQueryOptions(workspaceId, gadgetId).queryKey;
	const outputKey = outputDetailQueryOptions(outputId).queryKey;
	const detail = {
		output: { id: outputId, workspaceId },
		currentRevision: {
			revision: 7,
			id: "revision",
			content: { kind: "document", blocks: [] },
		},
	};
	client.setQueryData<unknown>(resourcesKey, {
		items: [
			{
				id: "resource",
				workspaceId,
				slot: "file",
				status: "active",
				providerId: "tedix",
				resourceType: "output",
				providerResourceId: outputId,
			},
		],
	});
	client.setQueryData<unknown>(openKey, { role: "build", isOwner: true });
	client.setQueryData<unknown>(outputKey, detail);
	const listKey = canvasOutputsQueryOptions(workspaceId).queryKey;
	client.setQueryData<unknown>(listKey, {
		items: [{ id: outputId, workspaceId, currentRevisionId: "revision" }],
	});
	let drafts: Map<string, AppRuntimeDraft> | null = null;
	function Capture() {
		drafts = useAppRuntimeDrafts();
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<DocWritingDraftProvider scope="person:workspace">
					<Capture />
					<AppRuntimeSandbox
						workspaceId={workspaceId}
						gadget={{ id: gadgetId, name: "Office" }}
						revision={2}
						revisionId="app-revision"
						manifest={{
							entry: "tedix:runtime/v1",
							capabilities: [],
							config: { version: 1, settings: { slot: "file" } },
							resourceGrants: [
								{ slot: "file", operations: ["outputs.read", "outputs.write"] },
							],
							operations: [
								{
									name: read,
									outputSlot: "file",
									effect: "read",
									description: read,
									input: {
										type: "object",
										properties: {},
										additionalProperties: false,
									},
								},
							],
						}}
						files={{ "client.js": "document.body.textContent='Office'" }}
					/>
				</DocWritingDraftProvider>
			</QueryClientProvider>,
		),
	);
	const draftKey = `${workspaceId}:${gadgetId}:app-revision:${outputId}`;
	drafts!.set(draftKey, {
		revision: 7,
		content: { kind: "document", blocks: [] },
	});
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
	});
	return {
		client,
		host,
		listKey,
		outputId,
		workspaceId,
		outputKey,
		openKey,
		detail,
		drafts: drafts!,
		draftKey,
	};
}
async function settle(change: () => void) {
	await act(async () => {
		change();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe.each(["readDocument", "readSheet", "readPresentation"])(
	"%s source and role boundaries",
	(read) => {
		it("refreshes the bound file when the workspace list shows someone else's newer save", async () => {
			const view = setup(read);
			const invalidate = vi
				.spyOn(view.client, "invalidateQueries")
				.mockResolvedValue(undefined);
			await settle(() =>
				view.client.setQueryData<unknown>(view.listKey, {
					items: [
						{
							id: view.outputId,
							workspaceId: view.workspaceId,
							currentRevisionId: "newer",
						},
					],
				}),
			);
			expect(invalidate).toHaveBeenCalledWith({ queryKey: view.outputKey });
		});
		it("suspends a temporary source failure while retaining the scoped draft for an authorized retry", async () => {
			const view = setup(read);
			expect(view.host.querySelector("[data-office-frame]")).not.toBeNull();
			await settle(() =>
				view.client
					.getQueryCache()
					.find({ queryKey: view.outputKey })!
					.setState({
						status: "error",
						error: Object.assign(new Error("Unavailable"), { status: 503 }),
					}),
			);
			expect(view.host.querySelector("[data-office-frame]")).toBeNull();
			expect(view.drafts.has(view.draftKey)).toBe(true);
			await settle(() =>
				view.client.setQueryData<unknown>(view.outputKey, view.detail),
			);
			expect(view.host.querySelector("[data-office-frame]")).not.toBeNull();
			expect(view.drafts.has(view.draftKey)).toBe(true);
		});
		it("removes the visible client and its retained draft on source denial", async () => {
			const view = setup(read);
			await settle(() =>
				view.client
					.getQueryCache()
					.find({ queryKey: view.outputKey })!
					.setState({
						status: "error",
						error: Object.assign(new Error("Denied"), { code: "FORBIDDEN" }),
					}),
			);
			expect(view.host.querySelector("[data-office-frame]")).toBeNull();
			expect(view.drafts.has(view.draftKey)).toBe(false);
		});
		it("refuses retained draft restoration if a fresh read sees the file moved before cached metadata catches up", async () => {
			const view = setup(read);
			vi.spyOn(view.client, "fetchQuery").mockResolvedValue({
				...view.detail,
				output: {
					...view.detail.output,
					workspaceId: "44444444-4444-4444-8444-444444444444",
				},
			});
			await expect(
				lifecycle.onCall!("app.draft.read", {
					slot: "file",
					outputId: view.detail.output.id,
				}),
			).rejects.toThrow("moved to another workspace");
			expect(view.drafts.has(view.draftKey)).toBe(false);
		});
		it("rejects a source moved to another readable workspace without a revision change", async () => {
			const view = setup(read);
			await settle(() =>
				view.client.setQueryData<unknown>(view.outputKey, {
					...view.detail,
					output: {
						...view.detail.output,
						workspaceId: "44444444-4444-4444-8444-444444444444",
					},
				}),
			);
			expect(view.host.querySelector("[data-office-frame]")).toBeNull();
			expect(view.drafts.has(view.draftKey)).toBe(false);
		});
		it("remounts with the current read-only role instead of retaining an editable client", async () => {
			const view = setup(read);
			expect(lifecycle.mounts).toBe(1);
			await settle(() =>
				view.client.setQueryData<unknown>(view.openKey, {
					role: "use",
					isOwner: false,
				}),
			);
			expect(view.host.querySelector("[data-office-frame]")).not.toBeNull();
			expect(lifecycle.mounts).toBe(2);
			expect(view.drafts.has(view.draftKey)).toBe(false);
		});
	},
);
