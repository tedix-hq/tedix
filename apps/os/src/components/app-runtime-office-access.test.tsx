import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRuntimeSandbox } from "./app-runtime-panel";
import {
	AppRuntimeDraftProvider,
	useAppRuntimeDrafts,
} from "./app-runtime-draft-store";
import type { AppRuntimeDraft } from "@/lib/app-runtime-host";
import { publishOutputRevisionNotice } from "@/lib/output-revision-notices";
import {
	canvasOutputsQueryOptions,
	workspaceResourcesQueryOptions,
	workspaceOpenQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";

const lifecycle = vi.hoisted(() => ({
	mounts: 0,
	onCall: null as null | ((method: unknown, args: unknown) => Promise<unknown>),
	// What the frame would tell the app about its files' saved revisions.
	outputRevisions: [] as unknown[],
}));
vi.mock("./app-runtime-frame", () => ({
	AppRuntimeFrame: ({
		onCall,
		outputRevisions,
	}: {
		onCall: (method: unknown, args: unknown) => Promise<unknown>;
		outputRevisions: unknown[];
	}) => {
		lifecycle.onCall = onCall;
		lifecycle.outputRevisions = outputRevisions;
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
				<AppRuntimeDraftProvider scope="person:workspace">
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
				</AppRuntimeDraftProvider>
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
		gadgetId,
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
		it("tells the app of someone else's save from a pushed notice, without reading the file or polling", async () => {
			const view = setup(read);
			const noticed = (revisionId: string, revision: number) => [
				{ slot: "file", outputId: view.outputId, revisionId, revision },
			];
			expect(lifecycle.outputRevisions).toEqual(noticed("revision", 7));
			const fetched = vi.spyOn(view.client, "fetchQuery");
			const invalidate = vi.spyOn(view.client, "invalidateQueries");
			const pushed = "44444444-4444-4444-8444-444444444444";
			await settle(() =>
				publishOutputRevisionNotice({
					type: "revision",
					workspaceId: view.workspaceId,
					outputId: view.outputId,
					revisionId: pushed,
					revision: 8,
				}),
			);
			expect(lifecycle.outputRevisions).toEqual(noticed(pushed, 8));
			// The app fetches what changed itself; the host reads nothing.
			expect(fetched).not.toHaveBeenCalled();
			expect(invalidate).not.toHaveBeenCalled();
			// An older or repeated notice changes nothing; another workspace's
			// and another file's notices are not this app's.
			for (const notice of [
				{ workspaceId: view.workspaceId, outputId: view.outputId, revision: 6 },
				{ workspaceId: view.workspaceId, outputId: view.gadgetId, revision: 9 },
				{ workspaceId: view.gadgetId, outputId: view.outputId, revision: 9 },
			])
				await settle(() =>
					publishOutputRevisionNotice({
						type: "revision",
						revisionId: "55555555-5555-4555-8555-555555555555",
						...notice,
					}),
				);
			expect(lifecycle.outputRevisions).toEqual(noticed(pushed, 8));
			// Nothing re-checks the file list on a timer.
			for (const query of view.client.getQueryCache().getAll())
				for (const observer of query.observers)
					expect(observer.options.refetchInterval ?? false).toBe(false);
		});
		it("asks only which revision a file is at when a re-read list names one it has not heard of", async () => {
			const view = setup(read);
			const newer = "66666666-6666-4666-8666-666666666666";
			const requests: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				const url = String(input instanceof Request ? input.url : input);
				requests.push(url);
				return new Response(
					JSON.stringify({
						json: {
							output: {
								id: view.outputId,
								organizationId: "org",
								workspaceId: view.workspaceId,
								kind: "document",
								title: "File",
								status: "active",
								currentRevisionId: newer,
								createdByKind: "user",
								createdById: "user",
								createdAt: "2026-11-11T00:00:00.000Z",
								updatedAt: "2026-11-11T00:00:00.000Z",
							},
							revision: {
								id: newer,
								revision: 9,
								createdAt: "2026-11-11T00:00:00.000Z",
							},
							patch: null,
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			});
			// The live connection came back and the list was read again.
			await settle(() =>
				view.client.setQueryData<unknown>(view.listKey, {
					items: [
						{
							id: view.outputId,
							workspaceId: view.workspaceId,
							currentRevisionId: newer,
						},
					],
				}),
			);
			await vi.waitFor(() =>
				expect(lifecycle.outputRevisions).toEqual([
					{
						slot: "file",
						outputId: view.outputId,
						revisionId: newer,
						revision: 9,
					},
				]),
			);
			expect(requests).toHaveLength(1);
			expect(requests[0]).toContain("/osWorkspaces/outputs/changes");
			// The file's cached copy was not thrown away for a full re-read.
			expect(view.client.getQueryData(view.outputKey)).toBe(view.detail);
		});
		it("saves by patch through the host and does not read the open file again", async () => {
			const view = setup(read);
			const saved = "77777777-7777-4777-8777-777777777777";
			const bodies: unknown[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const request = input instanceof Request ? input : null;
				bodies.push(
					JSON.parse(String(request ? await request.text() : init?.body)),
				);
				return new Response(
					JSON.stringify({
						json: {
							output: {
								id: view.outputId,
								organizationId: "org",
								workspaceId: view.workspaceId,
								kind: "document",
								title: "File",
								status: "active",
								currentRevisionId: saved,
								createdByKind: "user",
								createdById: "user",
								createdAt: "2026-11-11T00:00:00.000Z",
								updatedAt: "2026-11-11T00:00:00.000Z",
							},
							revision: {
								id: saved,
								revision: 8,
								createdAt: "2026-11-11T00:00:00.000Z",
							},
							mergedWith: null,
							catchUp: null,
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			});
			const fetched = vi.spyOn(view.client, "fetchQuery");
			const patch = {
				kind: "document",
				ops: [{ op: "set", path: ["blocks"], value: [] }],
			};
			let answer: unknown;
			await settle(() => {
				void lifecycle.onCall!("outputs.patch", {
					slot: "file",
					baseRevision: 7,
					patch,
				}).then((value) => {
					answer = value;
				});
			});
			await vi.waitFor(() => expect(answer).toMatchObject({ ok: true }));
			expect(bodies).toEqual([
				{
					json: {
						outputId: view.outputId,
						expectedWorkspaceId: view.workspaceId,
						baseRevision: 7,
						patch,
						note: "Saved from workspace app",
					},
				},
			]);
			// The app is told its own revision, and the file is not fetched.
			await vi.waitFor(() =>
				expect(lifecycle.outputRevisions).toEqual([
					{
						slot: "file",
						outputId: view.outputId,
						revisionId: saved,
						revision: 8,
					},
				]),
			);
			expect(fetched).not.toHaveBeenCalled();
			expect(view.client.getQueryData(view.outputKey)).toBe(view.detail);
			expect(view.client.getQueryState(view.outputKey)?.isInvalidated).toBe(
				true,
			);
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
