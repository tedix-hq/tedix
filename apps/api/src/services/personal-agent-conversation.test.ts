import { DatabaseSync } from "node:sqlite";
import {
	beforeEach,
	afterEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	PoppyConversations,
	type PoppySql,
} from "../../../tedi-runtime/src/poppy-conversations";
import { handlePoppyRuntime } from "../../../tedi-runtime/src/poppy-runtime";
import { personalAgentConversation } from "./personal-agent-conversation";
const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	tedi: vi.fn(),
	verify: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	responses: vi.fn(),
	cancel: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.organization,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("./personal-agent-session", () => ({
	verifySignedOutPersonalAgentSession: mocks.verify,
}));
vi.mock("@tedix/db/queries/work-items/interactions", () => ({
	getWorkInteraction: mocks.get,
	createWorkInteraction: mocks.create,
	listWorkInteractionResponses: mocks.responses,
	cancelWorkInteraction: mocks.cancel,
}));
const company = {
	tediId: "00000000-0000-4000-8000-000000000001",
	description: "Public help",
	publicInstructions: "Public hours",
	handoff: {
		userId: "human",
		projectId: "00000000-0000-4000-8000-000000000002",
	},
};
const config = {
	domain: "company.example",
	mcpUrl: "https://public.example/mcp",
	description: "Public",
	companyAgent: company,
};
const identity = {
	clientId: "https://agent.example/client",
	userId: "visitor",
	sessionId: "first",
	version: "1.0",
};
const base = {
	organizationId: "org-example",
	appId: "app-example",
	sessionToken: "fictional-proof",
	version: "1.0",
};
const db = {} as DbClient;
let sqlite: DatabaseSync;
let store: PoppyConversations;
let fetcher: ReturnType<typeof vi.fn>;
let env: CloudflareEnv;
const interactions = new Map<
	string,
	{ id: string; status: string; version: number }
>();
const message = (id: string) => ({
	id,
	message: { author: { type: "agent" }, text: "When do you open?" },
});
const call = (path = "", body: JsonValue = message("request1"), query = "") =>
	personalAgentConversation(db, env, {
		...base,
		method: body === undefined ? "GET" : "POST",
		url: `${config.mcpUrl}/poppy/conversations${path}${query}`,
		...(body === undefined ? {} : { body }),
	});
const read = (id: string) =>
	personalAgentConversation(db, env, {
		...base,
		method: "GET",
		url: `${config.mcpUrl}/poppy/conversations/${id}/events`,
	});
