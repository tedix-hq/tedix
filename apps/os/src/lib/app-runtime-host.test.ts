import { QueryClient } from "@tanstack/react-query";
import { osQueryKeys, outputDetailQueryOptions } from "./os-query-options";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	appRuntimeContextFromManifest,
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
	requestAppRuntimeExport,
	type AppRuntimeContext,
	type AppRuntimeHostDeps,
	type AppRuntimeDraft,
} from "./app-runtime-host";

import { APP_RUNTIME_EXPORT_RESULT_METHOD } from "./app-runtime-protocol";

const outputId = "aaaaaaaa-0000-4000-8000-000000000001";
const resource = {
	id: "bbbbbbbb-0000-4000-8000-000000000001",
	organizationId: "org_blueharbor",
	workspaceId: "cccccccc-0000-4000-8000-000000000001",
	slot: "opportunities",
	providerId: "tedix",
	connectionScope: "tenant",
	personalOwnerUserId: null,
	connectionInstanceId: null,
	providerAccess: null,
	requiredScopes: [],
	resourceType: "output",
	providerResourceId: outputId,
	name: "Opportunities",
	metadata: {},
	status: "active",
	availability: null,
	createdByKind: "user",
	createdById: "u-1",
	createdAt: "2026-10-25T00:00:00.000Z",
	updatedAt: "2026-10-25T00:00:00.000Z",
	removedAt: null,
} as unknown as OsWorkspaceResource;

const context = (role: AppRuntimeContext["role"]): AppRuntimeContext =>
	appRuntimeContextFromManifest(
		{
			entry: "tedix:runtime/v1",
			capabilities: [],
			resourceGrants: [{ slot: "opportunities", operations: ["outputs.read"] }],
			config: { version: 1, settings: { reviewer: "Maya" } },
		},
		{
			workspaceId: resource.workspaceId,
			gadget: { id: "g-1", name: "Opportunity cards", revision: 1 },
			role,
		},
	);

function deps(role: AppRuntimeContext["role"], reads: string[] = []) {
	return {
		context: context(role),
		resources: [resource],
		readOutput: async (id: string) => {
			reads.push(id);
			return { kind: "sheet" as const, columns: ["#"], rows: [[1]] };
		},
	};
}

