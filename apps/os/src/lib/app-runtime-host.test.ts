import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	appRuntimeContextFromManifest,
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
	type AppRuntimeContext,
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

	it("inlines client.js after the tedix bridge and keeps the script tag closed", () => {
		const html = buildAppRuntimeDocument({
			"server.js": "",
			"client.js": "document.title='</script><b>x'",
		});
		expect(html).toContain("window.tedix=");
		expect(html.indexOf("window.tedix=")).toBeLessThan(
			html.indexOf("document.title"),
		);
		expect(html).not.toContain("'</script><b>");
		expect(html).toContain("<\\/script><b>");
	});
});
