import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";

const mocks = vi.hoisted(() => ({
	actor: vi.fn(),
	work: vi.fn(),
	create: vi.fn(),
	gate: vi.fn(),
	internalRoute: vi.fn(),
}));
vi.mock("./work-items-principal", async (original) => ({
	...(await original<typeof import("./work-items-principal")>()),
	verifiedActiveWorkActor: mocks.actor,
}));
vi.mock("@tedix/db/queries/work-items/crud", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/crud")>()),
	getWorkItemById: mocks.work,
}));
vi.mock("@tedix/db/queries/work-items/interactions", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/work-items/interactions")
	>()),
	createWorkInteraction: mocks.create,
}));
vi.mock("../../services/deck-create-gate", () => ({
	deckCreateGate: mocks.gate,
}));
vi.mock("../../services/deck-curation-trigger", () => ({
	queueDeckCuration: vi.fn(),
}));
vi.mock("../../services/internal-decision-routing", () => ({
	internalDecisionRouting: mocks.internalRoute,
}));

const orgId = "11111111-1111-4111-8111-111111111111";
const workItemId = "22222222-2222-4222-8222-222222222222";
const agent = {
	type: "external_agent",
	id: "fictional-agent",
	sessionId: "fictional-session",
	externalSessionKey: "codex:fictional-session",
};
const client = createRouterClient(workInteractionsContractRouter, {
	context: {
		authType: "service-binding",
		tediScopes: ["mcp:messaging.write"],
		db: {},
		env: {},
		headers: new Headers({ "x-service-binding": "true" }),
		organizationId: orgId,
		url: new URL("https://api.example.test/rpc"),
	} as BaseContext,
});
const input = {
	workItemId,
	kind: "question" as const,
	subject: "session · codex waiting: Approve extending the test scope?",
	prompt:
		"Approve extending the test scope? The earlier money task is complete.",
	requestedFrom: { type: "user" as const, id: "fictional-person" },
	metadata: {
		schema: "tedix.decision-capture.v1",
		source: "agent-turn-end",
		triage: { status: "ok" },
	},
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.actor.mockResolvedValue(agent);
	mocks.internalRoute.mockResolvedValue(null);
	mocks.work.mockResolvedValue({ stewardType: null, stewardId: null });
	mocks.gate.mockResolvedValue(null);
	mocks.create.mockImplementation(async (_db, p) => ({
		...p,
		workItemId: p.workItemId ?? null,
		caseId: p.caseId ?? null,
		projectId: p.projectId ?? null,
		creatorType: p.creator.type,
		creatorId: p.creator.id,
		creatorSessionId: p.creator.sessionId ?? null,
		expiresAt: p.expiresAt ?? null,
		resolvedAt: null,
		status: "open",
		version: 1,
		createdAt: p.now,
	}));
});

it("returns an ordinary approve capture to its authenticated agent", async () => {
	await client.create(input);
	expect(mocks.create).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			targetType: "external_agent",
			targetId: agent.id,
			creator: agent,
		}),
	);
	expect(mocks.gate).not.toHaveBeenCalled();
	expect(mocks.work).toHaveBeenCalledWith({}, workItemId, orgId);
});

it("prefers the Work's tedi steward", async () => {
	mocks.work.mockResolvedValue({
		stewardType: "tedi",
		stewardId: "fictional-steward",
	});
	await client.create(input);
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "tedi",
		targetId: "fictional-steward",
		creator: agent,
	});
});

it("keeps a human steward out of ordinary agent decisions", async () => {
	mocks.work.mockResolvedValue({
		stewardType: "user",
		stewardId: "fictional-person",
	});
	await client.create(input);
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "external_agent",
		targetId: agent.id,
	});
});

it("supports project-only captures without looking up unrelated Work", async () => {
	await client.create({
		...input,
		workItemId: undefined,
		projectId: workItemId,
	});
	expect(mocks.work).not.toHaveBeenCalled();
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "external_agent",
		targetId: agent.id,
	});
});

it.each([
	"Approve paying the invoice?",
	"Approve publishing the announcement?",
	"Approve sending the customer reply?",
	"Complete sign-in and consent",
	"Provide credentials",
	"Delete the old database",
	"Change the member role",
	"Bookkeeping: answer the tax questions",
])("keeps an owner-only capture with the person: %s", async (subject) => {
	await client.create({ ...input, subject });
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "user",
		targetId: "fictional-person",
	});
	expect(mocks.gate).toHaveBeenCalled();
});

