import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as instances from "@tedix/db/queries/connection-instances";
import * as tools from "@tedix/db/queries/tools";
import * as vault from "@tedix/auth/connections";
import type { ConnectionInstanceRow } from "@tedix/db/schema/connection-instances";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { BaseContext } from "../rpc/orpc";
import { fetchNamedConnection } from "../rpc/routers/connections/policy-resolution";

const allowed = "11111111-1111-4111-8111-111111111111";
const outside = "22222222-2222-4222-8222-222222222222";
const owner = { organizationId: "org-a", tenantId: "tenant-a" };
const context = {
	db: {},
	headers: new Headers({ "X-Tedix-Mcp-Tool-Id": "fetch_page" }),
} as BaseContext;

function fixture(
	resources: ConnectionInstanceRow["allowedResources"],
	toolName = "notion-fetch",
) {
	const instance: ConnectionInstanceRow = {
		id: "slot-a",
		ownerUserId: "owner-a",
		organizationId: "org-a",
		providerId: "notion",
		label: "Selected pages",
		tokenIds: ["grant-a"],
		tokenSub: "subject-a",
		allowedResources: resources,
		createdAt: "now",
		updatedAt: "now",
	};
	vi.spyOn(instances, "getConnectionInstance").mockResolvedValue(instance);
	const tool = vi
		.spyOn(tools, "getToolByAppAndToolIdForOrganization")
		.mockResolvedValue({
			enabled: true,
			config: {
				transport: "mcp",
				mcpToolName: toolName,
				auth: { type: "connection", connectionId: "notion" },
			},
		} as Awaited<
			ReturnType<typeof tools.getToolByAppAndToolIdForOrganization>
		>);
	const token = vi
		.spyOn(vault, "fetchNamedTenantConnectionToken")
		.mockResolvedValue({
			id: "grant-a",
			tokenSub: "subject-a",
			accessToken: "opaque",
			scopes: [],
		});
	return { token, tool, instance };
}
function fetchPage(args: JsonValue, ctx = context) {
	return fetchNamedConnection(ctx, owner, "notion", "slot-a", undefined, {
		appId: "app-a",
		arguments: args,
	});
}
const policy = [{ resourceType: "notion_page" as const, resourceId: allowed }];

afterEach(() => vi.restoreAllMocks());

describe("organization connection resource gate before token retrieval", () => {
	it("denies an outside page without fetching any credential", async () => {
		const { token, tool } = fixture(policy);
		await expect(
			fetchPage({ url: `https://www.notion.so/${outside}` }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(token).not.toHaveBeenCalled();
		expect(tool).toHaveBeenCalledWith(context.db, {
			organizationId: "org-a",
			appId: "app-a",
			toolId: "fetch_page",
		});
	});
	it.each([
		allowed,
		allowed.replaceAll("-", "").toUpperCase(),
		`https://www.notion.so/${allowed.replaceAll("-", "")}`,
		`https://www.notion.com/${allowed}`,
	])("allows the exact selected page %s", async (url) => {
		const { token } = fixture(policy);
		expect(await fetchPage({ url })).toMatchObject({ accessToken: "opaque" });
		expect(token).toHaveBeenCalledOnce();
	});
	it("allows the reviewed REST MCP page reader and denies a different page", async () => {
		const { token } = fixture(policy, "API-retrieve-a-page");
		await expect(fetchPage({ page_id: outside })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(token).not.toHaveBeenCalled();
		expect(await fetchPage({ page_id: allowed })).toMatchObject({
			accessToken: "opaque",
		});
	});
	it.each([
		{},
		{ url: outside },
		{ url: [allowed, outside] },
		{ url: allowed, page_id: outside },
		{ url: `https://evil.example/${allowed}` },
		{ url: `https://www.notion.so/${allowed}#${outside}` },
		{ url: `https://www.notion.so/${allowed}?v=${outside}` },
		{ url: `https://www.notion.so.evil.example/${allowed}` },
		{ url: `collection://${allowed}` },
		{ url: `https://www.notion.so/${outside}/${allowed}` },
		{ url: `https://www.notion.so/${outside}-${allowed}` },
	] as JsonValue[])(
		"fails closed for malformed or ambiguous targets %j",
		async (args) => {
			const { token } = fixture(policy);
			await expect(fetchPage(args)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(token).not.toHaveBeenCalled();
		},
	);
	it.each([
		"notion-search",
		"notion-move-pages",
		"notion-update-page",
		"API-get-block-children",
		"new-tool",
	])("denies unreviewed operation %s even with an allowed id", async (name) => {
		const { token } = fixture(policy, name);
		await expect(fetchPage({ url: allowed })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(token).not.toHaveBeenCalled();
	});
	it("denies an empty or malformed policy and a missing gateway call context", async () => {
		const { token, instance } = fixture([]);
		await expect(fetchPage({ url: allowed })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		instance.allowedResources = {
			wrong: true,
		} as unknown as ConnectionInstanceRow["allowedResources"];
		await expect(fetchPage({ url: allowed })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		instance.allowedResources = policy;
		await expect(
			fetchNamedConnection(context, owner, "notion", "slot-a"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			fetchPage({ url: allowed }, { ...context, headers: new Headers() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(token).not.toHaveBeenCalled();
	});
	it("keeps null-policy connections whole-account without new tool restrictions", async () => {
		const { token, tool } = fixture(null, "notion-search");
		expect(await fetchPage({ query: "everything" })).toMatchObject({
			accessToken: "opaque",
		});
		expect(tool).not.toHaveBeenCalled();
		expect(token).toHaveBeenCalledOnce();
	});
	it("allows the internal inventory metadata read without authorizing a tool call", async () => {
		const { token, tool } = fixture(policy);
		expect(
			await fetchNamedConnection(
				context,
				owner,
				"notion",
				"slot-a",
				undefined,
				"inventory",
			),
		).toMatchObject({ accessToken: "opaque" });
		expect(tool).not.toHaveBeenCalled();
		await expect(fetchPage({ url: outside })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(token).toHaveBeenCalledOnce();
	});
	it("reads a changed policy on every call", async () => {
		const { token, instance } = fixture(null);
		await fetchPage({ url: outside });
		instance.allowedResources = policy;
		await expect(fetchPage({ url: outside })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(token).toHaveBeenCalledOnce();
	});
});
