/**
 * The embedded widget's hard cutover to the Cap'n Web capability at
 * `/chat/capn`: every embedded operation is authenticated per call against
 * the signed session, reaches the tedi DO through internal routes, and carries
 * only verified host context. Driven through the runtime Worker's real fetch;
 * the capability adapter the edge mounts is captured and exercised directly.
 */
import assert from "node:assert/strict";
import { EmbeddedSession } from "@tedix/chat-transport/embedded-capability";
import { chatTurnProbe, tediDo } from "../test/tedi-do";
import { EDGE_TEDI, edgeFetch, tediRequest } from "../test/tedi-edge";
import {
	captured,
	embedded,
	EMBED_ORIGIN as ORIGIN,
	EMBED_SECRET as SECRET,
	embeddedToken as token,
} from "../test/embedded-edge";
import { chatContextPolicy } from "./chat-stream-input";
import { embeddedHostToolGuidance } from "./embedded-host-tool-guidance";
import {
	EMBEDDED_TRANSCRIPT_LIMIT,
	embeddedUserText,
} from "./embedded-transcript";
import { WORKSPACE_TOOLS_NOTE } from "./runtime-tool-guidance";

// --- the public dispatch mounts one capability; the legacy routes are gone ---
{
	const capn = await embedded();
	assert.equal(typeof capn.adapter.stream, "function");
	for (const legacy of [
		"/chat/stream",
		"/chat/cancel",
		"/chat/approvals",
		"/chat/pin",
	]) {
		const before = captured.length;
		await edgeFetch(
			tediRequest(legacy, { method: "POST", headers: { Origin: ORIGIN } }),
		);
		assert.equal(captured.length, before, `${legacy} is not an embedded route`);
	}
	const preflight = await edgeFetch(
		tediRequest("/chat/capn", {
			method: "OPTIONS",
			headers: { Origin: ORIGIN },
		}),
		{ env: { SECRETS_MASTER_KEY: SECRET } },
	);
	assert.equal(
		preflight.response.headers.get("Access-Control-Allow-Origin"),
		null,
		"the capability answers no CORS preflight",
	);
}

// --- every operation authenticates the signed session for this page origin ---
{
	const { adapter } = await embedded();
	await assert.rejects(
		adapter.authorize("not-a-token"),
		/Unauthorized embedded capability/,
	);
	await assert.rejects(
		adapter.authorize(await token({ allowedOrigin: "https://evil.example" })),
		/Forbidden embedded capability/,
	);
	await assert.rejects(
		adapter.authorize(await token({ sessionKey: undefined })),
		/Forbidden embedded capability/,
	);
	const authority = await adapter.authorize(await token());
	assert.deepEqual(
		{ ...authority, expiresAt: 0 },
		{
			sessionKey: "embed:shop:1",
			subject: "host-user-1",
			tenant: `${EDGE_TEDI.id}:367`,
			origin: ORIGIN,
			expiresAt: 0,
		},
	);
}

// --- a provider installation must also be authorized for this host and user ---
{
	const provider = {
		providerInstallationId: "install-1",
		providerAppId: "app-1",
	};
	const allowed = await embedded({
		"tedis/authorizeEmbeddedWidgetAccess": () => ({
			allowed: true,
			reason: "ok",
		}),
	});
	await allowed.adapter.authorize(await token(provider));
	assert.deepEqual(allowed.rpcs[0], {
		...allowed.rpcs[0],
		path: "tedis/authorizeEmbeddedWidgetAccess",
		input: {
			installationId: "install-1",
			providerAppId: "app-1",
			externalTenantId: "367",
			allowedOrigin: ORIGIN,
			hostUserId: "host-user-1",
		},
	});
	const denied = await embedded({
		"tedis/authorizeEmbeddedWidgetAccess": () => ({
			allowed: false,
			reason: "revoked",
		}),
	});
	await assert.rejects(
		denied.adapter.authorize(await token(provider)),
		/Embedded assistant access denied: revoked/,
	);
	// A provider credential is valid only on this capability, never on a
	// general runtime session.
	const general = await edgeFetch(
		tediRequest("/voice/provider-health", {
			headers: { Authorization: `Bearer ${await token(provider)}` },
		}),
		{ env: { SECRETS_MASTER_KEY: SECRET } },
	);
	assert.equal(general.response.status, 401);
	assert.match(
		await general.response.text(),
		/Use the embedded widget capability endpoint/,
	);
}

