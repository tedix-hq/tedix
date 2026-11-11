import { QueryClient } from "@tanstack/react-query";
import { osQueryKeys, outputDetailQueryOptions } from "./os-query-options";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	appRuntimeContextFromManifest,
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
	type AppRuntimeContext,
	type AppRuntimeHostDeps,
	type AppRuntimeDraft,
} from "./app-runtime-host";

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
