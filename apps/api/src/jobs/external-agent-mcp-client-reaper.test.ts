import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runExternalAgentMcpClientReaperTick } from "./external-agent-mcp-client-reaper";

const listReapable = vi.hoisted(() => vi.fn());
const markReaped = vi.hoisted(() => vi.fn());
const deleteClients = vi.hoisted(() => vi.fn());

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("../rpc/routers/descope-aih-env", () => ({
	requireAihEnv: () => ({
		DESCOPE_PROJECT_ID: "p",
		DESCOPE_MANAGEMENT_KEY: "k",
	}),
}));
vi.mock("@tedix/auth/aih-client", () => ({
	deleteDescopeMcpServerClients: deleteClients,
}));
vi.mock("@tedix/db/queries/external-agent-identity/mcp-credentials", () => ({
	listReapableExternalAgentMcpCredentials: listReapable,
	markExternalAgentMcpCredentialsReaped: markReaped,
}));

const env = {
	DESCOPE_PROJECT_ID: "p",
	DESCOPE_MANAGEMENT_KEY: "k",
	DB: {},
} as unknown as CloudflareEnv;

afterEach(() => {
	listReapable.mockReset();
	markReaped.mockReset();
	deleteClients.mockReset();
});

describe("external-agent MCP client reaper", () => {
	it("no-ops without Descope management credentials", async () => {
		const result = await runExternalAgentMcpClientReaperTick(
			{ DESCOPE_PROJECT_ID: "p", DB: {} } as unknown as CloudflareEnv,
			"run-1",
		);
		expect(result).toEqual({});
		expect(listReapable).not.toHaveBeenCalled();
	});

	it("batch-deletes expired clients per server and revokes exactly those rows", async () => {
		listReapable.mockResolvedValue([
			{ clientRecordId: "a1", mcpServerId: "srv-a" },
			{ clientRecordId: "a2", mcpServerId: "srv-a" },
			{ clientRecordId: "b1", mcpServerId: "srv-b" },
		]);
		deleteClients.mockResolvedValue(undefined);
		markReaped.mockImplementation((_db, { clientRecordIds }) =>
			Promise.resolve(clientRecordIds.length),
		);

		const result = await runExternalAgentMcpClientReaperTick(env, "run-1");

		// One batch call per server, each carrying only that server's ids.
		expect(deleteClients).toHaveBeenCalledTimes(2);
		expect(deleteClients).toHaveBeenCalledWith(expect.anything(), {
			ids: ["a1", "a2"],
			mcpServerId: "srv-a",
		});
		expect(deleteClients).toHaveBeenCalledWith(expect.anything(), {
			ids: ["b1"],
			mcpServerId: "srv-b",
		});
		const revokedIds = markReaped.mock.calls[0][1].clientRecordIds.sort();
		expect(revokedIds).toEqual(["a1", "a2", "b1"]);
		expect(result).toMatchObject({ candidates: 3, deleted: 3, revoked: 3 });
	});

	it("leaves rows active when their Descope delete fails, so a later tick retries", async () => {
		listReapable.mockResolvedValue([
			{ clientRecordId: "a1", mcpServerId: "srv-a" },
			{ clientRecordId: "b1", mcpServerId: "srv-b" },
		]);
		// srv-b delete fails; srv-a succeeds.
		deleteClients.mockImplementation((_env, { mcpServerId }) =>
			mcpServerId === "srv-b"
				? Promise.reject(new Error("descope 500"))
				: Promise.resolve(undefined),
		);
		markReaped.mockImplementation((_db, { clientRecordIds }) =>
			Promise.resolve(clientRecordIds.length),
		);

		const result = await runExternalAgentMcpClientReaperTick(env, "run-1");

		// Only the successfully-deleted client is revoked; the failed one is left
		// active (not passed to markReaped).
		expect(markReaped.mock.calls[0][1].clientRecordIds).toEqual(["a1"]);
		expect(result).toMatchObject({
			candidates: 2,
			deleted: 1,
			deleteFailures: 1,
			revoked: 1,
		});
	});

	it("does no remote work when nothing is expired", async () => {
		listReapable.mockResolvedValue([]);
		const result = await runExternalAgentMcpClientReaperTick(env, "run-1");
		expect(deleteClients).not.toHaveBeenCalled();
		expect(markReaped).not.toHaveBeenCalled();
		expect(result).toEqual({ candidates: 0, deleted: 0, revoked: 0 });
	});
});
