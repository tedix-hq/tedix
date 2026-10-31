import { createRouterClient } from "@orpc/server";
import {
	SkillWorkflowTediTaskSigningPayloadSchema,
	WORKFLOW_TEDI_TASK_SIGNATURE_CONTEXT,
} from "@tedix/api-contract/schemas/cognitive";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	artifact: vi.fn(),
	events: vi.fn(),
	deleted: vi.fn(),
	tediForOrg: vi.fn(),
	tedi: vi.fn(),
}));
vi.mock("@tedix/db/queries/skill-runs", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/skill-runs")>()),
	getSkillRun: mocks.run,
}));
vi.mock("@tedix/db/queries/skill-run-artifacts", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/skill-run-artifacts")>()),
	getRunArtifact: mocks.artifact,
}));
vi.mock("@tedix/db/queries/cognitive-runtime", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/cognitive-runtime")>()),
	listTediRuntimeEventsForRouter: mocks.events,
	isTediConversationDeleted: mocks.deleted,
}));
vi.mock("@tedix/db/queries/tedis", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/tedis")>()),
	getTediByIdForOrganization: mocks.tediForOrg,
	getTediById: mocks.tedi,
}));
import { skillsGetWorkflowStepTediActivity } from "./tedi-activity";

const token = "fictional-platform-test-key";
const path = "epochs/2/steps/x:review/1/attempts/3/calls/run/1.json";
const input = { runId: "workflow-1", executionEpoch: 2, path, attempt: 3 };
const run = {
	id: "workflow-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	executionEpoch: 2,
};
let receipt: Record<string, unknown>;
let parent: Record<string, unknown> | null;

function client(patch: Partial<BaseContext> = {}) {
	return createRouterClient(skillsGetWorkflowStepTediActivity, {
		context: {
			authType: "user",
			user: { sub: "owner-1" },
			userRole: "owner",
			organizationId: "org-1",
			db: {},
			headers: new Headers(),
			env: { ENVIRONMENT: "development", PLATFORM_SERVICE_TOKEN: token },
			url: new URL("https://api.test/rpc/skills/getWorkflowStepTediActivity"),
			rateLimiter: { limit: async () => ({ success: true }) },
			...patch,
		} as BaseContext,
	});
}