beforeEach(() => {
	vi.clearAllMocks();
	interactions.clear();
	sqlite = new DatabaseSync(":memory:");
	const sql: PoppySql = {
		exec<T>(query: string, ...values: SqlStorageValue[]) {
			const rows = sqlite.prepare(query).all(...(values as never[])) as T[];
			return { toArray: () => rows };
		},
	};
	store = new PoppyConversations(sql, <T>(fn: () => T) => {
		sqlite.exec("BEGIN");
		try {
			const value = fn();
			sqlite.exec("COMMIT");
			return value;
		} catch (error) {
			sqlite.exec("ROLLBACK");
			throw error;
		}
	});
	mocks.organization.mockResolvedValue({
		metadata: { personalAgentProtocol: config },
	});
	mocks.tedi.mockResolvedValue({
		id: company.tediId,
		slug: "public-agent",
		runtimeKind: "agent",
	});
	mocks.verify.mockResolvedValue({ status: "accepted", identity });
	mocks.get.mockImplementation(
		async (_db, p) => interactions.get(p.interactionId) ?? null,
	);
	mocks.create.mockImplementation(async (_db, p) => {
		const row = { ...p, status: "open", version: 1 };
		interactions.set(p.id, row);
		return row;
	});
	mocks.cancel.mockImplementation(async (_db, p) => {
		interactions.get(p.interactionId)!.status = "cancelled";
	});
	mocks.responses.mockResolvedValue([]);
	fetcher = vi.fn(async (url: string, init: RequestInit) => {
		expect(url).toBe("https://public-agent.tedi.tedix.dev/hooks/poppy");
		return handlePoppyRuntime(new Request(url, init), {
			organizationId: base.organizationId,
			store,
			kick: async () => {
				for (let job = store.nextJob(); job; job = store.nextJob())
					store.finish(job, "Local model fixture: we open at 9.");
			},
		});
	});
	env = { TEDI_SERVICE: { fetch: fetcher } } as unknown as CloudflareEnv;
});
afterEach(() => sqlite.close());
describe("signed-out Company Agent service", () => {
	it("verifies the Session, resolves the tedi in this organization and forwards only verified identity", async () => {
		const receipt = await call();
		expect(receipt.httpStatus).toBe(201);
		expect(mocks.verify).toHaveBeenCalledWith(
			db,
			expect.objectContaining({ sessionToken: "fictional-proof" }),
		);
		expect(mocks.tedi).toHaveBeenCalledWith(
			db,
			company.tediId,
			base.organizationId,
		);
		const sent = JSON.parse(fetcher.mock.calls[0]![1].body as string);
		expect(sent.identity).toEqual({
			clientId: identity.clientId,
			userId: identity.userId,
			version: identity.version,
		});
		expect(JSON.stringify(sent)).not.toContain("fictional-proof");
		expect(sent).not.toHaveProperty("sessionToken");
		const id = (receipt.body as { conversation_id: string }).conversation_id;
		expect((await read(id)).body).toMatchObject({
			closed: false,
			working: false,
			events: [
				{ message: { role: "user" } },
				{ message: { role: "company", author: { type: "agent" } } },
			],
		});
		expect(await call()).toEqual(receipt);
	});
	it.each([
		["invalid_session", 400],
		["session_ended", 400],
		["not_configured", 404],
		["rate_limited", 429],
	])("rejects %s before runtime dispatch", async (status, http) => {
		mocks.verify.mockResolvedValue({ status });
		expect(await call()).toEqual({ httpStatus: http, body: { error: status } });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("does not route a tedi from another organization or a lookalike endpoint", async () => {
		mocks.tedi.mockResolvedValue(null);
		expect((await call()).httpStatus).toBe(503);
		expect(fetcher).not.toHaveBeenCalled();
		const result = await personalAgentConversation(db, env, {
			...base,
			method: "POST",
			url: "https://other.example/mcp/poppy/conversations",
			body: message("request1"),
		});
		expect(result.httpStatus).toBe(404);
	});
	it.each(["?wait=-1", "?wait=0.2", "?wait=no", "?cursor=not%20an%20id"])(
		"rejects malformed query %s",
		async (query) => {
			expect((await call("", message("request1"), query)).httpStatus).toBe(400);
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it("creates one OS handoff and accepts only the addressed person's response as human", async () => {
		const id = (await call()).body as { conversation_id: string };
		const path = `/${id.conversation_id}/handoff`;
		expect((await call(path, { id: "handoff1" })).httpStatus).toBe(202);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.create).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				targetType: "user",
				targetId: "human",
				projectId: company.handoff.projectId,
			}),
		);
		expect((await read(id.conversation_id)).body).toMatchObject({
			handoff: "pending",
			responder: "agent",
		});
		await call(path, { id: "handoff2" });
		expect(mocks.create).toHaveBeenCalledTimes(1);
		const card = [...interactions.values()][0];
		card.status = "resolved";
		mocks.responses.mockResolvedValue([
			{
				responderType: "external_agent",
				responderId: "human",
				resolvesRequest: true,
				body: "Machine-generated impostor",
			},
		]);
		expect((await read(id.conversation_id)).body).toMatchObject({
			handoff: "none",
			responder: "agent",
		});
		await call(path, { id: "handoff3" });
		const next = [...interactions.values()].at(-1)!;
		next.status = "resolved";
		mocks.responses.mockResolvedValue([
			{
				responderType: "user",
				responderId: "human",
				resolvesRequest: true,
				body: "Alex here.",
			},
		]);
		const result = await read(id.conversation_id);
		expect(result.body).toMatchObject({ handoff: "none", responder: "human" });
		expect(
			(result.body as { events: Array<{ message: JsonValue }> }).events.at(-1)!
				.message,
		).toMatchObject({
			author: { type: "human" },
			text: "Alex here.",
		});
	});
	it("cancels a child's open inbox handoff when its parent closes, retaining the parent receipt", async () => {
		const parent = (await call()).body as { conversation_id: string };
		const child = (
			await call("", {
				...message("child"),
				parent_conversation_id: parent.conversation_id,
			})
		).body as { conversation_id: string };
		await call(`/${child.conversation_id}/handoff`, { id: "handoffchild" });
		const closed = await call(`/${parent.conversation_id}/close`, {
			id: "closeparent",
		});
		expect(closed).toEqual({ httpStatus: 202, body: parent });
		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect((await read(child.conversation_id)).body).toMatchObject({
			closed: true,
			handoff: "none",
			working: false,
		});
	});
	it("withdraws a card created concurrently with closing the conversation", async () => {
		const id = (await call()).body as { conversation_id: string };
		const create = mocks.create.getMockImplementation()!;
		mocks.create.mockImplementation(async (...args) => {
			store.request(
				{ ...identity, organizationId: base.organizationId },
				"POST",
				`${id.conversation_id}/close`,
				{ id: "raceclose" },
			);
			return create(...args);
		});
		await call(`/${id.conversation_id}/handoff`, { id: "racehandoff" });
		expect([...interactions.values()][0]?.status).toBe("cancelled");
	});
	it("leaves provider failure retryable without exposing submitted content", async () => {
		fetcher.mockRejectedValue(Error("fictional-proof/private-error"));
		expect(await call()).toEqual({
			httpStatus: 503,
			body: { error: "unavailable" },
		});
	});
});
