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
