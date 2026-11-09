import { beforeEach, expect, it, vi } from "vite-plus/test";
import { AutomationEventSchema } from "@tedix/api-contract/schemas/automation-events";
import { handleAutomationEventMessage } from "../jobs/automation-events";
import { dispatchPendingAgentSessionEvents } from "../jobs/agent-session-event-drain";
import {
	enqueueAgentSessionEvents,
	processAgentSessionEventQueue,
} from "./agent-session-event-queue";

const state = vi.hoisted(() => ({
	pending: 9,
	active: true,
	process: vi.fn(),
	capture: vi.fn(),
}));
const owner = { organizationId: "org-example", userId: "user-ada" };
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/query-client", () => ({ createDbQueryClient: () => ({}) }));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByCanonicalUserId: async (
		_db: unknown,
		org: string,
		user: string,
	) =>
		org === "org-example" && user === "user-ada"
			? {
					status: state.active ? "active" : "inactive",
					descopeUserId: "provider-ada",
				}
			: undefined,
}));
vi.mock("@tedix/db/queries/agent-session-requests", () => ({
	listPendingAgentSessionEventOwners: async () => [
		{ organizationId: "org-example", userId: "user-ada" },
	],
	listPendingAgentSessionEvents: async () =>
		state.pending ? [{ id: "next" }] : [],
}));
vi.mock("./unrouted-model-egress", () => ({
	organizationModelEnv: () => ({}),
}));
vi.mock("./agent-session-request-ledger", () => ({
	workersAiLedgerModel: () => ({}),
	processAgentSessionEvents: state.process,
}));
vi.mock("./request-ledger-lessons", () => ({
	ledgerLessonNoveltyModel: vi.fn(),
	recordLedgerLessonCandidates: vi.fn(),
}));
vi.mock("./request-filing-settings", () => ({
	automaticFilingEnabled: async () => false,
}));
vi.mock("../kernel/request-local-source", () => ({
	captureLocalKernelRequests: state.capture,
}));

beforeEach(() => {
	state.pending = 9;
	state.active = true;
	state.process
		.mockReset()
		.mockImplementation(async (_db, _model, _owner, options) => {
			await options.onRecorded({
				...owner,
				harness: "codex",
				sessionKey: "one",
				sourceAt: "2026-11-09T18:00:00Z",
			});
			const processed = Math.min(4, state.pending);
			state.pending -= processed;
			return processed;
		});
	state.capture.mockReset();
});

it("seeds an existing backlog on the tick and drains continuations without another upload", async () => {
	const messages: unknown[] = [];
	const send = vi.fn(async (body: unknown) => {
		messages.push(body);
	});
	const env = { AUTOMATION_EVENTS: { send } } as unknown as CloudflareEnv;
	expect(await dispatchPendingAgentSessionEvents(env)).toEqual({ queued: 1 });
	while (messages.length) {
		expect(await handleAutomationEventMessage(env, messages.shift())).toBe(
			"ack",
		);
	}
	expect(state.pending).toBe(0);
	expect(state.process).toHaveBeenCalledTimes(3);
	expect(send).toHaveBeenCalledTimes(3);
	expect(state.capture).toHaveBeenCalledWith(
		{ db: {}, userId: owner.userId },
		expect.objectContaining(owner),
	);
});

it("retries dispatch failure, rejects public producers, and never processes inactive or mismatched owners", async () => {
	const env = {
		AUTOMATION_EVENTS: { send: vi.fn() },
	} as unknown as CloudflareEnv;
	const body = { kind: "agent_session_events", ...owner };
	expect(AutomationEventSchema.safeParse(body).success).toBe(false);
	state.active = false;
	await processAgentSessionEventQueue(env, owner);
	state.active = true;
	await processAgentSessionEventQueue(env, { ...owner, userId: "user-other" });
	expect(state.process).not.toHaveBeenCalled();
	state.process.mockRejectedValue(new Error("D1 unavailable"));
	expect(await handleAutomationEventMessage(env, body)).toBe("retry");
	expect(
		await handleAutomationEventMessage(env, { ...body, userId: null }),
	).toBe("ack");
	await expect(
		enqueueAgentSessionEvents({} as CloudflareEnv, owner),
	).rejects.toThrow("queue unavailable");
});
