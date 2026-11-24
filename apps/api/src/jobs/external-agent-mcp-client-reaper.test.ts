import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runExternalAgentMcpClientReaperTick } from "./external-agent-mcp-client-reaper";

const listReapable = vi.hoisted(() => vi.fn());
const markReaped = vi.hoisted(() => vi.fn());
const markAttempted = vi.hoisted(() => vi.fn());
const deleteClients = vi.hoisted(() => vi.fn());
const deleteClient = vi.hoisted(() => vi.fn());
const searchClients = vi.hoisted(() => vi.fn());

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
	searchDescopeMcpServerClients: searchClients,
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
const rows = (server: string, ...ids: string[]) =>
	ids.map((clientRecordId) => ({ clientRecordId, mcpServerId: server }));
const listed = (...ids: string[]) => ids.map((id) => ({ id }));
const reapedIds = () =>
	markReaped.mock.calls.flatMap((call) => call[1].clientRecordIds).sort();
const attemptedIds = () =>
	markAttempted.mock.calls.flatMap((call) => call[1].clientRecordIds).sort();
const notFound = () =>
	new Error(
		'AIH MCP server clients batch delete failed [400 Bad Request]: {"errorCode":"E113118","errorDescription":"MCP server client not found"}',
	);

function reapCounts() {
	markReaped.mockImplementation((_db, { clientRecordIds }) =>
		Promise.resolve(clientRecordIds.length),
	);
}

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

	it("lists each server once, marks missing clients done without a call and deletes the rest", async () => {
		listReapable.mockResolvedValue([
			...rows("srv-a", "a1", "a2", "a-gone"),
			...rows("srv-b", "b-gone"),
		]);
		searchClients.mockImplementation((_env, { mcpServerId }) =>
			Promise.resolve(
				mcpServerId === "srv-a" ? listed("a1", "a2", "other") : listed("x"),
			),
		);
		deleteClients.mockResolvedValue(undefined);
		reapCounts();

		const result = await tick();

		expect(searchClients).toHaveBeenCalledTimes(2);
		expect(searchClients).toHaveBeenCalledWith(
			expect.anything(),
			{ mcpServerId: "srv-a" },
			expect.objectContaining({ timeoutMs: 15_000 }),
		);
		expect(deleteClients).toHaveBeenCalledTimes(1);
		expect(deleteClients).toHaveBeenCalledWith(expect.anything(), {
			ids: ["a1", "a2"],
			mcpServerId: "srv-a",
		});
		expect(deleteClient).not.toHaveBeenCalled();
		expect(reapedIds()).toEqual(["a-gone", "a1", "a2", "b-gone"]);
		expect(markAttempted).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			candidates: 4,
			listed: 4,
			missingMarkedDone: 2,
			deleted: 2,
			batchFailures: 0,
			deferred: 0,
			managementCalls: 3,
			revoked: 4,
		});
	});

	it("writes ledger updates fifty rows at a time", async () => {
		const ids = Array.from({ length: 120 }, (_, i) => `gone-${i}`);
		listReapable.mockResolvedValue(rows("srv", ...ids));
		searchClients.mockResolvedValue(listed("someone-else"));
		reapCounts();

		const result = await tick();

		expect(deleteClients).not.toHaveBeenCalled();
		expect(
			markReaped.mock.calls.map((call) => call[1].clientRecordIds.length),
		).toEqual([50, 50, 20]);
		expect(result).toMatchObject({ missingMarkedDone: 120, revoked: 120 });
	});

	it("falls back to single deletes when a batch races a removal and rotates what stays unresolved", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		listReapable.mockResolvedValue(rows("srv", "ok", "gone", "bad"));
		searchClients.mockResolvedValue(listed("ok", "gone", "bad"));
		deleteClients.mockRejectedValue(notFound());
		deleteClient.mockImplementation((_env, { id }) =>
			id === "ok"
				? Promise.resolve()
				: Promise.reject(
						id === "gone"
							? notFound()
							: new Error(
									"AIH MCP server client delete failed [500 Internal Server Error]",
								),
					),
		);
		reapCounts();

		const result = await tick();

		expect(reapedIds()).toEqual(["gone", "ok"]);
		expect(attemptedIds()).toEqual(["bad"]);
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain(
			"E113118",
		);
		expect(result).toMatchObject({
			deleted: 2,
			alreadyGone: 1,
			deleteFailures: 1,
			batchFailures: 1,
			markedAttempted: 1,
			managementCalls: 5,
		});
	});

	it("deletes as before when the list fails or comes back empty", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		listReapable.mockResolvedValue([
			...rows("srv-a", "a1"),
			...rows("srv-b", "b1"),
		]);
		searchClients.mockImplementation((_env, { mcpServerId }) =>
			mcpServerId === "srv-a"
				? Promise.reject(new Error("list timeout"))
				: Promise.resolve([]),
		);
		deleteClients.mockResolvedValue(undefined);
		reapCounts();

		const result = await tick();

		expect(deleteClients).toHaveBeenCalledTimes(2);
		expect(reapedIds()).toEqual(["a1", "b1"]);
		expect(result).toMatchObject({
			listFailures: 2,
			missingMarkedDone: 0,
			deleted: 2,
		});
	});

	it("marks rows deferred by the call budget so the queue rotates", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const ids = Array.from({ length: 100 }, (_, i) => `c${i}`);
		listReapable.mockResolvedValue(rows("srv", ...ids));
		searchClients.mockResolvedValue(listed(...ids));
		deleteClients.mockRejectedValue(new Error("batch [500 Server Error]"));
		deleteClient.mockRejectedValue(new Error("single [500 Server Error]"));
		reapCounts();

		const result = await tick();

		// 1 list + 1 batch + 58 singles reach the 60-call budget.
		expect(deleteClient).toHaveBeenCalledTimes(58);
		expect(attemptedIds()).toHaveLength(100);
		expect(result).toMatchObject({
			deleteFailures: 58,
			deferred: 42,
			markedAttempted: 100,
			managementCalls: 60,
		});
	});

	it("does no remote work when nothing is due", async () => {
		listReapable.mockResolvedValue([]);
		const result = await tick();
		expect(searchClients).not.toHaveBeenCalled();
		expect(deleteClients).not.toHaveBeenCalled();
		expect(markReaped).not.toHaveBeenCalled();
		expect(result).toEqual({ candidates: 0, deleted: 0, revoked: 0 });
	});
});

it("expires federated ledger entries without deleting the shared Descope client", async () => {
	const id = `wif:${"a".repeat(64)}`;
	listReapable.mockResolvedValue(rows("resource", id));
	markReaped.mockResolvedValue(1);
	const result = await tick();
	expect(searchClients).not.toHaveBeenCalled();
	expect(deleteClients).not.toHaveBeenCalled();
	expect(markReaped).toHaveBeenCalledWith(expect.anything(), {
		clientRecordIds: [id],
		revokedAt: expect.any(String),
	});
	expect(result).toMatchObject({ candidates: 1, deleted: 0, revoked: 1 });
});