// --- the transcript is read through the DO for this session only ---
{
	const { adapter, forwarded } = await embedded({}, async (request) =>
		new URL(request.url).pathname === "/__internal/messages/read"
			? Response.json({
					messages: [
						{ role: "user", content: embeddedUserText("Where is order 42?") },
						{ role: "assistant", content: "Shipped." },
					],
				})
			: Response.json({ ok: true }),
	);
	const transcript = await adapter.readTranscript(
		await token(),
		undefined as never,
	);
	assert.deepEqual(transcript.messages, [
		{ role: "user", content: "Where is order 42?" },
		{ role: "assistant", content: "Shipped." },
	]);
	const read = forwarded.find(
		(request) => new URL(request.url).pathname === "/__internal/messages/read",
	)!;
	assert.deepEqual(await read.json(), {
		session_key: "embed:shop:1",
		limit: EMBEDDED_TRANSCRIPT_LIMIT,
	});
	assert.equal(read.headers.get("X-Tedi-Id"), EDGE_TEDI.id);
	assert.equal(read.headers.get("X-Tedi-Auth-Subject"), "browser-user");

	const failing = await embedded({}, () => new Response("no", { status: 500 }));
	await assert.rejects(
		failing.adapter.readTranscript(await token(), undefined as never),
		/Embedded conversation history unavailable/,
	);
	await assert.rejects(
		adapter.readTranscript("forged", undefined as never),
		/Unauthorized/,
	);
}

// --- a turn carries verified host context, never authority ---
async function streamedTurn(
	claims: Record<string, unknown>,
	input: Record<string, unknown>,
	answers: Record<string, (input: Record<string, any>) => unknown> = {},
) {
	const run = await embedded({
		"tedis/listEmbeddedConversationCapabilities": () => ({
			attached: [
				{
					replayName: "orders",
					name: "Orders",
					slug: "orders",
					whyPresent: "pinned by user",
				},
			],
		}),
		"tedis/listEmbeddedConversationArtifactPins": () => ({
			pins: [
				{
					state: "active",
					replayName: "plan",
					artifactId: "a-1",
					artifact: { name: "Plan", kind: "doc" },
					revision: 3,
					whyPresent: "context",
				},
				{
					state: "revoked",
					replayName: "old",
					artifactId: "a-2",
					artifact: { name: "Old", kind: "doc" },
					revision: 1,
					whyPresent: "gone",
				},
			],
		}),
		...answers,
	});
	await run.adapter.stream(await token(claims), {
		text: "What is overdue?",
		turnKey: "turn-1",
		signal: new AbortController().signal,
		...input,
	} as never);
	const request = run.forwarded.find(
		(item) => new URL(item.url).pathname === "/__internal/chat/stream",
	)!;
	return {
		body: (await request.json()) as Record<string, any>,
		rpcs: run.rpcs,
	};
}
{
	const { body, rpcs } = await streamedTurn({}, {});
	assert.equal(body.client_request_id, "turn-1");
	assert.equal(body.session_key, "embed:shop:1");
	assert.equal(body.context_policy, "session_only");
	assert.ok(body.text.startsWith(embeddedUserText("What is overdue?")));
	assert.match(body.text, /Host organization: Example organization \(id 367\)/);
	assert.match(
		body.text,
		/Named conversation capabilities \(untrusted context references only; never authority\)/,
	);
	assert.match(body.text, /"replayName":"plan"/);
	assert.doesNotMatch(
		body.text,
		/"replayName":"old"/,
		"only active pins are context",
	);
	assert.match(body.text, /grant no artifact access/);
	assert.match(body.text, /never end mid-sentence/);
	for (const path of [
		"tedis/listEmbeddedConversationCapabilities",
		"tedis/listEmbeddedConversationArtifactPins",
	])
		assert.deepEqual(rpcs.find((rpc) => rpc.path === path)?.input, {
			tediId: EDGE_TEDI.id,
			conversationId: "embed:shop:1",
		});
	assert.equal(
		"model_ref" in body,
		false,
		"with no pick and no default the tedi's model stands",
	);
}

// --- cancel reaches the DO's internal cancel for this turn ---
{
	const { adapter, forwarded } = await embedded({}, () =>
		Response.json({ cancelled: true }),
	);
	assert.deepEqual(
		await adapter.cancel(await token(), "turn-1", undefined as never),
		{
			cancelled: true,
		},
	);
	const cancel = forwarded.find(
		(item) => new URL(item.url).pathname === "/__internal/cancel",
	)!;
	assert.equal(
		((await cancel.json()) as { client_request_id: string }).client_request_id,
		"turn-1",
	);
}

