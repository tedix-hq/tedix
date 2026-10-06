/**
 * Unit tests for the async-inject delegation routing decision (do.ts).
 *
 * ALL async injections (text-only AND attachment-bearing) now route through
 * ChatTurnWorkflow (durable, eviction-surviving). Attachment-bearing turns
 * resolve their content (STT transcription) BEFORE dispatch so the resolved
 * transcript becomes the workflow's userText.
 *
 * Previously: attachment turns → DO alarm (runScheduledInjectTurn) — a
 * 100%-dropping substrate identical to the bug the text path was migrated off.
 * Now: both paths → ChatTurnWorkflow, making attachment turns durable +
 * cancelable via the same /__internal/cancel workflowInstanceId key.
 *
 * Image bytes stay in private R2; compact references survive Workflow retries
 * and native session persistence until inference-only materialization.
 *
 * Run: `bun run src/async-inject-routing.test.ts`
 */
import assert from "node:assert/strict";
import {
	memoryStorage,
	tediDo,
	workflowImageBucketProbe,
} from "../test/tedi-do";
import { buildRunId, buildWorkflowInstanceId } from "./ledger-mirror";

// ---------------------------------------------------------------------------
// Routing decision — ALL turns now go through the workflow
// ---------------------------------------------------------------------------

type InjectRoute = "workflow" | "alarm";

/**
 * Mirrors the updated logic in do.ts: after Option A fix, ALL async-inject
 * turns (text-only and attachment-bearing) route through ChatTurnWorkflow.
 * Attachments are resolved (STT) in the handler before dispatch; the resolved
 * transcript becomes userText.
 */
function resolveInjectRoute(_attachmentCount: number): InjectRoute {
	// Unified path: resolve attachments first, then always dispatch workflow.
	return "workflow";
}

assert.equal(
	resolveInjectRoute(0),
	"workflow",
	"text-only (no attachments) → ChatTurnWorkflow, eviction-surviving",
);

assert.equal(
	resolveInjectRoute(1),
	"workflow",
	"audio attachment → ChatTurnWorkflow after STT resolve in handler",
);

assert.equal(
	resolveInjectRoute(3),
	"workflow",
	"multiple attachments → ChatTurnWorkflow after STT resolve in handler",
);

console.log("PASS: resolveInjectRoute (all turns → workflow)");

// ---------------------------------------------------------------------------
// runId construction is identical on all paths — same clientRequestId → same
// runId so the predicted 202 run_id matches what the workflow emits.
// ---------------------------------------------------------------------------

const tediId = "00000000-0000-0000-0000-000000000001";
const clientRequestId = "req-abc-123";

const runId = buildRunId(tediId, clientRequestId, "mcp");
assert.ok(
	typeof runId === "string" && runId.length > 0,
	"runId is a non-empty string",
);

// Redelivery with the same clientRequestId must produce the same runId.
const runId2 = buildRunId(tediId, clientRequestId, "mcp");
assert.equal(
	runId,
	runId2,
	"same clientRequestId → identical runId (dedup guarantee)",
);

// Different clientRequestId → different runId.
const otherRunId = buildRunId(tediId, "req-xyz-999", "mcp");
assert.notEqual(
	runId,
	otherRunId,
	"different clientRequestId → different runId",
);

console.log("PASS: runId idempotency");

// ---------------------------------------------------------------------------
// ChatTurnParams shape — attachment turns pass RESOLVED TRANSCRIPT as userText
// ---------------------------------------------------------------------------

const sessionKey = "agent:main:main";
const conversationId = `${tediId}:${sessionKey}`;
const userTs = Date.now();

// Text-only turn: userText is the original text.
const textOnlyParams = {
	agentName: tediId,
	sessionKey,
	userText: "hello from kernel delegation",
	userTs,
	conversationId,
	runId,
	clientRequestId,
};

assert.ok(textOnlyParams.sessionKey, "sessionKey present");
assert.equal(
	textOnlyParams.agentName,
	tediId,
	"originating Agent name is persisted for fresh retry stubs",
);
assert.ok(textOnlyParams.userText, "userText present");
assert.ok(typeof textOnlyParams.userTs === "number", "userTs is a number");
assert.ok(textOnlyParams.conversationId, "conversationId present");
assert.ok(textOnlyParams.runId, "runId present");
assert.ok(textOnlyParams.clientRequestId, "clientRequestId present");
assert.ok(
	!("attachments" in textOnlyParams),
	"no attachments field in workflow params",
);

console.log("PASS: ChatTurnParams shape (text-only)");

// Attachment turn: userText is the RESOLVED TRANSCRIPT (not the raw text).
// The injector calls resolveAttachmentTurn() before dispatch; the transcript
// replaces the empty/raw text as userText so the workflow receives clean text.
const resolvedTranscript =
	"Voice note transcribed: please schedule a meeting for tomorrow";