it("preserves an ordinary human-authored question", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "fictional-person" });
	await client.create({
		...input,
		metadata: {},
		reason: "The person chooses the project scope.",
	});
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "user",
		targetId: "fictional-person",
	});
});

it("routes an owner-login capture to the Work's tedi steward", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "fictional-person" });
	mocks.work.mockResolvedValue({
		stewardType: "tedi",
		stewardId: "fictional-steward",
	});
	await client.create(input);
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "tedi",
		targetId: "fictional-steward",
	});
});

it("bounces an owner-login agent decision when no agent recipient exists", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "fictional-person" });
	await expect(client.create(input)).rejects.toMatchObject({
		code: "UNPROCESSABLE_CONTENT",
	});
	expect(mocks.create).not.toHaveBeenCalled();
});

it("keeps owner-only captures under owner login with the person", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "fictional-person" });
	await client.create({ ...input, subject: "Approve paying the invoice?" });
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "user",
		targetId: "fictional-person",
	});
});

it("returns an ordinary capture to its authenticated tedi", async () => {
	mocks.actor.mockResolvedValue({ type: "tedi", id: "fictional-tedi" });
	await client.create(input);
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "tedi",
		targetId: "fictional-tedi",
	});
});

it("keeps an unclassified capture with its agent even when Work has a steward", async () => {
	mocks.work.mockResolvedValue({
		stewardType: "tedi",
		stewardId: "fictional-steward",
	});
	await client.create({
		...input,
		metadata: { ...input.metadata, triage: { status: "unavailable" } },
	});
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "external_agent",
		targetId: agent.id,
	});
	expect(mocks.work).not.toHaveBeenCalled();
});

it("does not change non-capture agent questions", async () => {
	await client.create({
		...input,
		metadata: {},
		reason: "The person chooses the project scope.",
	});
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "user",
		targetId: "fictional-person",
	});
});

it("does not let autonomy metadata bypass the owner-only capture policy", async () => {
	mocks.internalRoute.mockResolvedValue({ classId: "internal.code.push" });
	await client.create({
		...input,
		subject: "Bookkeeping: answer the tax questions",
	});
	expect(mocks.internalRoute).not.toHaveBeenCalled();
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "user",
		targetId: "fictional-person",
	});
});

it.each([false, true])(
	"routes routine repair with a deadline and server-owned recipient evidence (capture=%s)",
	async (captured) => {
		mocks.work.mockResolvedValue({
			id: workItemId,
			stewardType: "tedi",
			stewardId: "repair-owner",
		});
		const before = Date.now();
		await client.create({
			...input,
			subject: "Clean up the tests?",
			prompt: "Inspect the failed test and repair the fixture.",
			reason: "Tests need repair.",
			metadata: captured
				? input.metadata
				: { blockerRouting: { ownerId: "forged-owner" } },
		});
		const created = mocks.create.mock.calls[0]![1];
		expect(created).toMatchObject({
			targetType: "tedi",
			targetId: "repair-owner",
			metadata: {
				blockerRouting: {
					ownerId: "repair-owner",
					evidenceRef: `/work/items/${workItemId}`,
				},
			},
		});
		expect(Date.parse(created.dueAt)).toBeGreaterThan(before);
		expect(Date.parse(created.dueAt)).toBeLessThanOrEqual(
			Date.now() + 86_400_000,
		);
		expect(mocks.gate).not.toHaveBeenCalled();
	},
);

it("keeps a real human action with its reason, exact instruction and Work evidence", async () => {
	await client.create({
		...input,
		subject: "Complete sign-in and consent",
		prompt:
			"Open https://provider.example.test/settings and click Connect; review the requested access.",
		reason: "The provider requires your presence and consent.",
		metadata: { evidenceRefs: [`/work/items/${workItemId}`] },
	});
	expect(mocks.create.mock.calls[0]![1]).toMatchObject({
		targetType: "user",
		targetId: "fictional-person",
		prompt:
			"Open https://provider.example.test/settings and click Connect; review the requested access.",
		metadata: {
			reason: "The provider requires your presence and consent.",
			evidenceRefs: [`/work/items/${workItemId}`],
			blockerRouting: null,
		},
	});
	expect(mocks.gate).toHaveBeenCalled();
});