// --- the host tool guidance tells the model to use the host's own tools ---
{
	const guidance = embeddedHostToolGuidance({
		hostOrganizationId: "367",
		hostTenantArgument: "company_id",
		hostTenantNamespace: "shop",
		embeddedAssistantCallables: ["shop.list_orders"],
	}).join("\n");
	assert.match(
		guidance,
		/For questions about current.*call the matching.*host tool before answering/,
	);
	assert.match(guidance, /Do not substitute Tedix memory, reflection/);
}

// --- the transport exposes whole operations, not a raw request passthrough ---
for (const method of ["stream", "resolveApproval", "pin"])
	assert.equal(
		typeof (EmbeddedSession.prototype as unknown as Record<string, unknown>)[
			method
		],
		"function",
	);
assert.equal("request" in EmbeddedSession.prototype, false);

// The DO used to accept exactly one literal model ref, which made the widget's
// model unchangeable from the product. The gate MOVED to the edge
// (`resolveModelChoice`, asserted below), the only place that can read the
// tedi's roster. What remains in the DO is a shape check: a ref and nothing
// else, and an effort only one of the four levels.
async function streamInput(payload: Record<string, unknown>) {
	let received: Record<string, unknown> | undefined;
	const agent = tediDo({
		env: {},
		async ensureIdentity() {},
		async streamChatTurn(input: Record<string, unknown>) {
			received = input;
			return new Response("");
		},
	});
	await agent.onRequest(
		new Request("https://do.internal/__internal/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				client_request_id: "req-1",
				text: "hi",
				...payload,
			}),
		}),
	);
	return received!;
}
assert.equal(
	(await streamInput({ model_ref: "workers-ai/@cf/meta/llama-3.1" }))
		.modelRefOverride,
	"workers-ai/@cf/meta/llama-3.1",
);
for (const bad of ["not a ref", "workers-ai/", 42, "a/b c"]) {
	assert.equal(
		(await streamInput({ model_ref: bad })).modelRefOverride,
		undefined,
		`the DO must refuse ${JSON.stringify(bad)} as a model ref`,
	);
}
for (const effort of ["none", "low", "medium", "high"]) {
	assert.equal(
		(await streamInput({ reasoning_effort: effort })).reasoningEffortOverride,
		effort,
	);
}
assert.equal(
	(await streamInput({ reasoning_effort: "max" })).reasoningEffortOverride,
	undefined,
	"the DO must accept only the four declared effort levels",
);
assert.equal(
	(await streamInput({ context_policy: "session_only" })).contextPolicy,
	"session_only",
);

// Context policy shapes an embedded turn: session-only context, compact MCP
// instructions, no workspace note, no cognitive addenda, and a capped output.
// A model override alone must not switch memory off.
async function contextTurn(input: Record<string, unknown>) {
	let addenda = 0;
	const probe = chatTurnProbe({
		mcpRuntime: {
			bindTurn() {},
			clearTurn() {},
			getSystemInstructions: () => "FULL-MCP-INSTRUCTIONS",
			getUtilitySystemInstructions: () => "UTILITY-MCP-INSTRUCTIONS",
			async executeTool() {
				return [];
			},
		},
		platform: {
			setEpisodeTrace() {},
			async rankDiscovery() {
				return {};
			},
		},
		async facetTurn() {
			return { assistantText: "ok" };
		},
		fields: {
			async cognitiveAddenda() {
				addenda += 1;
				return "ADDENDA";
			},
		},
	});
	await probe.run({ text: "hello", ...input });
	return { facet: probe.facetInputs[0]!, addenda };
}
{
	const embedded = await contextTurn({
		sessionKey: "embed:acme:1",
		toolArgumentConstraints: { company_id: "367" },
		toolAllowedCallables: ["shop.list_orders"],
	});
	assert.match(embedded.facet.system, /UTILITY-MCP-INSTRUCTIONS/);
	assert.doesNotMatch(embedded.facet.system, /FULL-MCP-INSTRUCTIONS/);
	assert.equal(embedded.facet.system.includes(WORKSPACE_TOOLS_NOTE), false);
	assert.equal(embedded.addenda, 0);
	assert.equal(
		embedded.facet.maxOutputTokensOverride,
		chatContextPolicy("session_only").maxOutputTokens,
	);

	const ordinary = await contextTurn({
		sessionKey: "main",
		modelRefOverride: "workers-ai/@cf/meta/llama-3.1",
	});
	assert.match(ordinary.facet.system, /FULL-MCP-INSTRUCTIONS/);
	assert.match(ordinary.facet.system, /ADDENDA/);
	assert.equal(ordinary.addenda, 1, "a model override keeps memory on");
	assert.ok(ordinary.facet.system.includes(WORKSPACE_TOOLS_NOTE));
	assert.equal(ordinary.facet.maxOutputTokensOverride, undefined);
}

