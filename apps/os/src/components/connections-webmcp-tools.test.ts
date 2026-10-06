// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import { buildConnectionsWebMcpTools } from "./connections-webmcp-tools";
import type { ConnectionInventory } from "@tedix/api-contract/schemas/connections";
const inventory: ConnectionInventory = {
	organizationId: "org",
	scope: "organization",
	observedAt: "2026-08-28T00:00:00Z",
	rows: [],
	total: 0,
	hasMore: false,
	verificationComplete: false,
	referencesComplete: true,
	issues: [{ source: "credentials", message: "Verification unavailable" }],
};
const initechInventory: ConnectionInventory = {
	...inventory,
	verificationComplete: true,
	rows: [
		{
			provider: {
				appId: "initech",
				name: "Initech",
				description: null,
				enabled: true,
				availableScopes: [],
				logoUrl: null,
				connectionType: "api_key",
				registrationMode: null,
				tokenScope: "tenant",
				supportedScopes: ["tenant"],
				recommendedScope: "tenant",
				referencedByOrg: true,
			},
			scope: "tenant",
			accountState: "present",
			accountLabel: null,
			connection: null,
			references: [{ appId: "app", appSlug: "initech-globex", source: "app" }],
			referencesComplete: true,
			access: "not_evaluated",
			health: "not_checked",
		},
	],
	total: 1,
	issues: [],
};

const restrictedInventory: ConnectionInventory = {
	...initechInventory,
	verificationComplete: false,
	rows: initechInventory.rows.map((row) => ({
		...row,
		accountState: "restricted" as const,
		connection: null,
	})),
	issues: [{ source: "credentials", message: "Verification unavailable" }],
};
describe("connections WebMCP", () => {
	it("pins ownership, forwards cancellation and retains verification failures", async () => {
		const read = vi
			.fn()
			.mockResolvedValue({ ...inventory, accessToken: "never-return" });
		const tool = buildConnectionsWebMcpTools({
			scope: "organization",
			read,
		})[0]!;
		const signal = new AbortController().signal;
		const result = await tool.execute({}, { signal });
		expect(read).toHaveBeenCalledWith(
			{ scope: "organization", q: "", status: "all", limit: 50, offset: 0 },
			{ signal },
		);
		expect(result.structuredContent).toMatchObject({
			verificationComplete: false,
		});
		expect(JSON.stringify(result)).not.toContain("never-return");
	});
	it.each([
		{ scope: "personal" },
		{ organizationId: "another" },
		{ confirm: true },
		{ limit: 101 },
		{ offset: -1 },
	])("rejects injected authority or unbounded reads %#", async (input) => {
		const read = vi.fn();
		const result = await buildConnectionsWebMcpTools({
			scope: "organization",
			read,
		})[0]!.execute(input);
		expect(result.isError).toBe(true);
		expect(read).not.toHaveBeenCalled();
	});
	it("cannot prepare an absent or unverifiable account", async () => {
		const prepare = vi.fn();
		const read = vi.fn().mockResolvedValue(inventory);
		const tool = buildConnectionsWebMcpTools({
			scope: "organization",
			read,
			prepare,
		}).find((t) => t.name === "prepare_disconnect_connection")!;
		expect((await tool.execute({ providerId: "initech" })).isError).toBe(true);
		expect(prepare).not.toHaveBeenCalled();
	});
	it("can prepare recovery connect but not disconnect for a restricted account", async () => {
		const prepare = vi.fn().mockReturnValue(true);
		const tools = buildConnectionsWebMcpTools({
			scope: "organization",
			read: vi.fn().mockResolvedValue(restrictedInventory),
			prepare,
		});
		const connect = tools.find(
			(candidate) => candidate.name === "prepare_connect_connection",
		)!;
		const disconnect = tools.find(
			(candidate) => candidate.name === "prepare_disconnect_connection",
		)!;
		expect(
			(await connect.execute({ providerId: "initech" })).structuredContent,
		).toMatchObject({
			status: "awaiting_human_confirmation",
			changed: false,
		});
		expect(prepare).toHaveBeenCalledWith(
			"connect",
			restrictedInventory.rows[0],
		);
		prepare.mockClear();
		expect((await disconnect.execute({ providerId: "initech" })).isError).toBe(
			true,
		);
		expect(prepare).not.toHaveBeenCalled();
	});
	it("does not read or prepare after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const read = vi.fn();
		const prepare = vi.fn();
		const tool = buildConnectionsWebMcpTools({
			scope: "personal",
			read,
			prepare,
		})[0]!;
		expect(
			(await tool.execute({}, { signal: controller.signal })).isError,
		).toBe(true);
		expect(read).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
	});
	it("checks one referenced app service without upgrading credential or access claims", async () => {
		const read = vi.fn().mockResolvedValue(initechInventory);
		const checkService = vi.fn().mockResolvedValue({
			app: "initech-globex",
			url: "https://initech-globex.mcp.tedix.dev/mcp",
			toolCount: 223,
			allPassed: true,
			passCount: 4,
			failCount: 0,
			totalDurationMs: 20,
			checks: [],
		});
		const tool = buildConnectionsWebMcpTools({
			scope: "organization",
			read,
			checkService,
		}).find((candidate) => candidate.name === "check_connection_service")!;
		const result = await tool.execute({ providerId: "initech" });
		expect(checkService).toHaveBeenCalledWith(
			{ appSlug: "initech-globex" },
			undefined,
		);
		expect(result.structuredContent).toMatchObject({
			providerId: "initech",
			appSlug: "initech-globex",
			credentialState: "present",
			credentialUsability: "not_checked",
			effectiveAccess: "not_evaluated",
			providerApiHealth: "not_checked",
			service: { allPassed: true, toolCount: 223 },
		});
	});
	it("rejects a service slug that does not reference the connection", async () => {
		const checkService = vi.fn();
		const tool = buildConnectionsWebMcpTools({
			scope: "organization",
			read: vi.fn().mockResolvedValue(initechInventory),
			checkService,
		}).find((candidate) => candidate.name === "check_connection_service")!;
		expect(
			(await tool.execute({ providerId: "initech", appSlug: "other" })).isError,
		).toBe(true);
		expect(checkService).not.toHaveBeenCalled();
	});
});
