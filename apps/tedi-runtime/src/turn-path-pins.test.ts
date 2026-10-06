/**
 * The bespoke turn paths.
 *
 * 1. Sync-inject durability: the `/inject` handler and MCP `run_tedi_turn`
 *    share the durable workflow path, so a DO eviction/deploy mid-turn cannot
 *    lose a sync-injected reply.
 * 2. Dangling-turn telemetry: both turn entries probe for a prior
 *    never-settled user turn, fail-soft.
 * 3. Cross-session-bleed pin: the native WS prompt context stays
 *    HARNESS-OWNED — assembled via the session-filtered `buildContext`, never
 *    a comingled per-DO session.
 * 4. MCP trace continuity: the gateway trace survives ChatTurnWorkflow into
 *    facet setup, the ledger mirror and terminal failure mirroring.
 */
import assert from "node:assert/strict";
import {
	facetWorkflowTurnProbe,
	memoryStorage,
	nativeToolMarkers,
	tediDo,
	unitRuntimeAdmission,
	workflowImageBucketProbe,
} from "../test/tedi-do";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";

// --- 1: sync inject and MCP run_tedi_turn both dispatch durably ---
{
	const durable: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		env: {},
		name: "isolate-acme",
		state: { tediId: "tedi-1", orgId: "org-1", slug: "acme" },
		async ensureIdentity() {},
		async runDurableChatTurn(input: Record<string, unknown>) {
			durable.push(input);
			return {
				ok: true,
				run_id: "run-1",
				session_key: "main",
				assistant: null,
			};
		},
		computerWorkspace: () => ({ workspace: {} }),
		...nativeToolMarkers(),
	});
	const inject = await agent.onRequest(
		new Request("https://do.internal/__internal/inject", {
			method: "POST",
			body: JSON.stringify({
				text: "hello",
				client_request_id: "req-1",
				trace_id: "trace-1",
				learning_mode: "disabled",
			}),
		}),
	);
	assert.equal(inject.status, 200);
	assert.equal(durable[0]?.traceId, "trace-1");
	assert.equal(durable[0]?.learningMode, "disabled");

	const mcp = await agent.onRequest(
		new Request("https://acme.tedi.tedix.dev/mcp", {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"Mcp-Method": "tools/call",
				"Mcp-Name": "run_tedi_turn",
				"X-Trace-Id": "trace-2",
				"Mcp-Protocol-Version": "2026-07-28",
				[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
					method: "service",
					principalId: "service-1",
					principalType: "service",
					scopes: ["tedi:admin"],
				}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "run_tedi_turn",
					arguments: {
						session_key: "main",
						text: "hello from mcp",
						client_request_id: "req-2",
					},
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": {
							name: "test",
							version: "1",
						},
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		}),
	);
	assert.equal(mcp.status, 200, await mcp.clone().text());
	assert.equal(durable[1]?.text, "hello from mcp");
	assert.equal(durable[1]?.traceId, "trace-2");
}