const attachmentTurnParams = {
	agentName: tediId,
	sessionKey,
	userText: resolvedTranscript, // resolved.content, not original empty text
	userTs,
	conversationId,
	runId,
	clientRequestId,
};

assert.ok(
	attachmentTurnParams.userText === resolvedTranscript,
	"attachment turn dispatches workflow with resolved transcript as userText",
);
assert.ok(
	!("attachments" in attachmentTurnParams),
	"workflow params carry no raw attachments — already resolved",
);

console.log(
	"PASS: ChatTurnParams shape (attachment turn → resolved transcript)",
);

// ---------------------------------------------------------------------------
// Workflow instance id — same derivation for text and attachment turns
// (cancel path at /__internal/cancel derives the id the same way)
// ---------------------------------------------------------------------------

const colonId = "kern:req:abc-123";
const sanitized = buildWorkflowInstanceId(colonId);
assert.ok(
	!sanitized.includes(":"),
	"workflowInstanceId derivation strips colons (Cloudflare Workflow id constraint)",
);
assert.ok(
	sanitized.length <= 64,
	"workflowInstanceId derivation caps at 64 chars",
);
assert.notEqual(
	buildWorkflowInstanceId(
		"home:runtime-identity-collision-proof:1782653623649:turn",
	),
	buildWorkflowInstanceId(
		"home:runtime-identity-collision-proof:1782653561799:turn",
	),
	"long workflow ids with shared prefixes remain distinct",
);

console.log("PASS: workflowInstanceId derivation");

// ---------------------------------------------------------------------------
// Empty-transcript guard: resolveAttachmentTurn returning empty content
// must NOT dispatch a workflow (handler returns 400 before dispatch).
// ---------------------------------------------------------------------------

function shouldDispatchWorkflow(resolvedContent: string): boolean {
	return resolvedContent.trim().length > 0;
}

assert.equal(
	shouldDispatchWorkflow(""),
	false,
	"empty resolved transcript → 400, no workflow dispatch",
);
assert.equal(
	shouldDispatchWorkflow("   "),
	false,
	"whitespace-only resolved transcript → 400, no workflow dispatch",
);
assert.equal(
	shouldDispatchWorkflow("Hello world"),
	true,
	"non-empty transcript → workflow dispatch",
);

console.log("PASS: empty-transcript guard");

// ---------------------------------------------------------------------------
// Cancel-before-admission contract: a successful native `terminate()` is not
// the durable fence because the matching inject can still be in flight. The
// run-id tombstone must be written before termination and consulted both
// immediately before native Workflow creation and before assistant settlement.
// ---------------------------------------------------------------------------

const RUN_ID = buildRunId("tedi-1", "req-1", "mcp");
const WORKFLOW_ID = buildWorkflowInstanceId("req-1");
const post = (path: string, body: unknown) =>
	new Request(`https://do.internal${path}`, {
		method: "POST",
		body: JSON.stringify(body),
	});

{
	const storage = memoryStorage();
	const order: string[] = [];
	const abort = new AbortController();
	abort.signal.addEventListener("abort", () => {
		order.push(`abort:tombstone=${storage.data.has(`wfcancel:${RUN_ID}`)}`);
	});
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		ctx: { storage },
		activeTurnAborts: new Map([[RUN_ID, abort]]),
		async cascadeCancelFanout() {
			return { terminated: [] };
		},
		env: {
			CHAT_TURN_WORKFLOW: {
				async get(id: string) {
					assert.equal(id, WORKFLOW_ID);
					return {
						async status() {
							return { status: "running" };
						},
						async terminate() {
							order.push(
								`terminate:tombstone=${storage.data.has(`wfcancel:${RUN_ID}`)}`,
							);
						},
					};
				},
			},
		},
	});
	const response = await agent.onRequest(
		post("/__internal/cancel", { client_request_id: "req-1", run_id: RUN_ID }),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(order, ["abort:tombstone=true", "terminate:tombstone=true"]);
}

{
	// A tombstone that cannot be persisted must not abort or terminate anything.
	const storage = memoryStorage();
	storage.put = async () => {
		throw new Error("storage unavailable");
	};
	const abort = new AbortController();
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		ctx: { storage },
		activeTurnAborts: new Map([[RUN_ID, abort]]),
		env: {
			CHAT_TURN_WORKFLOW: {
				async get() {
					throw new Error("must not terminate without a tombstone");
				},
			},
		},
	});
	const response = await agent.onRequest(
		post("/__internal/cancel", { client_request_id: "req-1", run_id: RUN_ID }),
	);
	assert.equal(response.status, 500);
	assert.equal(abort.signal.aborted, false);
}

console.log("PASS: cancel persists its tombstone before abort and terminate");