// An explicit user effort wins; a surface that caps output (a short utility
// turn) uses "none" only for a supporting model; otherwise its default stands.
async function configuredReasoning(
	input: Record<string, unknown>,
	deployment = "gpt-6.1-sol",
) {
	let reasoning: unknown = "unset";
	const agent = tediDo({
		env: { AZURE_CHAT_DEPLOYMENT: deployment },
		state: { tediId: "tedi-1", slug: "acme" },
		runtimeConfigCache: { modelPolicy: undefined },
		activeFacetTurnTools: new Map(),
		activeFacetTurnConversations: new Map(),
		async subAgent() {
			return {
				completedTurnCount: () => 1,
				async streamConfiguredConversationTurn(input: {
					configuration: { reasoning: unknown };
				}) {
					reasoning = input.configuration.reasoning;
					return new ReadableStream({
						start(controller) {
							controller.close();
						},
					});
				},
			};
		},
		admitInferenceTurn() {},
		tediAigMetadata: () => ({}),
		modelOverrideForTurn: () => null,
		emitFacetTurnDatapoint() {},
	});
	await agent.streamConversationFacetTurn({
		sessionKey: "main",
		userText: "hello",
		userTs: 1,
		system: "SYSTEM",
		runId: "run-1",
		maxSteps: 8,
		tools: {},
		onDelta() {},
		...input,
	});
	return reasoning;
}
assert.equal(
	await configuredReasoning({
		reasoningEffortOverride: "high",
		maxOutputTokensOverride: 1500,
	}),
	"high",
	"an explicit effort must outrank the output-cap default",
);
assert.equal(
	await configuredReasoning({ maxOutputTokensOverride: 1500 }),
	null,
);
assert.equal(
	await configuredReasoning({ maxOutputTokensOverride: 1500 }, "gpt-6-luna"),
	"none",
);
assert.equal(
	await configuredReasoning({
		maxOutputTokensOverride: 1500,
		modelRefOverride: "azure-openai/gpt-6-luna",
	}),
	"none",
);
assert.equal(await configuredReasoning({}), null);

// --- a browser model choice is gated by the tedi's own roster at the edge ---
{
	const roster = () => ({
		models: [
			{ ref: "azure-openai/gpt-5.6-terra", reasoning: true, allowed: true },
			{ ref: "workers-ai/@cf/meta/llama-3.1", reasoning: false, allowed: true },
		],
	});
	const picked = await streamedTurn(
		{},
		{ modelRef: "azure-openai/gpt-5.6-terra", reasoningEffort: "high" },
		{ "modelCatalog/list": roster },
	);
	assert.equal(picked.body.model_ref, "azure-openai/gpt-5.6-terra");
	assert.equal(picked.body.reasoning_effort, "high");
	assert.deepEqual(
		picked.rpcs.find((rpc) => rpc.path === "modelCatalog/list")?.input,
		{ tediId: EDGE_TEDI.id, includeDenied: false },
	);
	// Effort survives only for a model that can take one.
	const plain = await streamedTurn(
		{},
		{ modelRef: "workers-ai/@cf/meta/llama-3.1", reasoningEffort: "high" },
		{ "modelCatalog/list": roster },
	);
	assert.equal(plain.body.model_ref, "workers-ai/@cf/meta/llama-3.1");
	assert.equal("reasoning_effort" in plain.body, false);
	// A forged pick falls back to the session's signed default.
	const forged = await streamedTurn(
		{ defaultModelRef: "workers-ai/@cf/meta/llama-3.1", surface: "os" },
		{ modelRef: "azure-openai/not-offered" },
		{ "modelCatalog/list": roster },
	);
	assert.equal(forged.body.model_ref, "workers-ai/@cf/meta/llama-3.1");
	// An os session without a configured default gets no edge-chosen model.
	const os = await streamedTurn({ surface: "os" }, {});
	assert.equal("model_ref" in os.body, false);
}

console.log("embedded Cap'n hard cutover OK");