// --- 1 + 4: the durable turn records its context before dispatch, carries
//     the trace and learning mode into the workflow, and acknowledges. ---
function durableProbe(
	options: {
		storageFails?: boolean;
		contextFails?: boolean;
		images?: unknown[];
		bucket?: unknown;
	} = {},
) {
	const storage = memoryStorage();
	if (options.storageFails)
		storage.put = async () => {
			throw new Error("storage unavailable");
		};
	const put = storage.put.bind(storage);
	if (options.contextFails)
		storage.put = async (key, value) => {
			if (options.contextFails && key.startsWith("wfctx:"))
				throw new Error("dispatch context unavailable");
			return put(key, value);
		};
	const dispatched: Array<Record<string, unknown>> = [];
	const events: string[] = [];
	const dangling: string[] = [];
	const agent = tediDo({
		env: {
			TEDI_STORAGE: options.bucket,
			CHAT_TURN_WORKFLOW: {
				get: async () => {
					throw new Error("(instance.not_found)");
				},
			},
		},
		async resolveAttachmentTurn(text: string) {
			return { content: text, images: options.images ?? [] };
		},
		name: "isolate-acme",
		state: { tediId: "tedi-1", orgId: "org-1", slug: "acme" },
		ctx: { storage },
		async ensureIdentity() {},
		logDanglingTurnIfAny(_sessionKey: string, surface: string) {
			dangling.push(surface);
		},
		sessionRepo: { findTurnByIdempotencyKey: () => null },
		async schedule() {
			return { id: "watchdog" };
		},
		async runWorkflow(_name: string, params: Record<string, unknown>) {
			dispatched.push(params);
		},
		async getPlatformClient() {
			return {
				async recordRuntimeEvent(event: { kind: string }) {
					events.push(event.kind);
				},
			};
		},
	});
	return { agent, storage, dispatched, events, dangling };
}
{
	const probe = durableProbe();
	const receipt = await probe.agent.runDurableChatTurn({
		sessionKey: "main",
		text: "hello",
		clientRequestId: "req-1",
		traceId: "trace-1",
		learningMode: "disabled",
	});
	assert.equal(receipt.pending, true);
	assert.equal(probe.dispatched[0]?.traceId, "trace-1");
	assert.equal(probe.dispatched[0]?.learningMode, "disabled");
	const [context] = [...probe.storage.data.entries()].filter(([key]) =>
		key.startsWith("wfctx:"),
	);
	assert.ok(context);
	assert.equal((context[1] as { traceId?: string }).traceId, "trace-1");
	assert.ok(probe.events.length > 0, "the queued turn is recorded");
	assert.deepEqual(probe.dangling, ["runDurableChatTurn"]);
}
{
	const probe = durableProbe({ storageFails: true });
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "hello",
			clientRequestId: "req-1",
		}),
		/storage unavailable/,
	);
	assert.deepEqual(
		probe.dispatched,
		[],
		"an untrackable workflow never starts",
	);
}
{
	// The workflow turn binds the trace into facet setup and the ledger mirror.
	const prepared: Array<Record<string, unknown>> = [];
	const probe = facetWorkflowTurnProbe({
		fields: {
			async prepareMcpFacetTurn(input: Record<string, unknown>) {
				prepared.push(input);
				return { system: "SYSTEM", tools: {}, turnBinding: null };
			},
		},
	});
	await probe.run({ traceId: "trace-9" });
	assert.equal(prepared[0]?.traceId, "trace-9");
	assert.equal(probe.commits[0]?.traceId, "trace-9");

	const mirrored: Array<Record<string, unknown>> = [];
	const commit = tediDo({
		ctx: { storage: memoryStorage() },
		mcpRuntime: null,
		async ensureIdentity() {},
		sessionHarness: { appendTurn: async () => true },
		broadcast() {},
		toolCallRefsForRun: () => [],
		toolExecutionEvidenceForRun: () => [],
		async onLedgerMirror(payload: Record<string, unknown>) {
			mirrored.push(payload);
		},
		async dispatchTurnMemoryEffects() {},
		enqueueCompaction() {},
	});
	await commit.commitAssistantTurnImpl({
		sessionKey: "main",
		runId: "run-1",
		traceId: "trace-9",
		conversationId: "conversation",
		userTs: 1,
		userText: "hello",
		assistantText: "done",
		stopReason: "stop",
		toolCalls: [],
	});
	assert.equal(mirrored[0]?.traceId, "trace-9");

	// Terminal failure mirroring keeps the retained trace.
	const failed: Array<Record<string, unknown>> = [];
	const failure = tediDo({
		ctx: {
			storage: memoryStorage({
				"wfctx:wf-1": {
					runId: "run-1",
					traceId: "trace-9",
					sessionKey: "main",
					userText: "hello",
					userTs: 1,
				},
			}),
		},
		sessionHarness: { appendTurn: async () => true },
		async mirrorFailedTurn(input: Record<string, unknown>) {
			failed.push(input);
		},
		async clearWorkflowDispatch() {},
	});
	await failure.mirrorWorkflowFailure("wf-1", "boom", "It failed.");
	assert.equal(failed[0]?.traceId, "trace-9");
}

