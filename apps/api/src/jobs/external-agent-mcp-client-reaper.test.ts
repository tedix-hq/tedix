import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runExternalAgentMcpClientReaperTick } from "./external-agent-mcp-client-reaper";

const listReapable = vi.hoisted(() => vi.fn());
const markReaped = vi.hoisted(() => vi.fn());
const markAttempted = vi.hoisted(() => vi.fn());
const deleteClients = vi.hoisted(() => vi.fn());
const deleteClient = vi.hoisted(() => vi.fn());

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("../rpc/routers/descope-aih-env", () => ({
	requireAihEnv: () => ({
		DESCOPE_PROJECT_ID: "p",
		DESCOPE_MANAGEMENT_KEY: "k",
	}),
}));
vi.mock("@tedix/auth/aih-client", () => ({
	deleteDescopeMcpServerClients: deleteClients,
	deleteDescopeMcpServerClient: deleteClient,
}));
vi.mock("@tedix/db/queries/external-agent-identity/mcp-credentials", () => ({
	listReapableExternalAgentMcpCredentials: listReapable,
	markExternalAgentMcpCredentialsReaped: markReaped,
	markExternalAgentMcpCredentialCleanupAttempted: markAttempted,
}));

const env = {
	DESCOPE_PROJECT_ID: "p",
	DESCOPE_MANAGEMENT_KEY: "k",
	DB: {},
} as unknown as CloudflareEnv;
const sleep = vi.fn(async () => {});
const tick = () => runExternalAgentMcpClientReaperTick(env, "run-1", { sleep });

afterEach(() => {
	vi.resetAllMocks();
	vi.restoreAllMocks();
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

	it("batch-deletes clients per server, spaced apart, and revokes exactly those rows", async () => {
		listReapable.mockResolvedValue([
			{ clientRecordId: "a1", mcpServerId: "srv-a" },
			{ clientRecordId: "a2", mcpServerId: "srv-a" },
			{ clientRecordId: "b1", mcpServerId: "srv-b" },
		]);
		deleteClients.mockResolvedValue(undefined);
		markReaped.mockImplementation((_db, { clientRecordIds }) =>
			Promise.resolve(clientRecordIds.length),
		);

		const result = await tick();

		expect(deleteClients).toHaveBeenCalledTimes(2);
		expect(deleteClients).toHaveBeenCalledWith(expect.anything(), {
			ids: ["a1", "a2"],
			mcpServerId: "srv-a",
		});
		expect(deleteClients).toHaveBeenCalledWith(expect.anything(), {
			ids: ["b1"],
			mcpServerId: "srv-b",
		});
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(markReaped.mock.calls[0][1].clientRecordIds.sort()).toEqual([
			"a1",
			"a2",
			"b1",
		]);
		expect(markAttempted).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			candidates: 3,
			deleted: 3,
			revoked: 3,
			managementCalls: 2,
		});
	});

	it("falls back to single deletes, counts gone clients as done and moves failures to the back", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		listReapable.mockResolvedValue([
			{ clientRecordId: "ok", mcpServerId: "srv" },
			{ clientRecordId: "gone", mcpServerId: "srv" },
			{ clientRecordId: "bad", mcpServerId: "srv" },
		]);
		deleteClients.mockRejectedValue(
			new Error("AIH MCP server clients batch delete failed [400 Bad Request]"),
		);
		deleteClient.mockImplementation((_env, { id }) =>
			id === "ok"
				? Promise.resolve()
				: Promise.reject(
						new Error(
							id === "gone"
								? "AIH MCP server client delete failed [404 Not Found]: missing"
								: "AIH MCP server client delete failed [500 Internal Server Error]",
						),
					),
		);
		markReaped.mockImplementation((_db, { clientRecordIds }) =>
			Promise.resolve(clientRecordIds.length),
		);

		const result = await tick();

		expect(markReaped.mock.calls[0][1].clientRecordIds).toEqual(["ok", "gone"]);
		expect(markAttempted).toHaveBeenCalledWith(expect.anything(), {
			clientRecordIds: ["bad"],
			attemptedAt: expect.any(String),
		});
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain(
			'\\"status\\":400',
		);
		expect(result).toMatchObject({
			candidates: 3,
			deleted: 2,
			alreadyGone: 1,
			deleteFailures: 1,
			batchFailures: 1,
			managementCalls: 4,
		});
	});

	it("stops at the per-run call budget and leaves the rest for the next run", async () => {
		listReapable.mockResolvedValue(
			Array.from({ length: 7_000 }, (_, i) => ({
				clientRecordId: `c${i}`,
				mcpServerId: "srv",
			})),
		);
		deleteClients.mockResolvedValue(undefined);
		markReaped.mockImplementation((_db, { clientRecordIds }) =>
			Promise.resolve(clientRecordIds.length),
		);

		const result = await tick();

		expect(deleteClients).toHaveBeenCalledTimes(60);
		expect(result).toMatchObject({ deleted: 6_000, deferred: 1_000 });
		expect(markAttempted).not.toHaveBeenCalled();
	});

	it("does no remote work when nothing is due", async () => {
		listReapable.mockResolvedValue([]);
		const result = await tick();
		expect(deleteClients).not.toHaveBeenCalled();
		expect(markReaped).not.toHaveBeenCalled();
		expect(result).toEqual({ candidates: 0, deleted: 0, revoked: 0 });
	});
});

it("expires federated ledger entries without deleting the shared Descope client", async () => {
	const id = `wif:${"a".repeat(64)}`;
	listReapable.mockResolvedValue([
		{ clientRecordId: id, mcpServerId: "resource" },
	]);
	markReaped.mockResolvedValue(1);
	const result = await tick();
	expect(deleteClients).not.toHaveBeenCalled();
	expect(markReaped).toHaveBeenCalledWith(expect.anything(), {
		clientRecordIds: [id],
		revokedAt: expect.any(String),
	});
	expect(result).toMatchObject({ candidates: 1, deleted: 0, revoked: 1 });
});