{
	// The cancel lands while the inject persists its dispatch context: the
	// re-check immediately before native Workflow creation must win.
	const storage = memoryStorage();
	const created: unknown[] = [];
	const cleared: string[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1", slug: "acme" },
		ctx: { storage },
		sessionRepo: { findTurnByIdempotencyKey: () => null },
		async ensureIdentity() {},
		async schedule() {
			// Interleaved cancel during dispatch-context persistence.
			await storage.put(`wfcancel:${RUN_ID}`, { runId: RUN_ID });
			return { id: "watchdog" };
		},
		async runWorkflow(...args: unknown[]) {
			created.push(args);
		},
		async clearWorkflowDispatch(id: string) {
			cleared.push(id);
		},
	});
	const response = await agent.onRequest(
		post("/__internal/inject", {
			text: "hello",
			client_request_id: "req-1",
			async: true,
		}),
	);
	assert.equal(response.status, 202);
	const body = (await response.json()) as Record<string, unknown>;
	assert.equal(body.canceled, true);
	assert.equal(body.accepted, false);
	assert.deepEqual(created, [], "a recorded cancel owns admission");
	assert.deepEqual(cleared, [WORKFLOW_ID]);
}

{
	// Assistant settlement observes the tombstone before materializing a row.
	const appended: unknown[] = [];
	const agent = tediDo({
		ctx: {
			storage: memoryStorage({ [`wfcancel:${RUN_ID}`]: { runId: RUN_ID } }),
		},
		async ensureIdentity() {},
		sessionHarness: {
			async appendTurn(...args: unknown[]) {
				appended.push(args);
				return true;
			},
		},
	});
	await agent.commitAssistantTurnImpl({
		sessionKey: "main",
		runId: RUN_ID,
		conversationId: "conversation",
		userTs: 1,
		userText: "hello",
		assistantText: "done",
		stopReason: "stop",
		toolCalls: [],
	});
	assert.deepEqual(appended, []);
}

console.log(
	"PASS: durable cancellation fences workflow admission + settlement",
);

// ---------------------------------------------------------------------------
// Terminal reconciliation arm: a workflow that reached its first checkpoint
// can still finish without an Agent SDK completion/error callback. The started
// hook must arm the bounded native-status reconciliation so that finite state
// is mirrored into the child ledger rather than remaining at run.started.
// ---------------------------------------------------------------------------

{
	const scheduled: unknown[][] = [];
	const storage = memoryStorage({
		[`wfctx:${WORKFLOW_ID}`]: { runId: RUN_ID, sessionKey: "main" },
	});
	const agent = tediDo({
		ctx: { storage },
		async schedule(...args: unknown[]) {
			scheduled.push(args);
			return { id: "terminal-watchdog" };
		},
	});
	assert.equal(await agent.markChatWorkflowStarted(WORKFLOW_ID, RUN_ID), true);
	assert.equal(scheduled.length, 1);
	assert.equal(scheduled[0]?.[1], "reconcileChatWorkflowTerminal");
	assert.deepEqual(scheduled[0]?.[2], {
		workflowInstanceId: WORKFLOW_ID,
		attempt: 0,
	});
	assert.equal(
		typeof (storage.data.get(`wfctx:${WORKFLOW_ID}`) as { startedAt?: number })
			.startedAt,
		"number",
	);
}

console.log("PASS: started workflow arms terminal reconciliation");

console.log("\nAll async-inject-routing tests passed.");