// --- 2: the workflow execution also probes dangling turns, fail-soft ---
{
	const surfaces: string[] = [];
	const probe = facetWorkflowTurnProbe({
		fields: {
			logDanglingTurnIfAny(_sessionKey: string, surface: string) {
				surfaces.push(surface);
			},
		},
	});
	await probe.run({});
	assert.deepEqual(surfaces, ["facetWorkflowTurn"]);

	// The probe reads only the recent-window cache and never throws.
	tediDo({
		env: {},
		state: {},
		sessionRepo: {
			listTurns() {
				throw new Error("cache unavailable");
			},
		},
	}).logDanglingTurnIfAny("main", "facetWorkflowTurn");
}

// Native ACP admission, immutable input and stream resume are exercised in the
// actual Pi ConversationFacet workerd lane.

console.log("turn-path-pins OK");

// Legal data URIs larger than the Workflow payload limit never enter params.
{
	const images = [
		{
			kind: "url",
			data: `data:image/png;base64,${Buffer.alloc(1024 * 1024).toString("base64")}`,
			mediaType: "image/png",
			fileName: "large.png",
		},
	];
	const store = workflowImageBucketProbe();
	const probe = durableProbe({ images, bucket: store.bucket });
	await probe.agent.runDurableChatTurn({
		sessionKey: "main",
		text: "inspect",
		clientRequestId: "image-request",
	});
	const params = probe.dispatched[0]!;
	assert.ok(JSON.stringify(params).length < 2048);
	assert.equal("images" in params, false);
	const refs = params.imageRefs as Array<{ key: string; sha256: string }>;
	assert.equal(refs.length, 1);
	assert.ok(refs[0]!.key.startsWith("__runtime/workflow-images/tedi-1/"));
	assert.ok(store.objects.size > 0);
	// An elapsed retry must retain the original descriptor and avoid a second dispatch.
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(Date.now() > Number(params.userTs));
	const retried = await probe.agent.runDurableChatTurn({
		sessionKey: "main",
		text: "inspect",
		clientRequestId: "image-request",
	});
	assert.equal(retried.pending, true);
	assert.equal(
		probe.dispatched.length,
		1,
		"same original retry never dispatches twice",
	);
	assert.deepEqual(probe.dispatched[0]?.imageRefs, refs);
	const originalDispatch = [...probe.storage.data.entries()].find(([key]) =>
		key.startsWith("runtime-admission-workflow:"),
	)?.[1] as { params: Record<string, unknown> };
	assert.equal(originalDispatch.params.userTs, params.userTs);
	assert.deepEqual(originalDispatch.params.imageRefs, refs);
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "changed input",
			clientRequestId: "image-request",
		}),
		/Unit accepted input changed/,
	);
	const failed = durableProbe({
		images,
		bucket: {
			get: async () => null,
			put: async () => {
				throw new Error("R2 unavailable");
			},
		},
	});
	await assert.rejects(
		failed.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "inspect",
			clientRequestId: "failed-image",
		}),
		/R2 unavailable/,
	);
	assert.deepEqual(
		failed.dispatched,
		[],
		"image persistence fails closed before native admission",
	);
}

