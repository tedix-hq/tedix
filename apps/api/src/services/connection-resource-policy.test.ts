import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as instances from "@tedix/db/queries/connection-instances";
import * as organizations from "@tedix/db/queries/organizations";
import * as providers from "@tedix/db/queries/connection-providers";
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

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

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

describe("own-access check on a live tool call through an organization account", () => {
	const reader = "member-b";
	const ownSlot: ConnectionInstanceRow = {
		id: "own-b",
		ownerUserId: reader,
		organizationId: null,
		providerId: "notion",
		label: "Mine",
		tokenIds: ["grant-b"],
		tokenSub: "subject-b",
		allowedResources: null,
		createdAt: "now",
		updatedAt: "now",
	};

	function readerFixture(input: {
		providerStatus?: number;
		linked?: boolean;
		checkEachPersonsAccess?: boolean;
		enforce?: boolean;
	}) {
		const { instance, token } = fixture(policy);
		vi.spyOn(instances, "getConnectionInstance").mockImplementation(
			async (_db, slotOwner, id) =>
				"userId" in slotOwner
					? id === ownSlot.id && slotOwner.userId === reader
						? ownSlot
						: undefined
					: instance,
		);
		vi.spyOn(instances, "listConnectionInstances").mockResolvedValue(
			input.linked === false ? [] : [ownSlot],
		);
		vi.spyOn(organizations, "getOrganizationById").mockResolvedValue({
			id: "org-a",
			metadata:
				input.checkEachPersonsAccess === undefined
					? {}
					: {
							connectionAccessChecks: [
								{
									connectionInstanceId: "slot-a",
									checkEachPersonsAccess: input.checkEachPersonsAccess,
								},
							],
						},
		} as Awaited<ReturnType<typeof organizations.getOrganizationById>>);
		vi.spyOn(
			providers,
			"getConnectionProviderByDescopeAppId",
		).mockResolvedValue({ category: "productivity" } as Awaited<
			ReturnType<typeof providers.getConnectionProviderByDescopeAppId>
		>);
		const personalToken = vi
			.spyOn(vault, "fetchPersonalConnectionToken")
			.mockResolvedValue({
				id: "grant-b",
				tokenSub: "subject-b",
				accessToken: "reader-token",
				scopes: [],
			});
		const probe = vi.fn(
			async () => new Response("{}", { status: input.providerStatus ?? 200 }),
		);
		vi.stubGlobal("fetch", probe);
		if (input.enforce !== false) {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-11-02T00:00:00.000Z"));
		}
		return { token, personalToken, probe };
	}
	const readPage = () =>
		fetchNamedConnection(
			context,
			owner,
			"notion",
			"slot-a",
			undefined,
			{ appId: "app-a", arguments: { url: allowed } },
			{ userId: reader },
		);

	it("refuses a member whose own Notion account cannot open the page", async () => {
		const { token, probe } = readerFixture({ providerStatus: 404 });
		await expect(readPage()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("cannot open this resource"),
		});
		const [url, init] = probe.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(url)).toBe(
			`https://api.notion.com/v1/blocks/${allowed.replaceAll("-", "")}`,
		);
		expect(new Headers(init.headers).get("Authorization")).toBe(
			"Bearer reader-token",
		);
		expect(token).not.toHaveBeenCalled();
	});
	it("serves the organization token when the member's own account opens the page", async () => {
		const { token } = readerFixture({ providerStatus: 200 });
		expect(await readPage()).toMatchObject({ accessToken: "opaque" });
		expect(token).toHaveBeenCalledOnce();
	});
	it("asks a member without a linked account to link it instead of returning data", async () => {
		const { token, probe } = readerFixture({ linked: false });
		await expect(readPage()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("Link your own notion account"),
		});
		expect(probe).not.toHaveBeenCalled();
		expect(token).not.toHaveBeenCalled();
	});
	it("fails closed when no person stands behind the call", async () => {
		const { token } = readerFixture({});
		await expect(
			fetchNamedConnection(
				context,
				owner,
				"notion",
				"slot-a",
				undefined,
				{ appId: "app-a", arguments: { url: allowed } },
				{ userId: null },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(token).not.toHaveBeenCalled();
	});
	it("only logs the would-deny during the audit week", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { token } = readerFixture({ providerStatus: 403, enforce: false });
		expect(await readPage()).toMatchObject({ accessToken: "opaque" });
		expect(token).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("would deny"));
	});
	it("leaves a connection the org admin set to shared visibility unaffected", async () => {
		const { token, probe } = readerFixture({
			providerStatus: 404,
			checkEachPersonsAccess: false,
		});
		expect(await readPage()).toMatchObject({ accessToken: "opaque" });
		expect(probe).not.toHaveBeenCalled();
		expect(token).toHaveBeenCalledOnce();
	});
});

describe("GitHub repository limit before provider access", () => {
	const githubPolicy = [
		{
			resourceType: "github_repository" as const,
			resourceId: "example/repo-x",
		},
	];
	const args = {
		owner: "example",
		repo: "repo-x",
		method: "update",
		issue_number: 1,
		title: "Updated",
	};
	function githubFixture() {
		const result = fixture(githubPolicy, "issue_write");
		result.instance.providerId = "github";
		result.tool.mockResolvedValue({
			enabled: true,
			config: {
				transport: "mcp",
				mcpToolName: "issue_write",
				mcpServerUrl: "https://api.githubcopilot.com/mcp/",
				auth: { type: "connection", connectionId: "github" },
			},
		} as Awaited<
			ReturnType<typeof tools.getToolByAppAndToolIdForOrganization>
		>);
		return result;
	}
	const execute = (arguments_: JsonValue) =>
		fetchNamedConnection(context, owner, "github", "slot-a", undefined, {
			appId: "app-a",
			arguments: arguments_,
		});
	it("allows X and refuses Y before credential retrieval", async () => {
		const { token } = githubFixture();
		await expect(execute({ ...args, repo: "repo-y" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(token).not.toHaveBeenCalled();
		expect(await execute(args)).toMatchObject({ accessToken: "opaque" });
		expect(token).toHaveBeenCalledOnce();
	});
	it("re-reads a revoked X grant when the pending call is replayed", async () => {
		const { instance, token } = githubFixture();
		// The pending approval retains arguments, never a credential or policy decision.
		const pending = structuredClone(args);
		instance.allowedResources = [];
		await expect(execute(pending)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(token).not.toHaveBeenCalled();
		expect(instances.getConnectionInstance).toHaveBeenCalledWith(
			context.db,
			owner,
			"slot-a",
			"github",
		);
	});
	it.each(["rpc", "rest", "external", "code", "catalog"])(
		"refuses unsupported %s transports before credential retrieval",
		async (transport) => {
			const { token, tool } = githubFixture();
			tool.mockResolvedValue({
				enabled: true,
				config: {
					transport,
					mcpToolName: "issue_write",
					auth: { type: "connection", connectionId: "github" },
				},
			} as Awaited<
				ReturnType<typeof tools.getToolByAppAndToolIdForOrganization>
			>);
			await expect(execute(args)).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(token).not.toHaveBeenCalled();
		},
	);
});
