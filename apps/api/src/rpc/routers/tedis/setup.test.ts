import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { apiKeyContext } from "../../test-context";
import { getSetupProcedure } from "./setup";

const mocks = vi.hoisted(() => ({
	tedi: vi.fn(),
	apps: vi.fn(),
	tools: vi.fn(),
	skills: vi.fn(),
	inventory: vi.fn(),
	fga: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: mocks.tedi,
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppsByOrganization: mocks.apps,
}));
vi.mock("@tedix/db/queries/tools", () => ({ getToolsByAppId: mocks.tools }));
vi.mock("@tedix/db/queries/cognitive/skill-inventory", () => ({
	listAllSkillsForOrg: mocks.skills,
}));
vi.mock("../connections/inventory", () => ({
	readConnectionsOverview: mocks.inventory,
}));
vi.mock("@tedix/auth/client", async (original) => ({
	...(await original<typeof import("@tedix/auth/client")>()),
	getManagementClient: () => ({ management: { fga: { check: mocks.fga } } }),
}));
const id = "11111111-1111-4111-8111-111111111111";
const context = () =>
	apiKeyContext({
		organizationId: "org-one",
		env: { DESCOPE_MANAGEMENT_KEY: "test-only" } as unknown as CloudflareEnv,
		db: {} as BaseContext["db"],
		scopes: ["apps:read"],
	});
const invoke = () =>
	call(getSetupProcedure, { tediId: id }, { context: context() });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.tedi.mockResolvedValue({
		id,
		organizationId: "org-one",
		descopeUserId: "worker-identity",
		tags: [],
		mcpCapabilityProfile: "standard",
	});
	mocks.apps.mockResolvedValue([
		{ id: "app-one", slug: "mail", name: "Mail", metadata: {} },
	]);
	mocks.tools.mockResolvedValue([
		{
			id: "read-mail",
			appId: "app-one",
			toolId: "read_mail",
			title: "Read mail",
			enabled: true,
			config: { auth: { type: "connection", connectionId: "mail" } },
		},
	]);
	mocks.skills.mockResolvedValue({ entries: [], total: 0 });
	mocks.fga.mockImplementation(async (tuples) => ({
		ok: true,
		data: tuples.map((tuple: object) => ({ tuple, allowed: true })),
	}));
	mocks.inventory.mockResolvedValue({
		rows: [],
		hasMore: false,
		verificationComplete: true,
	});
});

describe("tedi setup read", () => {
	it("rejects foreign tedis before reading dependencies or credentials", async () => {
		mocks.tedi.mockResolvedValue({ id, organizationId: "org-other" });
		await expect(invoke()).rejects.toThrow();
		expect(mocks.apps).not.toHaveBeenCalled();
		expect(mocks.inventory).not.toHaveBeenCalled();
	});
	it("reads all skill pages and derives MCP tool requirements", async () => {
		mocks.fga.mockImplementation(async (tuples) => ({
			ok: true,
			data: tuples.map((tuple: object) => ({ tuple, allowed: false })),
		}));
		mocks.skills.mockImplementation(async (_db, _org, { offset }) => ({
			entries:
				offset === 0
					? Array.from({ length: 200 }, (_, i) => ({
							id: `skill-${i}`,
							title: "First page",
							slug: `first-${i}`,
							lifecycleState: "active",
						}))
					: [
							{
								id: "last-skill",
								title: "Inbox",
								slug: "inbox",
								lifecycleState: "active",
								mcpAppBindings: { mail: "app-one" },
								files: {
									"SKILL.md":
										"---\ncapabilities:\n  mcp:\n    mail: [read_mail, unbuilt]\n---\nInbox",
								},
							},
						],
			total: 201,
		}));
		const result = await invoke();
		expect(mocks.skills).toHaveBeenCalledTimes(2);
		expect(result.items).toContainEqual(
			expect.objectContaining({ id: "tool:read-mail", state: "ready" }),
		);
		expect(result.items).toContainEqual(
			expect.objectContaining({
				kind: "build",
				label: "Build still owed: mail.unbuilt",
			}),
		);
	});
	it("makes failed credential and assignment reads visible, without claiming absence", async () => {
		mocks.inventory.mockRejectedValue(new Error("unavailable"));
		mocks.fga.mockResolvedValue({ ok: false });
		mocks.skills.mockResolvedValue({
			entries: [
				{
					id: "skill",
					title: "Inbox",
					slug: "inbox",
					lifecycleState: "active",
					toolIds: ["read-mail"],
				},
			],
			total: 1,
		});
		const result = await invoke();
		expect(result.items).toContainEqual(
			expect.objectContaining({ kind: "connection", state: "needs_you" }),
		);
		expect(result.items).toContainEqual(
			expect.objectContaining({ id: "assignments", state: "needs_you" }),
		);
	});
	it("does not treat incomplete FGA responses as a complete assignment inventory", async () => {
		mocks.fga.mockResolvedValue({ ok: true, data: [] });
		expect((await invoke()).items).toContainEqual(
			expect.objectContaining({ id: "assignments", state: "needs_you" }),
		);
	});
});