// Original input presence survives concurrent first dispatch and retries.
{
	const storage = memoryStorage();
	const agent = tediDo({
		ctx: { storage },
		state: { tediId: "tedi-1", orgId: "org-1" },
	});
	const claims = await Promise.allSettled([
		agent
			.imageCleanupJournal()
			.withRun("race", () =>
				agent.imageCleanupJournal().claim("race", "workflow-race", [], "main"),
			),
		agent
			.imageCleanupJournal()
			.withRun("race", () =>
				agent.imageCleanupJournal().claim("race", "other-workflow", [], "main"),
			),
	]);
	assert.equal(
		claims.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.equal(
		claims.filter((result) => result.status === "rejected").length,
		1,
	);
	assert.deepEqual(storage.data.get("wfimages:race"), {
		hasImages: false,
		workflowInstanceId: "workflow-race",
		refs: [],
	});
	const images: unknown[] = [];
	const store = workflowImageBucketProbe();
	const probe = durableProbe({ images, bucket: store.bucket });
	await probe.agent.runDurableChatTurn({
		sessionKey: "main",
		text: "hello",
		clientRequestId: "original-text",
	});
	assert.equal(
		store.objects.size,
		0,
		"ordinary text dispatch does no R2 writes",
	);
	images.push({
		kind: "base64",
		data: "aGk=",
		mediaType: "image/png",
		fileName: "image.png",
	});
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "hello",
			clientRequestId: "original-text",
		}),
		/workflow_image_conflict/,
	);
	assert.equal(probe.dispatched.length, 1);
	await probe.agent.runDurableChatTurn({
		sessionKey: "main",
		text: "hello",
		clientRequestId: "original-image",
	});
	images.splice(0);
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "hello",
			clientRequestId: "original-image",
		}),
		/workflow_image_conflict/,
	);
	assert.equal(probe.dispatched.length, 2);
	images.push({
		kind: "base64",
		data: "Ynk=",
		mediaType: "image/png",
		fileName: "image.png",
	});
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "hello",
			clientRequestId: "original-image",
		}),
		/workflow_image_conflict/,
	);
	assert.equal(
		probe.dispatched.length,
		2,
		"changed bytes never reach an existing run",
	);
}

// The original leak: successful R2 persistence followed by failed dispatch-context storage.
{
	const store = workflowImageBucketProbe();
	const options = {
		contextFails: true,
		images: [
			{
				kind: "base64",
				data: "aGk=",
				mediaType: "image/png",
				fileName: "image.png",
			},
		],
		bucket: store.bucket,
	};
	const probe = durableProbe(options);
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "inspect",
			clientRequestId: "context-failure",
		}),
		/durable context unavailable/,
	);
	assert.equal(probe.dispatched.length, 0);
	assert.equal(
		store.objects.size,
		2,
		"partial admission retains private objects for safe retry or recovery",
	);
	assert.equal((await probe.agent.imageCleanupJournal().redrive()).cleaned, 1);
	assert.equal(
		store.objects.size,
		0,
		"existing wake repairs predispatch leak without native execution",
	);
	options.contextFails = false;
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "inspect",
			clientRequestId: "context-failure",
		}),
		(error: unknown) => {
			assert.match(
				String((error as Error).cause),
				/workflow_image_cleanup_already_started/,
			);
			return true;
		},
	);
	assert.equal(probe.dispatched.length, 0);
	assert.equal(
		store.objects.size,
		0,
		"completed cleanup cannot reopen the original upload",
	);
	await probe.agent.runDurableChatTurn({
		sessionKey: "main",
		text: "inspect",
		clientRequestId: "context-failure-new-operation",
	});
	assert.equal(
		probe.dispatched.length,
		1,
		"a distinct admitted operation can upload and dispatch after prior cleanup",
	);
	assert.equal(store.objects.size, 2);
}