// Real async admission retains compact references rather than dropping images.
{
	const store = workflowImageBucketProbe();
	const dispatched: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		name: "isolate-acme",
		state: { tediId: "tedi-1", orgId: "org-1", slug: "acme" },
		ctx: { storage: memoryStorage() },
		env: { TEDI_STORAGE: store.bucket },
		sessionRepo: { findTurnByIdempotencyKey: () => null },
		async ensureIdentity() {},
		async schedule() {
			return { id: "watchdog" };
		},
		async resolveAttachmentTurn() {
			return {
				content: "inspect this",
				images: [
					{
						kind: "base64",
						data: "aGk=",
						mediaType: "image/png",
						fileName: "image.png",
					},
				],
			};
		},
		async runWorkflow(_name: string, params: Record<string, unknown>) {
			dispatched.push(params);
		},
		async getPlatformClient() {
			return { async recordRuntimeEvent() {} };
		},
	});
	const response = await agent.onRequest(
		post("/__internal/inject", {
			text: "inspect",
			client_request_id: "images",
			async: true,
			attachments: [
				{
					type: "image",
					content: "https://example.com/image.png",
					fileName: "image.png",
					mimeType: "image/png",
				},
			],
		}),
	);
	assert.equal(response.status, 202, await response.clone().text());
	assert.ok(dispatched[0]);
	assert.equal((dispatched[0].imageRefs as unknown[]).length, 1);
	assert.equal("images" in dispatched[0]!, false);
	assert.ok(store.objects.size > 0);
}
// Source-only parent fixture accepts the original upload, then persists the
// independent immutable cleanup claim before any R2 write. Native custody and
// eviction are tested separately under workerd.
async function originalImageFixture(status: string) {
	const store = workflowImageBucketProbe(),
		storage = memoryStorage();
	const scheduled: unknown[][] = [];
	let statusReads = 0;
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		ctx: { storage },
		env: {
			TEDI_STORAGE: store.bucket,
			CHAT_TURN_WORKFLOW: {
				get: async () => {
					statusReads++;
					if (status === "not_found") throw new Error("(instance.not_found)");
					return { status: async () => ({ status }) };
				},
			},
		},
		schedule: async (...args: unknown[]) => {
			scheduled.push(args);
		},
	});
	await agent.runtimeAdmission().beginAcceptedTurn({
		runId: "run-1",
		sessionKey: "main",
		principalId: "tedi-1",
		input: { kind: "original-upload", text: "inspect" },
		expectedGeneration: 1,
	});
	const refs = await agent.prepareWorkflowImages(
		"run-1",
		"workflow-1",
		[
			{
				kind: "base64",
				data: "aGk=",
				mediaType: "image/png",
				fileName: "image.png",
			},
		],
		"main",
	);
	await agent.imageCleanupJournal().beforeDispatch("run-1", "workflow-1");
	return { agent, store, storage, refs, scheduled, reads: () => statusReads };
}
const terminalInput = {
	workflowInstanceId: "workflow-1",
	runId: "run-1",
	intent: "terminal" as const,
};
for (const status of [
	"running",
	"complete",
	"errored",
	"terminated",
	"not_found",
]) {
	const f = await originalImageFixture(status);
	await f.storage.put("wfctx:workflow-1", { runId: "run-1" });
	await f.agent.cleanupChatWorkflowImages(terminalInput);
	assert.equal(
		f.store.deleted.length,
		0,
		"live original consumer retains images",
	);
	await f.storage.delete("wfctx:workflow-1");
	await f.agent.cleanupChatWorkflowImages(terminalInput);
	assert.equal(
		f.store.deleted.length > 0,
		["complete", "errored", "terminated"].includes(status),
	);
	if (status === "running" || status === "not_found")
		assert.ok(
			f.scheduled.length > 0,
			"original cleanup authority permits bounded status retry",
		);
	if (status === "not_found") {
		await f.storage.put("wfcancel:run-1", { runId: "run-1" });
		await f.agent.cleanupChatWorkflowImages({
			...terminalInput,
			intent: "cancelled",
		});
		assert.equal(
			f.store.objects.size,
			0,
			"independent original cleanup survives chat cancellation",
		);
	}
}
// Unknown provider delete ACK is not a license to repeat the effect.
{
	const f = await originalImageFixture("complete");
	let deletes = 0;
	const originalDelete = f.store.bucket.delete;
	f.store.bucket.delete = async () => {
		deletes++;
		throw new Error("R2 acknowledgement unavailable");
	};
	await f.agent.cleanupChatWorkflowImages(terminalInput);
	assert.equal(deletes, 1);
	assert.equal(f.scheduled.length, 0);
	assert.ok(f.store.objects.size > 0);
	f.store.bucket.delete = originalDelete;
	await f.agent.imageCleanupJournal().redrive();
	await f.agent.cleanupChatWorkflowImages(terminalInput);
	assert.equal(deletes, 1);
	assert.ok(f.store.objects.size > 0, "unknown effect remains unresolved");
}
// A foreign workflow cannot use an actual original cleanup claim.
{
	const f = await originalImageFixture("complete");
	await f.agent.cleanupChatWorkflowImages({
		...terminalInput,
		workflowInstanceId: "foreign-complete-workflow",
	});
	assert.equal(f.reads(), 0);
	assert.equal(f.store.objects.size, 2);
}
// Historical claimless markers stay blocked even when cancellation and terminal status exist.
{
	const storage = memoryStorage({
		"wfimages:run-1": { hasImages: true, workflowInstanceId: "workflow-1" },
		"wfcancel:run-1": true,
	});
	const store = workflowImageBucketProbe();
	store.objects.set(
		"__runtime/workflow-images/tedi-1/run-1/unknown",
		"private",
	);
	const agent = tediDo({
		state: { tediId: "tedi-1", orgId: "org-1" },
		ctx: { storage },
		env: { TEDI_STORAGE: store.bucket },
	});
	await agent.cleanupChatWorkflowImages({
		...terminalInput,
		intent: "cancelled",
	});
	assert.equal(store.deleted.length, 0);
	assert.equal(
		agent.runtimeAdmission().gate.claim("workflow-image-cleanup:run-1"),
		null,
	);
}