describe("app runtime host", () => {
	it("reads a granted slot's current revision without the app server", async () => {
		const readOutputRevision = vi.fn(async (id: string) => ({
			output: { id },
			revision: { revision: 7 },
		}));
		const host = { ...deps("owner"), readOutputRevision };
		expect(
			await handleAppRuntimeCall(host, "outputs.readRevision", {
				slot: "opportunities",
			}),
		).toEqual({
			ok: true,
			value: { output: { id: outputId }, revision: { revision: 7 } },
		});
		expect(
			await handleAppRuntimeCall(host, "outputs.readRevision", {
				slot: "other",
			}),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(
			await handleAppRuntimeCall(deps("owner"), "outputs.readRevision", {
				slot: "opportunities",
			}),
		).toEqual({ ok: false, error: "host_unavailable" });
		expect(readOutputRevision).toHaveBeenCalledOnce();
	});
	it("saves bounded rich output bodies without opening the arbitrary app-call argument cap", async () => {
		const replaceOutput = vi.fn(async () => ({
			output: { id: outputId },
			revision: { revision: 4 },
		}));
		const onWrite = vi.fn();
		const host = { ...deps("owner"), replaceOutput, onWrite };
		host.context.grants = [
			{ slot: "opportunities", operations: ["outputs.read", "outputs.write"] },
		];
		const args = {
			slot: "opportunities",
			expectedRevision: 3,
			content: {
				kind: "document",
				blocks: Array.from({ length: 4 }, () => ({
					type: "paragraph",
					text: "a".repeat(18_000),
				})),
			},
		};
		expect(
			await handleAppRuntimeCall(host, "outputs.replace", args),
		).toMatchObject({ ok: true, value: { revision: { revision: 4 } } });
		expect(replaceOutput).toHaveBeenCalledWith({
			workspaceId: resource.workspaceId,
			outputId,
			content: args.content,
			expectedRevision: 3,
		});
		expect(onWrite).toHaveBeenCalledOnce();
		replaceOutput.mockClear();
		expect(
			await handleAppRuntimeCall(host, "outputs.replace", {
				...args,
				expectedRevision: 0,
			}),
		).toMatchObject({ ok: false, error: "bad_arguments" });
		// The limit counts UTF-8 bytes: each "é" is two.
		const sized = (letters: number) => ({
			...args,
			content: { kind: "sheet", columns: ["é".repeat(letters)], rows: [] },
		});
		expect(
			await handleAppRuntimeCall(host, "outputs.replace", sized(4_000_000)),
		).toEqual({ ok: false, error: "too_large" });
		const drafts = new Map<string, AppRuntimeDraft>();
		expect(
			await handleAppRuntimeCall({ ...host, drafts }, "app.draft.write", {
				slot: args.slot,
				outputId,
				revision: 3,
				content: sized(4_000_000).content,
			}),
		).toEqual({ ok: false, error: "too_large" });
		expect(drafts.size).toBe(0);
		expect(replaceOutput).not.toHaveBeenCalled();
		// A file the old 1 MB limit refused is passed on.
		expect(
			await handleAppRuntimeCall(host, "outputs.replace", sized(600_000)),
		).not.toMatchObject({ error: "too_large" });
		replaceOutput.mockRejectedValueOnce(
			Object.assign(new Error("This file is over the 8 MB limit."), {
				code: "BAD_REQUEST",
			}),
		);
		expect(await handleAppRuntimeCall(host, "outputs.replace", args)).toEqual({
			ok: false,
			error: "bad_arguments",
			detail: "This file is over the 8 MB limit.",
		});
		replaceOutput.mockClear();
		for (const denied of [
			{ ...host, context: context("use") },
			{ ...host, resources: [{ ...resource, workspaceId: "other" }] },
		])
			expect(
				await handleAppRuntimeCall(denied, "outputs.replace", args),
			).toMatchObject({ ok: false });
		expect(replaceOutput).not.toHaveBeenCalled();
	});

	it("explains a typed newer-revision conflict without exposing server details or retrying the draft", async () => {
		const failure = Object.assign(
			new Error("internal compare-and-swap details"),
			{
				code: "CONFLICT",
				data: { expectedRevision: 3, currentRevision: 4 },
			},
		);
		const replaceOutput = vi.fn().mockRejectedValue(failure);
		const onWrite = vi.fn();
		const host = { ...deps("owner"), replaceOutput, onWrite };
		host.context.grants = [
			{ slot: "opportunities", operations: ["outputs.write"] },
		];
		const args = {
			slot: "opportunities",
			expectedRevision: 3,
			content: { kind: "document", blocks: [] },
		};
		expect(await handleAppRuntimeCall(host, "outputs.replace", args)).toEqual({
			ok: false,
			error: "revision_conflict",
			detail:
				"A newer revision (4) has been saved. Your changes have not replaced it",
		});
		expect(replaceOutput).toHaveBeenCalledOnce();
		expect(onWrite).not.toHaveBeenCalled();
		for (const other of [
			Object.assign(new Error("File moved"), { code: "CONFLICT" }),
			Object.assign(new Error("Access denied"), { code: "FORBIDDEN" }),
			Object.assign(new Error("Unknown revision"), {
				code: "CONFLICT",
				data: { expectedRevision: 3, currentRevision: null },
			}),
		]) {
			replaceOutput.mockRejectedValueOnce(other);
			await expect(
				handleAppRuntimeCall(host, "outputs.replace", args),
			).rejects.toBe(other);
		}
	});

	it("exports only a granted output slot in this workspace at the loaded revision", async () => {
		const exportOutput = vi.fn(async () => ({
			filename: "rev-3.pptx",
			revision: 3,
			format: "pptx" as const,
		}));
		const host = { ...deps("owner"), exportOutput };
		const args = { slot: "opportunities", format: "pptx", expectedRevision: 3 };
		expect(
			await handleAppRuntimeCall(host, "app.exportOutput", args),
		).toMatchObject({ ok: true, value: { revision: 3 } });
		expect(exportOutput).toHaveBeenCalledWith({
			workspaceId: host.context.workspaceId,
			outputId,
			format: "pptx",
			expectedRevision: 3,
		});
		exportOutput.mockClear();
		for (const denied of [
			{ ...host, context: { ...host.context, grants: [] } },
			{ ...host, resources: [{ ...resource, workspaceId: "other" }] },
			{ ...host, resources: [{ ...resource, status: "removed" as const }] },
		])
			expect(
				await handleAppRuntimeCall(denied, "app.exportOutput", args),
			).toMatchObject({ ok: false });
		expect(exportOutput).not.toHaveBeenCalled();
		expect(
			await handleAppRuntimeCall(host, "app.exportOutput", {
				...args,
				expectedRevision: 0,
			}),
		).toMatchObject({ ok: false, error: "bad_arguments" });
		expect(
			await handleAppRuntimeCall(host, "app.exportOutput", {
				...args,
				format: "exe",
			}),
		).toMatchObject({ ok: false, error: "bad_arguments" });
	});

	it("forwards the PDF header only when requested and rejects a non-boolean", async () => {
		const exportOutput = vi.fn(async () => ({
			filename: "file.pdf",
			revision: 3,
			format: "pdf" as const,
		}));
		const host = { ...deps("owner"), exportOutput };
		for (const revisionHeader of [undefined, false, true]) {
			exportOutput.mockClear();
			const args = {
				slot: "opportunities",
				format: "pdf",
				expectedRevision: 3,
				revisionHeader,
			};
			expect(
				await handleAppRuntimeCall(host, "app.exportOutput", args),
			).toMatchObject({ ok: true });
			expect(exportOutput).toHaveBeenCalledWith({
				workspaceId: host.context.workspaceId,
				outputId,
				format: "pdf",
				expectedRevision: 3,
				...(revisionHeader ? { revisionHeader: true } : {}),
			});
		}
		expect(
			await handleAppRuntimeCall(host, "app.exportOutput", {
				slot: "opportunities",
				format: "pdf",
				expectedRevision: 3,
				revisionHeader: "true",
			}),
		).toMatchObject({ ok: false, error: "bad_arguments" });
	});
	it("reads a linked image only for a granted output slot in this workspace", async () => {
		const readOutputImage = vi.fn(async () => "data:image/png;base64,AA==");
		const host = { ...deps("owner"), readOutputImage };
		const args = {
			slot: "opportunities",
			url: "https://example.org/visual.png",
		};
		expect(await handleAppRuntimeCall(host, "outputs.image", args)).toEqual({
			ok: true,
			value: { dataUrl: "data:image/png;base64,AA==" },
		});
		expect(readOutputImage).toHaveBeenCalledWith({
			workspaceId: host.context.workspaceId,
			outputId,
			slot: "opportunities",
			url: args.url,
		});
		readOutputImage.mockClear();
		expect(
			await handleAppRuntimeCall(
				{ ...host, context: { ...host.context, grants: [] } },
				"outputs.image",
				args,
			),
		).toMatchObject({ ok: false, error: "not_permitted" });
		for (const resources of [
			[{ ...resource, workspaceId: "other" }],
			[{ ...resource, status: "removed" as const }],
		])
			expect(
				await handleAppRuntimeCall(
					{ ...host, resources },
					"outputs.image",
					args,
				),
			).toMatchObject({ ok: false, error: "slot_unbound" });
		for (const url of [
			"http://example.org/visual.png",
			"data:image/png;base64,AA==",
			`https://example.org/${"a".repeat(2_000)}`,
			7,
		])
			expect(
				await handleAppRuntimeCall(host, "outputs.image", { ...args, url }),
			).toMatchObject({ ok: false, error: "bad_arguments" });
		expect(
			await handleAppRuntimeCall(deps("owner"), "outputs.image", args),
		).toMatchObject({ ok: false, error: "host_unavailable" });
		expect(readOutputImage).not.toHaveBeenCalled();
	});

	it("reads an image stored with the file by its reference", async () => {
		const readOutputImage = vi.fn(async () => "data:image/png;base64,AA==");
		const host = { ...deps("owner"), readOutputImage };
		const url = `tedix-asset:${"a".repeat(64)}`;
		expect(
			await handleAppRuntimeCall(host, "outputs.image", {
				slot: "opportunities",
				url,
			}),
		).toEqual({ ok: true, value: { dataUrl: "data:image/png;base64,AA==" } });
		expect(readOutputImage).toHaveBeenCalledWith({
			workspaceId: host.context.workspaceId,
			outputId,
			slot: "opportunities",
			url,
		});
		for (const bad of ["tedix-asset:abc", `${url}/x`, `tedix-asset:${url}`])
			expect(
				await handleAppRuntimeCall(host, "outputs.image", {
					slot: "opportunities",
					url: bad,
				}),
			).toMatchObject({ ok: false, error: "bad_arguments" });
	});

	it("stores an image with the bound output for a role that may write it", async () => {
		const reference = `tedix-asset:${"b".repeat(64)}`;
		const uploadOutputImage = vi.fn(async () => reference);
		const writable = (role: AppRuntimeContext["role"]) => ({
			...deps(role),
			context: {
				...context(role),
				grants: [
					{
						slot: "opportunities",
						operations: ["outputs.read", "outputs.write"],
					},
				],
			},
		});
		const host = { ...writable("owner"), uploadOutputImage };
		const args = {
			slot: "opportunities",
			dataUrl: "data:image/png;base64,AA==",
		};
		expect(
			await handleAppRuntimeCall(host, "outputs.uploadImage", args),
		).toEqual({ ok: true, value: { reference } });
		expect(uploadOutputImage).toHaveBeenCalledWith({
			workspaceId: host.context.workspaceId,
			outputId,
			dataUrl: args.dataUrl,
		});
		uploadOutputImage.mockClear();
		expect(
			await handleAppRuntimeCall(
				{ ...writable("viewer"), uploadOutputImage },
				"outputs.uploadImage",
				args,
			),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(
			await handleAppRuntimeCall(
				{ ...host, resources: [{ ...resource, workspaceId: "other" }] },
				"outputs.uploadImage",
				args,
			),
		).toMatchObject({ ok: false, error: "slot_unbound" });
		for (const dataUrl of ["https://example.org/a.png", "data:text/html,x", 7])
			expect(
				await handleAppRuntimeCall(host, "outputs.uploadImage", {
					...args,
					dataUrl,
				}),
			).toMatchObject({ ok: false, error: "bad_arguments" });
		expect(
			await handleAppRuntimeCall(host, "outputs.uploadImage", {
				...args,
				dataUrl: `data:image/png;base64,${"A".repeat(7_400_000)}`,
			}),
		).toMatchObject({ ok: false, error: "too_large" });
		expect(
			await handleAppRuntimeCall(
				writable("owner"),
				"outputs.uploadImage",
				args,
			),
		).toMatchObject({ ok: false, error: "host_unavailable" });
		expect(
			await handleAppRuntimeCall(
				{ ...deps("owner"), uploadOutputImage },
				"outputs.uploadImage",
				args,
			),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(uploadOutputImage).not.toHaveBeenCalled();
		uploadOutputImage.mockRejectedValueOnce(
			Object.assign(new Error("An image is over the 5 MB limit."), {
				code: "BAD_REQUEST",
			}),
		);
		expect(
			await handleAppRuntimeCall(host, "outputs.uploadImage", args),
		).toEqual({
			ok: false,
			error: "bad_arguments",
			detail: "An image is over the 5 MB limit.",
		});
	});

	it("keeps drafts only in panel memory, scoped to workspace, gadget, app revision and output", async () => {
		const drafts = new Map<string, AppRuntimeDraft>();
		const base = deps("owner");
		const host: AppRuntimeHostDeps = {
			...base,
			drafts,
			appRevisionId: "app-r1",
			context: {
				...base.context,
				grants: [
					{
						slot: "opportunities",
						operations: ["outputs.read", "outputs.write"],
					},
				],
			},
		};
		const args = { slot: "opportunities", outputId };
		const content = {
			kind: "sheet" as const,
			columns: ["Draft"],
			rows: [["Unsaved"]],
		};
		expect(
			await handleAppRuntimeCall(host, "app.draft.write", {
				...args,
				revision: 2,
				content,
			}),
		).toEqual({ ok: true, value: null });
		expect(drafts.size).toBe(1);
		expect(await handleAppRuntimeCall(host, "app.draft.read", args)).toEqual({
			ok: true,
			value: { revision: 2, content },
		});
		for (const scoped of [
			{ ...host, appRevisionId: "app-r2" },
			{
				...host,
				context: {
					...host.context,
					gadget: { ...host.context.gadget, id: "another-gadget" },
				},
			},
		])
			expect(
				await handleAppRuntimeCall(scoped, "app.draft.read", args),
			).toEqual({ ok: true, value: null });
		expect(
			await handleAppRuntimeCall(
				{
					...host,
					context: { ...host.context, workspaceId: "another-workspace" },
				},
				"app.draft.read",
				args,
			),
		).toMatchObject({ ok: false, error: "slot_unbound" });
		expect(
			await handleAppRuntimeCall(host, "app.draft.read", {
				...args,
				outputId: "another-output",
			}),
		).toMatchObject({ ok: false, error: "slot_unbound" });
		await handleAppRuntimeCall(host, "app.draft.clear", args);
		expect(drafts.size).toBe(0);
	});

	it("authorizes a fresh source read before restoring a draft and clears it on access failure", async () => {
		const drafts = new Map<string, AppRuntimeDraft>();
		const base = deps("owner");
		const host: AppRuntimeHostDeps = {
			...base,
			drafts,
			appRevisionId: "app-r1",
			context: {
				...base.context,
				grants: [
					{
						slot: "opportunities",
						operations: ["outputs.read", "outputs.write"],
					},
				],
			},
			readOutput: vi.fn(base.readOutput),
		};
		const args = { slot: "opportunities", outputId };
		// With nothing kept there is nothing to restore, so the file is not read.
		expect(await handleAppRuntimeCall(host, "app.draft.read", args)).toEqual({
			ok: true,
			value: null,
		});
		expect(host.readOutput).not.toHaveBeenCalled();
		await handleAppRuntimeCall(host, "app.draft.write", {
			...args,
			revision: 1,
			content: { kind: "sheet", columns: ["Draft"], rows: [] },
		});
		await handleAppRuntimeCall(host, "app.draft.read", args);
		expect(host.readOutput).toHaveBeenCalledWith(outputId);
		host.readOutput = vi.fn().mockRejectedValue(new Error("Source denied"));
		await expect(
			handleAppRuntimeCall(host, "app.draft.read", args),
		).rejects.toThrow("Source denied");
		expect(drafts.size).toBe(0);
	});

	it("rejects readonly and ungranted drafts without invoking app code or persisting another body", async () => {
		const drafts = new Map<string, AppRuntimeDraft>();
		const callServer = vi.fn();
		const args = {
			slot: "opportunities",
			outputId,
			revision: 1,
			content: { kind: "sheet", columns: ["Draft"], rows: [] },
		};
		for (const role of ["viewer", "use", "owner"] as const)
			expect(
				await handleAppRuntimeCall(
					{ ...deps(role), drafts, callServer },
					"app.draft.write",
					args,
				),
			).toMatchObject({ ok: false, error: "not_permitted" });
		expect(drafts.size).toBe(0);
		expect(callServer).not.toHaveBeenCalled();
	});
	it("calculates a sheet locally without reading or writing a workspace output", async () => {
		const reads: string[] = [];
		const callServer = vi.fn();
		const result = await handleAppRuntimeCall(
			{ ...deps("use", reads), callServer },
			"sheet.evaluate",
			{ content: { kind: "sheet", columns: ["Value"], rows: [[3], [4]] } },
		);
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: "sheet",
				rows: [[3], [4]],
				workbook: { sheets: expect.any(Array) },
			},
		});
		expect(reads).toEqual([]);
		expect(callServer).not.toHaveBeenCalled();
		expect(
			await handleAppRuntimeCall(deps("viewer"), "sheet.evaluate", {
				content: { kind: "sheet", columns: [], rows: [] },
			}),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(
			await handleAppRuntimeCall(deps("use"), "sheet.evaluate", {
				content: { kind: "document", blocks: [] },
			}),
		).toMatchObject({ ok: false, error: "bad_arguments" });
	});

	it("exports text through the host without granting the sandbox navigation or HTML downloads", async () => {
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		const create = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValue("blob:export");
		const revoke = vi
			.spyOn(URL, "revokeObjectURL")
			.mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			expect(
				await handleAppRuntimeCall(deps("use"), "app.download", {
					filename: "../sheet.csv",
					mimeType: "text/csv;charset=utf-8",
					text: "Value\r\n42",
				}),
			).toEqual({ ok: true, value: { filename: ".._sheet.csv" } });
			expect(create).toHaveBeenCalledOnce();
			expect(click).toHaveBeenCalledOnce();
			expect(document.querySelector("a[download]")).toBeNull();
			await vi.runAllTimersAsync();
			expect(revoke).toHaveBeenCalledWith("blob:export");
			for (const [role, mimeType] of [
				["viewer", "text/plain"],
				["use", "text/html"],
			] as const) {
				expect(
					await handleAppRuntimeCall(deps(role), "app.download", {
						filename: "test",
						mimeType,
						text: "test",
					}),
				).toMatchObject({ ok: false });
			}
			expect(click).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});
	it("downloads only a matching export reply from the running app", async () => {
		const iframe = document.createElement("iframe");
		document.body.append(iframe);
		const proxy = iframe.contentWindow!;
		const post = vi.spyOn(proxy, "postMessage").mockImplementation(() => {});
		const create = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValue("blob:export");
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		const format = {
			name: "CSV",
			mimeType: "text/csv",
			handler: "report",
		} as const;
		const controller = new AbortController();
		vi.useFakeTimers();

		function reply(
			id: string,
			text: string,
			source: Window = proxy,
			origin = window.location.origin,
		) {
			window.dispatchEvent(
				new MessageEvent("message", {
					source,
					origin,
					data: {
						jsonrpc: "2.0",
						method: APP_RUNTIME_EXPORT_RESULT_METHOD,
						params: { id, text },
					},
				}),
			);
		}

		try {
			const pending = requestAppRuntimeExport(
				proxy,
				format,
				"My app",
				controller.signal,
			);
			const { id, handler } = post.mock.calls[0]![0].params;
			expect(handler).toBe("report");
			reply(id, "wrong frame", window);
			reply(id, "wrong origin", proxy, "https://different.example");
			reply("stale", "wrong request");
			expect(click).not.toHaveBeenCalled();
			reply(id, "value\n42");
			await expect(pending).resolves.toBeUndefined();
			expect(create.mock.calls[0]?.[0]).toMatchObject({
				type: "text/csv;charset=utf-8",
			});
			expect(click.mock.contexts[0]).toMatchObject({ download: "My app.csv" });

			const oversized = requestAppRuntimeExport(
				proxy,
				format,
				"My app",
				controller.signal,
			);
			reply(post.mock.calls[1]![0].params.id, "é".repeat(4_000_001));
			await expect(oversized).rejects.toThrow("supported file");

			const cancelled = requestAppRuntimeExport(
				proxy,
				format,
				"My app",
				controller.signal,
			);
			controller.abort();
			reply(post.mock.calls[2]![0].params.id, "too late");
			await expect(cancelled).rejects.toThrow("finish the export");
			expect(click).toHaveBeenCalledOnce();
			await vi.runAllTimersAsync();
		} finally {
			iframe.remove();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it("asks the workspace agent only for a signed-in person, from a declared app, on a click", async () => {
		const activation = { isActive: true };
		vi.stubGlobal("window", { navigator: { userActivation: activation } });
		try {
			const askAgent = vi.fn(async () => "turn-1");
			const agentStatus = vi.fn(() => ({
				status: "done" as const,
				text: "Three rows.",
			}));
			const declared = (role: AppRuntimeContext["role"]) => ({
				...deps(role),
				context: { ...context(role), capabilities: ["agent.ask"] },
				askAgent,
				agentStatus,
			});
			const ask = { text: " Summarise these rows ", conversation: "current" };
			expect(
				await handleAppRuntimeCall(declared("use"), "agent.ask", ask),
			).toEqual({ ok: true, value: { turnId: "turn-1" } });
			expect(askAgent).toHaveBeenCalledExactlyOnceWith({
				text: "Summarise these rows",
				conversation: "current",
			});
			expect(
				await handleAppRuntimeCall(declared("use"), "agent.status", {
					turnId: "turn-1",
				}),
			).toEqual({ ok: true, value: { status: "done", text: "Three rows." } });
			// Not declared, a share-link visitor, or no click: nothing is sent.
			expect(
				await handleAppRuntimeCall(
					{ ...deps("use"), askAgent },
					"agent.ask",
					ask,
				),
			).toMatchObject({ ok: false, error: "not_permitted" });
			expect(
				await handleAppRuntimeCall(declared("edit"), "agent.ask", ask),
			).toMatchObject({ ok: false, error: "not_permitted" });
			activation.isActive = false;
			expect(
				await handleAppRuntimeCall(declared("owner"), "agent.ask", ask),
			).toMatchObject({ ok: false, detail: "user_activation_required" });
			expect(askAgent).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	describe("app.openLink", () => {
		const assign = vi.fn();
		const open = vi.fn();
		const activation = { isActive: true };
		const location = {
			hostname: "os.example.test",
			origin: "https://os.example.test",
			assign,
		};

		beforeEach(() => {
			assign.mockClear();
			open.mockClear();
			activation.isActive = true;
			vi.stubGlobal("window", {
				location,
				navigator: { userActivation: activation },
				open,
			});
		});
		afterEach(() => {
			location.hostname = "os.example.test";
			location.origin = "https://os.example.test";
			vi.unstubAllGlobals();
		});

		it("opens a same-origin share in the current tab for a guest", async () => {
			const url = "https://os.example.test/s/other?view=cards#next";
			const guest = { ...deps("use"), serverResolvesSlots: true };
			expect(
				await handleAppRuntimeCall(guest, "app.openLink", { url }),
			).toEqual({
				ok: true,
				value: null,
			});
			expect(assign).toHaveBeenCalledExactlyOnceWith(url);
			expect(open).not.toHaveBeenCalled();
		});

		it.each([
			"https://other.example.test/s/share",
			"https://os.example.test:8443/s/share",
			"https://os.example.test/settings",
			"https://os.example.test/s",
		])("opens %s in an isolated tab, including for viewers", async (url) => {
			expect(
				await handleAppRuntimeCall(deps("viewer"), "app.openLink", { url }),
			).toEqual({
				ok: true,
				value: null,
			});
			expect(open).toHaveBeenCalledExactlyOnceWith(
				url,
				"_blank",
				"noopener,noreferrer",
			);
			expect(assign).not.toHaveBeenCalled();
		});

		it("permits loopback HTTP when OS is running locally", async () => {
			const url = "http://127.0.0.1:3030/s/share";
			location.hostname = "127.0.0.1";
			location.origin = new URL(url).origin;
			expect(
				await handleAppRuntimeCall(deps("owner"), "app.openLink", { url }),
			).toMatchObject({ ok: true });
			expect(assign).toHaveBeenCalledExactlyOnceWith(url);
		});

		it.each([
			undefined,
			"/s/relative",
			"javascript:void(0)",
			"data:text/plain,example",
			"http://example.test/",
			"http://localhost:3030/s/share",
			"https://user@os.example.test/s/share",
			"https://:password@os.example.test/s/share",
			"https://example.test/" + "x".repeat(4096),
		])("rejects an invalid link before navigation", async (url) => {
			expect(
				await handleAppRuntimeCall(deps("use"), "app.openLink", { url }),
			).toEqual({
				ok: false,
				error: "bad_arguments",
			});
			expect(assign).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		});

		it("requires transient user activation for both destinations", async () => {
			activation.isActive = false;
			for (const url of [
				"https://os.example.test/s/share",
				"https://other.example.test/",
			]) {
				expect(
					await handleAppRuntimeCall(deps("use"), "app.openLink", { url }),
				).toMatchObject({
					ok: false,
					error: "not_permitted",
					detail: "user_activation_required",
				});
			}
			expect(assign).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		});
	});

	it("invalidates canonical output caches only after successful declared writes", async () => {
		const client = new QueryClient();
		const key: readonly unknown[] = outputDetailQueryOptions(outputId).queryKey;
		client.setQueryData(key, { test: "cached document" });
		const onWrite = vi.fn(() => {
			void client.invalidateQueries({ queryKey: osQueryKeys.outputs() });
		});
		const callServer = vi.fn(async () => ({ revision: 2 }));
		const host = {
			...deps("build"),
			callServer,
			onWrite,
			operations: [
				{
					name: "readDocument",
					description: "Read",
					input: { type: "object" as const },
					effect: "read" as const,
				},
				{
					name: "editDocument",
					description: "Edit",
					input: { type: "object" as const },
					effect: "write" as const,
				},
				{
					name: "deleteDocument",
					description: "Delete",
					input: { type: "object" as const },
					effect: "destructive" as const,
				},
			],
		};
		await handleAppRuntimeCall(host, "app.call", {
			method: "readDocument",
			args: [],
		});
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
		callServer.mockRejectedValueOnce(new Error("Conflict"));
		await expect(
			handleAppRuntimeCall(host, "app.call", {
				method: "editDocument",
				args: [],
			}),
		).rejects.toThrow("Conflict");
		expect(onWrite).not.toHaveBeenCalled();
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
		expect(
			await handleAppRuntimeCall(host, "app.call", {
				method: "editDocument",
				args: [],
			}),
		).toEqual({ ok: true, value: { revision: 2 } });
		expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		await handleAppRuntimeCall(host, "app.call", {
			method: "deleteDocument",
			args: [],
		});
		expect(onWrite).toHaveBeenCalledTimes(2);
		client.clear();
	});

	it("hands the app its context: settings and grants from the manifest, role from the host", async () => {
		const result = await handleAppRuntimeCall(deps("use"), "context", null);
		expect(result).toMatchObject({
			ok: true,
			value: {
				role: "use",
				settings: { reviewer: "Maya" },
				grants: [{ slot: "opportunities", operations: ["outputs.read"] }],
			},
		});
	});

	it("reads a granted slot through the bound Output and nothing else", async () => {
		const reads: string[] = [];
		expect(
			await handleAppRuntimeCall(deps("use", reads), "outputs.read", {
				slot: "opportunities",
			}),
		).toMatchObject({ ok: true, value: { kind: "sheet" } });
		expect(reads).toEqual([outputId]);
		expect(
			await handleAppRuntimeCall(deps("use"), "outputs.read", {
				slot: "other",
			}),
		).toEqual({ ok: false, error: "not_permitted", detail: "no_grant" });
		expect(
			await handleAppRuntimeCall(deps("viewer"), "outputs.read", {
				slot: "opportunities",
			}),
		).toEqual({ ok: false, error: "not_permitted", detail: "role" });
		expect(
			await handleAppRuntimeCall(deps("use"), "outputs.read", {}),
		).toMatchObject({ ok: false, error: "bad_arguments" });
	});

	it("reports an unbound slot and an absent server honestly", async () => {
		const unbound = { ...deps("build"), resources: [] };
		expect(
			await handleAppRuntimeCall(unbound, "outputs.read", {
				slot: "opportunities",
			}),
		).toEqual({ ok: false, error: "slot_unbound" });
		// A file connected after the rows were loaded, as when an app was just
		// approved to read it, is found by reading the rows again.
		const reads: string[] = [];
		const refreshResources = vi.fn(async () => [resource]);
		expect(
			await handleAppRuntimeCall(
				{ ...deps("build", reads), resources: [], refreshResources },
				"outputs.read",
				{ slot: "opportunities" },
			),
		).toMatchObject({ ok: true });
		expect(reads).toEqual([outputId]);
		expect(refreshResources).toHaveBeenCalledOnce();
		expect(
			await handleAppRuntimeCall(deps("use"), "app.call", {
				method: "ratings",
				args: [],
			}),
		).toMatchObject({ ok: false, error: "host_unavailable" });
		expect(await handleAppRuntimeCall(deps("use"), "fs.read", {})).toEqual({
			ok: false,
			error: "unknown_method",
		});
	});

	it.each(["owner", "build", "use", "viewer"] as const)(
		"applies the %s role before calling the server",
		async (role) => {
			const callServer = vi.fn(async () => ({ decision: "Hilfreich" }));
			const result = await handleAppRuntimeCall(
				{ ...deps(role), callServer },
				"app.call",
				{
					method: "rate",
					args: [{ cardId: "card-1", decision: "Hilfreich" }],
				},
			);
			if (role === "viewer") {
				expect(result).toEqual({
					ok: false,
					error: "not_permitted",
					detail: "role",
				});
				expect(callServer).not.toHaveBeenCalled();
			} else {
				expect(result).toEqual({ ok: true, value: { decision: "Hilfreich" } });
				expect(callServer).toHaveBeenCalledWith("rate", [
					{ cardId: "card-1", decision: "Hilfreich" },
				]);
			}
		},
	);

	it.each([
		null,
		{},
		{ method: "constructor" },
		{ method: "alarm" },
		{ method: "ratings", args: {} },
		{ method: "ratings", args: Array(51).fill(null) },
	])("refuses malformed server calls before dispatch: %j", async (args) => {
		const callServer = vi.fn();
		expect(
			await handleAppRuntimeCall(
				{ ...deps("use"), callServer },
				"app.call",
				args,
			),
		).toMatchObject({ ok: false, error: "bad_arguments" });
		expect(callServer).not.toHaveBeenCalled();
	});

	it.each(["</script", "</SCRIPT", "</ScRiPt"])(
		"escapes %s while keeping client.js after the bridge",
		(close) => {
			const html = buildAppRuntimeDocument({
				"server.js": "",
				"client.js": `document.title='${close}><b>x'`,
			});
			expect(html).toContain("window.tedix=");
			expect(html.indexOf("window.tedix=")).toBeLessThan(
				html.indexOf("document.title"),
			);
			expect(html).not.toContain("'</script><b>");
			expect(html).toContain("<\\/script><b>");
		},
	);
});

describe("changed-only saves through the host", () => {
	const patch = {
		kind: "sheet",
		ops: [
			{
				op: "set",
				path: ["workbook", "sheets", { id: "one" }, "rows", 4, 2],
				value: { input: "x", value: "x" },
			},
		],
	};
	const host = (
		role: AppRuntimeContext["role"],
		operations: string[],
		extra: Partial<AppRuntimeHostDeps> = {},
	) => {
		const base = deps(role);
		base.context.grants = [{ slot: "opportunities", operations }];
		return { ...base, ...extra } as AppRuntimeHostDeps;
	};
	const saved = {
		output: { id: outputId },
		revision: { id: "r5", revision: 5 },
		mergedWith: null,
		catchUp: null,
	};

	it("sends the patch and its base revision, and names the saved file to the host", async () => {
		const patchOutput = vi.fn(async () => saved);
		const onWrite = vi.fn();
		const args = { slot: "opportunities", baseRevision: 4, patch };
		// A grant to replace the whole body also covers changing part of it.
		for (const operations of [
			["outputs.read", "outputs.patch"],
			["outputs.read", "outputs.write"],
		]) {
			patchOutput.mockClear();
			onWrite.mockClear();
			expect(
				await handleAppRuntimeCall(
					host("build", operations, { patchOutput, onWrite }),
					"outputs.patch",
					args,
				),
			).toEqual({ ok: true, value: saved });
			expect(patchOutput).toHaveBeenCalledWith({
				workspaceId: resource.workspaceId,
				outputId,
				slot: "opportunities",
				baseRevision: 4,
				patch,
				explicit: false,
			});
			expect(onWrite).toHaveBeenCalledWith(outputId);
		}
	});

	it("lets a link visitor who may edit save by slot, and one who may only look save nothing", async () => {
		const patchOutput = vi.fn(async () => saved);
		const args = { slot: "opportunities", baseRevision: 4, patch };
		// The visitor's page holds no resource rows: the server finds the file.
		const visitor = (role: AppRuntimeContext["role"]) => ({
			...host(role, ["outputs.read", "outputs.write"], { patchOutput }),
			resources: [],
			serverResolvesSlots: true,
		});
		expect(
			await handleAppRuntimeCall(visitor("edit"), "outputs.patch", args),
		).toEqual({ ok: true, value: saved });
		expect(patchOutput).toHaveBeenCalledWith({
			workspaceId: resource.workspaceId,
			outputId: "",
			slot: "opportunities",
			baseRevision: 4,
			patch,
			explicit: false,
		});
		patchOutput.mockClear();
		expect(
			await handleAppRuntimeCall(visitor("use"), "outputs.patch", args),
		).toMatchObject({ ok: false, error: "not_permitted" });
		// A slot the app is not granted stays refused for an editing visitor.
		expect(
			await handleAppRuntimeCall(visitor("edit"), "outputs.patch", {
				...args,
				slot: "other",
			}),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(patchOutput).not.toHaveBeenCalled();
	});

	it("keeps a link visitor's unsaved changes under the file id the app read", async () => {
		const drafts = new Map();
		const content = { kind: "sheet", columns: ["#"], rows: [[1]] };
		const visitor = {
			...host("edit", ["outputs.read", "outputs.write"], { drafts }),
			resources: [],
			serverResolvesSlots: true,
			readSlot: vi.fn(async () => content),
		} as AppRuntimeHostDeps;
		const args = { slot: "opportunities", outputId: "file-1" };
		expect(
			await handleAppRuntimeCall(visitor, "app.draft.write", {
				...args,
				revision: 2,
				content,
			}),
		).toMatchObject({ ok: true });
		expect(
			await handleAppRuntimeCall(visitor, "app.draft.read", args),
		).toMatchObject({ ok: true, value: { revision: 2 } });
		// A view-only visitor keeps no unsaved changes.
		expect(
			await handleAppRuntimeCall(
				{ ...visitor, context: { ...visitor.context, role: "use" } },
				"app.draft.read",
				args,
			),
		).toMatchObject({ ok: false, error: "not_permitted" });
	});

	it("refuses a patch from a role or grant that may not write, and malformed patches, before any call", async () => {
		const patchOutput = vi.fn(async () => saved);
		const args = { slot: "opportunities", baseRevision: 4, patch };
		expect(
			await handleAppRuntimeCall(
				host("use", ["outputs.read", "outputs.write", "outputs.patch"], {
					patchOutput,
				}),
				"outputs.patch",
				args,
			),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(
			await handleAppRuntimeCall(
				host("owner", ["outputs.read"], { patchOutput }),
				"outputs.patch",
				args,
			),
		).toMatchObject({ ok: false, error: "not_permitted" });
		const owner = host("owner", ["outputs.read", "outputs.write"], {
			patchOutput,
		});
		for (const bad of [
			{ ...args, baseRevision: 0 },
			{ ...args, patch: { kind: "sheet", ops: [] } },
			{ ...args, patch: { kind: "video", ops: patch.ops } },
			{
				...args,
				patch: { kind: "sheet", ops: [{ op: "move", path: ["rows"] }] },
			},
			{ ...args, slot: 7 },
		])
			expect(
				await handleAppRuntimeCall(owner, "outputs.patch", bad),
			).toMatchObject({ ok: false, error: "bad_arguments" });
		expect(
			await handleAppRuntimeCall(owner, "outputs.patch", {
				...args,
				slot: "elsewhere",
			}),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(
			await handleAppRuntimeCall(
				host("owner", ["outputs.read", "outputs.write"]),
				"outputs.patch",
				args,
			),
		).toEqual({ ok: false, error: "host_unavailable" });
		expect(patchOutput).not.toHaveBeenCalled();
	});

	it("reports an overlapping change as a conflict that names the parts, and a refused change as lasting", async () => {
		const args = { slot: "opportunities", baseRevision: 4, patch };
		const failing = (error: unknown) =>
			host("owner", ["outputs.read", "outputs.patch"], {
				patchOutput: vi.fn(async () => {
					throw error;
				}),
			});
		expect(
			await handleAppRuntimeCall(
				failing({
					code: "CONFLICT",
					data: {
						expectedRevision: 4,
						currentRevision: 6,
						parts: ["/workbook/sheets/one/rows/4/2/input"],
					},
				}),
				"outputs.patch",
				args,
			),
		).toEqual({
			ok: false,
			error: "revision_conflict",
			detail:
				"A newer revision (6) has been saved. Your changes have not replaced it: both changed /workbook/sheets/one/rows/4/2/input",
		});
		expect(
			await handleAppRuntimeCall(
				failing({ code: "BAD_REQUEST", message: "The change does not fit" }),
				"outputs.patch",
				args,
			),
		).toEqual({
			ok: false,
			error: "bad_arguments",
			detail: "The change does not fit",
		});
		await expect(
			handleAppRuntimeCall(
				failing(new Error("network")),
				"outputs.patch",
				args,
			),
		).rejects.toThrow("network");
	});

	it("reads what changed since a revision, and an earlier revision, for a role that may read", async () => {
		const readOutputChanges = vi.fn(async () => ({
			output: { id: outputId },
			revision: { id: "r6", revision: 6 },
			patch,
		}));
		const readOutputRevision = vi.fn(async () => ({
			output: { id: outputId },
			revision: { revision: 3 },
		}));
		const reader = host("use", ["outputs.read"], {
			readOutputChanges,
			readOutputRevision,
		});
		expect(
			await handleAppRuntimeCall(reader, "outputs.changes", {
				slot: "opportunities",
				sinceRevision: 4,
			}),
		).toMatchObject({ ok: true, value: { revision: { revision: 6 }, patch } });
		expect(readOutputChanges).toHaveBeenCalledWith({
			workspaceId: resource.workspaceId,
			outputId,
			slot: "opportunities",
			sinceRevision: 4,
		});
		expect(
			await handleAppRuntimeCall(reader, "outputs.readRevision", {
				slot: "opportunities",
				revision: 3,
			}),
		).toMatchObject({ ok: true });
		expect(readOutputRevision).toHaveBeenLastCalledWith(
			outputId,
			3,
			"opportunities",
		);
		await handleAppRuntimeCall(reader, "outputs.readRevision", {
			slot: "opportunities",
		});
		expect(readOutputRevision).toHaveBeenLastCalledWith(
			outputId,
			undefined,
			"opportunities",
		);
		for (const [method, bad] of [
			["outputs.changes", { slot: "opportunities", sinceRevision: 0 }],
			["outputs.changes", { slot: "opportunities" }],
			["outputs.readRevision", { slot: "opportunities", revision: 1.5 }],
		] as const)
			expect(await handleAppRuntimeCall(reader, method, bad)).toMatchObject({
				ok: false,
				error: "bad_arguments",
			});
		expect(
			await handleAppRuntimeCall(
				host("viewer", ["outputs.read"], { readOutputChanges }),
				"outputs.changes",
				{ slot: "opportunities", sinceRevision: 4 },
			),
		).toMatchObject({ ok: false, error: "not_permitted" });
		expect(
			await handleAppRuntimeCall(
				host("use", ["outputs.read"]),
				"outputs.changes",
				{ slot: "opportunities", sinceRevision: 4 },
			),
		).toEqual({ ok: false, error: "host_unavailable" });
	});
});