// Unit-double conformance only: this is not native custody or durable proof.
{
	const owner = { tediId: "unit-tedi", orgId: "unit-org" };
	const admission = unitRuntimeAdmission(owner);
	const input = {
		runId: "original",
		sessionKey: "main",
		principalId: owner.tediId,
		input: { text: "original" },
		expectedGeneration: 1,
	};
	const { accepted } = await admission.beginAcceptedTurn(input);
	const claim = {
		turnId: accepted.runId,
		requestHash: accepted.requestHash,
		generation: accepted.generation,
	};
	assert.deepEqual(accepted.owner, owner);
	assert.equal(
		tediDo({ state: { tediId: "explicit-no-org" } }).runtimeAdmission().owner
			.orgId,
		null,
		"no invented organization",
	);
	admission.gate.assertTurn(claim);
	for (const changed of [
		{ ...claim, turnId: "unknown" },
		{ ...claim, requestHash: "0".repeat(64) },
		{ ...claim, generation: 2 },
	])
		assert.throws(
			() => admission.gate.assertTurn(changed),
			/inactive or changed/,
		);
	await assert.rejects(
		admission.beginAcceptedTurn({ ...input, input: { text: "changed" } }),
		/accepted input changed/,
	);
	await assert.rejects(
		admission.assertOriginalClaim({
			runId: input.runId,
			principalId: "foreign",
		}),
		/identity changed or missing/,
	);
	await assert.rejects(
		admission.assertOriginalClaim({
			runId: input.runId,
			inputHash: "0".repeat(64),
		}),
		/identity changed or missing/,
	);
	assert.throws(
		() => admission.gate.completeTurn(claim),
		/lacks original receipt/,
	);
	const receipt = {
		sourceId: "actual-original-ack",
		receipt: { keys: ["original-image"], truncated: false },
	};
	admission.gate.quarantine();
	assert.throws(() => admission.gate.assertTurn(claim), /inactive or changed/);
	await admission.recordTerminalReceipt(input.runId, receipt);
	await admission.recordTerminalReceipt(input.runId, receipt);
	await assert.rejects(
		admission.recordTerminalReceipt(input.runId, {
			...receipt,
			sourceId: "changed",
		}),
		/receipt changed/,
	);
	admission.gate.completeTurn(claim);
	assert.throws(() => admission.gate.assertTurn(claim), /inactive or changed/);
	await admission.assertOriginalClaim({
		runId: input.runId,
		input: input.input,
	});
	const active = unitRuntimeAdmission(owner),
		next = await active.beginAcceptedTurn(input);
	await active.recordTerminalReceipt(input.runId, receipt);
	active.gate.completeTurn({
		...claim,
		requestHash: next.accepted.requestHash,
	});
	assert.throws(() => active.gate.assertTurn(claim), /inactive or changed/);
	const pending = unitRuntimeAdmission(owner),
		starting = pending.beginAcceptedTurn(input);
	pending.gate.quarantine();
	await assert.rejects(starting, /inactive/);
}

// The source storage double reads the same live facts at async and final sync boundaries.
{
	const storage = memoryStorage();
	await storage.put("owner", { generation: 1 });
	assert.deepEqual(storage.kv.get("owner"), { generation: 1 });
	storage.kv.put("owner", { generation: 2 });
	assert.deepEqual(await storage.get("owner"), { generation: 2 });
	assert.equal(storage.kv.delete("owner"), true);
	assert.equal(await storage.get("owner"), undefined);
	await storage.put("other", true);
	assert.equal(storage.kv.list({ prefix: "owner" }).size, 0);
}
// Revocation during the actual manifest-read await denies the first upload;
// all probes retain explicit immutable original and cleanup claims.
for (const revoke of ["canceled", "quarantined", "owner_changed"] as const) {
	const store = workflowImageBucketProbe();
	const probe = durableProbe({
		images: [
			{
				kind: "base64",
				data: "aGk=",
				mediaType: "image/png",
				fileName: "image.png",
			},
		],
		bucket: store.bucket,
	});
	const originalGet = store.bucket.get;
	store.bucket.get = async (...args) => {
		const result = await originalGet(...args);
		const [key, row] = [...probe.storage.data.entries()].find(([key]) =>
			key.startsWith("workflow-image-cleanup:"),
		)!;
		const cleanup = row as { runId: string; orgId: string };
		if (revoke === "canceled")
			probe.storage.kv.put(`wfcancel:${cleanup.runId}`, true);
		else if (revoke === "quarantined")
			probe.agent.runtimeAdmission().gate.quarantine();
		else probe.storage.kv.put(key, { ...cleanup, orgId: "foreign-org" });
		return result;
	};
	await assert.rejects(
		probe.agent.runDurableChatTurn({
			sessionKey: "main",
			text: "inspect",
			clientRequestId: `revoked-${revoke}`,
		}),
		/canceled|inactive|identity changed|owner|ownership/,
	);
	assert.equal(store.objects.size, 0, `${revoke}: no upload after revocation`);
	assert.equal(probe.dispatched.length, 0);
}