async function reference(patch: Record<string, unknown> = {}, secret = token) {
	const payload = SkillWorkflowTediTaskSigningPayloadSchema.parse({
		schemaVersion: 2,
		organizationId: "org-1",
		workflowRunId: "workflow-1",
		executionEpoch: 2,
		stepId: "step-1",
		stepName: "review",
		stepCount: 1,
		attempt: 3,
		phase: "run",
		ordinal: 1,
		callId: "call-1",
		taskId: "tedi:tedi-1:native-run-1",
		tediId: "tedi-1",
		runId: "native-run-1",
		sensitiveOutput: false,
		receiptStepCount: 1,
		...patch,
	});
	const digest = await hmacSha256(
		await deriveHkdfHmacKey(secret, WORKFLOW_TEDI_TASK_SIGNATURE_CONTEXT),
		JSON.stringify(payload),
	);
	return {
		...payload,
		signature: Array.from(digest, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	};
}

function event(
	kind: string,
	payload: Record<string, unknown> = {},
	patch = {},
) {
	return {
		id: kind,
		tediId: "tedi-1",
		runId: "native-run-1",
		conversationId: "recorded-conversation",
		kind,
		createdAt: "2026-01-01T00:00:01.000Z",
		payload,
		...patch,
	};
}

beforeEach(async () => {
	vi.clearAllMocks();
	parent = { sensitiveOutput: false };
	receipt = {
		schemaVersion: 2,
		kind: "workflow_mcp_call",
		executionEpoch: 2,
		step: { id: "step-1", name: "review", count: 1 },
		attempt: 3,
		phase: "run",
		ordinal: 1,
		callId: "call-1",
		namespace: "tedi",
		method: "run_tedi_turn",
		request: { text: "Instructions are not actions" },
		response: { assistant: { content: "Not canonical" } },
		tediTaskReference: await reference(),
	};
	mocks.run.mockResolvedValue(run);
	mocks.tediForOrg.mockResolvedValue({ id: "tedi-1", organizationId: "org-1" });
	mocks.deleted.mockResolvedValue(false);
	mocks.artifact.mockImplementation(async (_db, runId, selectedPath) => {
		const value = selectedPath.includes("/calls/") ? receipt : parent;
		return value
			? {
					runId,
					path: selectedPath,
					contentInline: JSON.stringify(value),
					mimeType: "application/json",
					sizeBytes: 1024,
				}
			: null;
	});
	mocks.events.mockResolvedValue([
		event("run.completed"),
		event(
			"message.completed",
			{
				role: "assistant",
				content: "Recorded final reply",
				reasoning: "private reasoning",
			},
			{ messageId: "final-message" },
		),
		event("subagent.completed", {
			childRunId: "child-1",
			targetTediId: "peer-1",
			instructions: "private delegation",
			result: "private child result",
		}),
		event(
			"tool.completed",
			{ name: "browser_read_result", resultPreview: "private tool result" },
			{ toolCallId: "tool-1" },
		),
		event("message.reasoning", { content: "private reasoning" }),
		event("message.received", { content: "Instructions are not actions" }),
		event("run.started"),
	]);
});

describe("workflow step canonical tedi activity", () => {
	it("reads only the linked run and exposes recorded operational actions and its final message", async () => {
		const result = await client()(input);
		expect(result).toMatchObject({
			status: "available",
			activitySource: "linked_tedi_run",
			runStatus: "completed",
			finalResult: {
				status: "available",
				messageId: "final-message",
				content: "Recorded final reply",
			},
			actions: [
				{ kind: "tool.completed", toolName: "browser_read_result" },
				{ kind: "subagent.completed", childRunId: "child-1" },
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/private|Not canonical|Instructions/,
		);
		expect(mocks.run).toHaveBeenCalledWith(
			expect.anything(),
			"workflow-1",
			"org-1",
			"development",
		);
		expect(mocks.events).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
			tediId: "tedi-1",
			runId: "native-run-1",
			order: "desc",
			limit: 201,
		});
		expect(mocks.deleted).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org-1",
			tediId: "tedi-1",
			conversationId: "recorded-conversation",
		});
	});

	it("accepts a host-signed legacy bare run reference without deriving a conversation", async () => {
		receipt.tediTaskReference = await reference({ taskId: "native-run-1" });
		expect((await client()(input)).status).toBe("available");
	});

	it.each([
		["organizationId", "other-org"],
		["workflowRunId", "other-workflow"],
		["executionEpoch", 1],
		["attempt", 2],
		["phase", "rollback"],
		["ordinal", 2],
		["stepName", "other-step"],
		["stepCount", 2],
		["stepId", "other-step-id"],
		["callId", "other-call"],
		["tediId", "other-tedi"],
		["receiptStepCount", 2],
	])(
		"rejects a signed link with a different %s before reading the ledger",
		async (key, value) => {
			receipt.tediTaskReference = await reference({ [key]: value });
			expect((await client()(input)).status).toBe("unavailable");
			expect(mocks.events).not.toHaveBeenCalled();
		},
	);

	it("rejects a forged signature even when every coordinate matches", async () => {
		receipt.tediTaskReference = await reference({}, "tenant-controlled-key");
		expect((await client()(input)).status).toBe("unavailable");
		expect(mocks.tediForOrg).not.toHaveBeenCalled();
		expect(mocks.events).not.toHaveBeenCalled();
	});

	it("rejects v1 signatures that did not verify workflow task origin", async () => {
		receipt.tediTaskReference = { ...(await reference()), schemaVersion: 1 };
		expect((await client()(input)).status).toBe("unavailable");
		expect(mocks.events).not.toHaveBeenCalled();
	});

	it("does not upgrade unlinked historical tool results or conversation IDs into activity", async () => {
		delete receipt.tediTaskReference;
		receipt.response = {
			run_id: "native-run-1",
			task: { id: "tedi:tedi-1:native-run-1" },
			conversationId: "recorded-conversation",
		};
		expect(await client()(input)).toMatchObject({
			status: "unavailable",
			reason: expect.stringContaining("no verified canonical"),
		});
		expect(mocks.events).not.toHaveBeenCalled();
	});

	it.each(["receipt", "parent", "signed"])(
		"withholds %s sensitive output",
		async (where) => {
			if (where === "receipt")
				receipt.response = { nested: [{ redacted: true, value: "secret" }] };
			if (where === "parent") parent = { sensitiveOutput: true };
			if (where === "signed")
				receipt.tediTaskReference = await reference({ sensitiveOutput: true });
			expect(await client()(input)).toMatchObject({
				status: "redacted",
				actions: [],
				finalResult: { status: "redacted" },
			});
			expect(mocks.events).not.toHaveBeenCalled();
		},
	);

	it("preserves machine scopes and tedi principal access boundaries", async () => {
		await expect(
			client({ authType: "apikey", user: null, scopes: [] })(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.run).not.toHaveBeenCalled();
		await expect(
			client({
				authType: "tedi",
				tediId: "other-tedi",
				scopes: ["tedis:read"],
			})(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.events).not.toHaveBeenCalled();
	});

	it("rejects foreign tenant and tedi records without reading their events", async () => {
		mocks.tediForOrg.mockResolvedValue(null);
		await expect(client()(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.events).not.toHaveBeenCalled();
	});

	it("checks workflow ownership before reading artifacts", async () => {
		mocks.run.mockResolvedValue(undefined);
		await expect(client()(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.artifact).not.toHaveBeenCalled();
	});

	it("rejects stale selected epochs before reading artifacts", async () => {
		await expect(
			client()({ ...input, executionEpoch: 1 }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.artifact).not.toHaveBeenCalled();
	});

	it("rechecks epoch after the ledger read to reject a concurrent restart", async () => {
		mocks.run
			.mockResolvedValueOnce(run)
			.mockResolvedValueOnce({ ...run, executionEpoch: 3 });
		await expect(client()(input)).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("withholds newly latched and retired workflows", async () => {
		mocks.run
			.mockResolvedValueOnce(run)
			.mockResolvedValueOnce({ ...run, sensitiveDataLatch: { version: 1 } });
		expect((await client()(input)).status).toBe("redacted");
		mocks.run.mockResolvedValue({ ...run, workflowRetiredAt: "2026-01-01" });
		await expect(client()(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("does not resurrect a soft-deleted conversation", async () => {
		mocks.deleted.mockResolvedValue(true);
		expect(await client()(input)).toMatchObject({
			status: "unavailable",
			actions: [],
			finalResult: { status: "unavailable" },
		});
	});

	it("refuses events from another run, even in the same conversation", async () => {
		mocks.events.mockResolvedValue([
			event(
				"message.completed",
				{ role: "assistant", content: "wrong run" },
				{ runId: "different-run", messageId: "other" },
			),
		]);
		expect((await client()(input)).status).toBe("unavailable");
	});

	it("does not substitute another assistant reply when the exact output message is missing", async () => {
		mocks.events.mockResolvedValue([
			event("run.completed"),
			event("message.reasoning", { content: "not a final message" }),
		]);
		expect((await client()(input)).finalResult.status).toBe("unavailable");
	});

	it("keeps failed runs from presenting a cached assistant reply as final success", async () => {
		mocks.events.mockResolvedValue([
			event("run.failed"),
			event(
				"message.completed",
				{ role: "assistant", content: "failure notice" },
				{ messageId: "failed-message" },
			),
		]);
		expect(await client()(input)).toMatchObject({
			runStatus: "failed",
			finalResult: { status: "unavailable" },
		});
	});

	it("withholds redacted final content and tool payloads", async () => {
		mocks.events.mockResolvedValue([
			event("run.completed"),
			event(
				"message.completed",
				{ role: "assistant", content: "secret", nested: { redacted: true } },
				{ messageId: "message" },
			),
			event("tool.completed", { name: "secret-tool", redacted: true }),
		]);
		expect(await client()(input)).toMatchObject({
			actions: [],
			finalResult: { status: "redacted" },
		});
	});

	it("bounds event pages and final content explicitly", async () => {
		mocks.events.mockResolvedValue([
			event("run.completed"),
			event(
				"message.completed",
				{ role: "assistant", content: "x".repeat(20_000) },
				{ messageId: "message" },
			),
			...Array.from({ length: 199 }, (_, index) =>
				event("tool.completed", { name: "read" }, { id: String(index) }),
			),
		]);
		const result = await client()(input);
		expect(result.truncated).toBe(true);
		expect(result.actions).toHaveLength(198);
		expect(result.finalResult.truncated).toBe(true);
		expect(result.finalResult.content).toHaveLength(16_000);
	});

	it("does not infer a run status from a truncated page without a terminal event", async () => {
		mocks.events.mockResolvedValue(
			Array.from({ length: 201 }, (_, index) =>
				event("tool.completed", { name: "read" }, { id: String(index) }),
			),
		);
		const result = await client()(input);
		expect(result.truncated).toBe(true);
		expect(result.runStatus).toBeUndefined();
		expect(result.finalResult.status).toBe("unavailable");
	});
});
