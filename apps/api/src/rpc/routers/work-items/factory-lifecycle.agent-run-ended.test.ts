import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { externalAgentPrincipals } from "@tedix/db/schema/external-agent-identity";
import {
	workAttempts,
	workEvents,
	workAttemptSteps,
	workAttemptMessages,
} from "@tedix/db/schema/work-items";
import {
	workResourceReservations,
	workBudgetReservations,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../../orpc";
import { settleAttemptProcedure } from "./factory-lifecycle";

const { session, enqueueMessage } = vi.hoisted(() => ({
	session: vi.fn(),
	enqueueMessage: vi.fn(),
}));
vi.mock(
	"@tedix/db/queries/external-agent-identity/mcp-credentials",
	async (original) => ({
		...(await original<
			typeof import("@tedix/db/queries/external-agent-identity/mcp-credentials")
		>()),
		resolveAuthorizedExternalAgentMcpSession: session,
	}),
);
vi.mock("../../../services/feed-outcome-summary", () => ({
	summarizeFeedOutcome: async () => null,
}));
vi.mock("../cognitive-runtime", () => ({ cognitiveRuntimeContractRouter: {} }));
vi.mock("@orpc/server", async (original) => ({
	...(await original<typeof import("@orpc/server")>()),
	createRouterClient: () => ({ enqueueMessage }),
}));

const id = "11111111-1111-4111-8111-111111111111";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

async function fixture(sourceSessionKey?: string) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				externalAgentPrincipals,
				workEvents,
				workAttemptSteps,
				workAttemptMessages,
				workResourceReservations,
				workBudgetReservations,
				workInteractions,
			),
	);
	sqlite.exec(
		"INSERT INTO organizations(id,name,slug) VALUES('org','Org','org')",
	);
	const db = createDbClient(createD1Facade(sqlite));
	const now = Date.now();
	await db.insert(externalAgentPrincipals).values({
		id: "bot",
		organizationId: "org",
		key: "codex",
		displayName: "Coding agent",
		status: "active",
		credentialBindingType: "github_actions_oidc",
		credentialBindingId: "repo:example/repo:environment:run",
		createdByType: "user",
		createdById: "owner",
		createdAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
	});
	await createWorkItem(db, {
		id,
		orgId: "org",
		title: "Rename the button",
		sourceSessionKey,
		stewardType: "tedi",
		stewardId: "tedi-1",
		createdAt: new Date(now).toISOString(),
	});
	sqlite
		.prepare(
			"UPDATE work_items SET disposition='accepted', work_kind='coding', acceptance_contract=? WHERE id=?",
		)
		.run(JSON.stringify({ version: 1, doneLooksLike: "Renamed." }), id);
	await db.insert(workAttempts).values({
		id: "attempt-1",
		admissionId: "admission-1",
		orgId: "org",
		workItemId: id,
		executorType: "external_agent",
		executorId: "bot",
		executorSessionId: "session",
		externalSessionKey: "codex:run",
		attemptNumber: 1,
		startedAt: new Date(now).toISOString(),
		heartbeatAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 300000).toISOString(),
	});
	session.mockResolvedValue({
		session: {
			externalSessionKey: "codex:run",
			harness: "codex",
			modelId: "fictional-model",
			modelVersion: "fictional-version",
			creditEligible: false,
		},
	});
	const context = {
		db,
		organizationId: "org",
		authType: "service-binding",
		headers: new Headers(),
		externalAgentPrincipalId: "bot",
		externalAgentSessionId: "session",
		externalAgentClientRecordId: "client",
	} as BaseContext;
	const settle = (outcome: "succeeded" | "failed" | "cancelled") =>
		settleAttemptProcedure["~orpc"].handler!({
			context,
			input: {
				id,
				attemptId: "attempt-1",
				outcome,
				summary: "Stopped by the person",
				metadata: {
					runnerTelemetry: {
						executor: "codex",
						model: "fictional-model",
						provider: "openai",
						reasoningEffort: null,
						brief: "",
						finalMessage: "",
						tools: {},
						usage: { input: 12, cached: 0, output: 3, reasoning: 0 },
						startedAt: new Date(now).toISOString(),
						finishedAt: new Date(now).toISOString(),
						heartbeatAt: new Date(now).toISOString(),
						outcome: "stopped",
						shas: [],
						workItems: [],
						corrections: [],
						source: "wrapper",
					},
				},
			},
			path: [],
			procedure: settleAttemptProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
	return { settle };
}

describe("settling an agent run started from a tedi chat", () => {
	it("messages the chat once, and a repeated settle does not send again", async () => {
		enqueueMessage.mockResolvedValue({ status: "queued" });
		const { settle } = await fixture("agent:main:chat-1");
		await expect(settle("cancelled")).resolves.toMatchObject({
			attempt: { outcome: "cancelled" },
		});
		expect(enqueueMessage).toHaveBeenCalledTimes(1);
		expect(enqueueMessage).toHaveBeenCalledWith({
			tediId: "tedi-1",
			conversationId: "agent:main:chat-1",
			idempotencyKey: "agent-run-ended:attempt-1",
			content: `The run for "Rename the button" ended: cancelled. Stopped by the person. Task: /work/items/${id}`,
			metadata: { source: "agent-run-ended", dispatchMode: "async" },
		});
		await expect(settle("cancelled")).rejects.toBeDefined();
		expect(enqueueMessage).toHaveBeenCalledTimes(1);
	});

	it("still settles when the message cannot be sent", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		enqueueMessage.mockRejectedValue(new Error("runtime down"));
		const { settle } = await fixture("agent:main:chat-1");
		await expect(settle("failed")).resolves.toMatchObject({
			attempt: { outcome: "failed" },
		});
		expect(enqueueMessage).toHaveBeenCalledTimes(1);
	});

	it("sends nothing for Work that did not start in a chat", async () => {
		const { settle } = await fixture();
		await expect(settle("cancelled")).resolves.toMatchObject({
			attempt: {
				outcome: "cancelled",
				metadata: {
					runnerMetrics: {
						executorId: "bot",
						harness: "codex",
						modelId: "fictional-model",
						modelVersion: "fictional-version",
						tokensIn: 12,
						tokensOut: 3,
						estimatedCostUsd: null,
						admissionCount: 1,
					},
				},
			},
		});
		expect(enqueueMessage).not.toHaveBeenCalled();
	});
});
