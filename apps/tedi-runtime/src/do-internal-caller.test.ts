/**
 * The tedi DO guards its own `/__internal/*` routes. The Worker edge already
 * refuses an untrusted caller before any DO wake (`internal-route-edge`), but
 * the DO's `fetch` is reachable by anything holding the `TEDI_AGENT` binding
 * and by any later edge rewrite, so the DO itself must refuse a request that
 * did not arrive on a trusted internal hop: one carrying the service-binding
 * marker that only trusted code stamps after its own check.
 *
 * Proven here: (1) without the marker every internal route answers 403 at
 * the top of dispatch, under every spelling, before any collaborator runs,
 * whatever identity or admin headers were forged; (2) with the marker the
 * same request passes the gate and reaches the route's own checks; (3) every
 * legitimate edge hop to an internal route — the embedded widget capability,
 * the `/hooks/*` aliases, the cron and config aliases — forwards the marker.
 */
import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";
import { EDGE_TEDI, edgeFetch, tediRequest } from "../test/tedi-edge";
import { embedded, embeddedToken } from "../test/embedded-edge";

const INTERNAL_ROUTES = [
	"/__internal/inject",
	"/__internal/mesh/inject",
	"/__internal/chat/stream",
	"/__internal/chat/warm",
	"/__internal/cancel",
	"/__internal/page-tool/result",
	"/__internal/messages/read",
	"/__internal/review-capabilities",
	"/__internal/browser/takeover-status",
	"/__internal/cm-session/authorize",
	"/__internal/cm-session/revoke",
	"/__internal/repo-commit/drain",
	"/__internal/cm-executions/resume",
	"/__internal/fanout-slots",
	"/__internal/fanout-batch",
	"/__internal/voice/consult",
	"/__internal/config/refresh",
	"/__internal/cron/sync",
];

/** Spellings the DO must refuse although its routes match by exact path. */
function spellings(path: string): string[] {
	const rest = path.slice("/__internal".length);
	return [
		path,
		`${path}/`,
		`/${path}`,
		`/%5F%5Finternal${rest}`,
		`/__INTERNAL${rest}`,
		`/__internal/.${rest}`,
		`/x/../__internal${rest}`,
	];
}

/** Everything a caller could forge to look like the edge or an operator. */
const FORGED_HEADERS = {
	"Content-Type": "application/json",
	"X-Tedi-Id": "tedi-example",
	"X-Tedi-Org-Id": "org-example",
	"X-Tedi-Slug": "example",
	"X-Tedi-Auth-Subject": "forged-user",
	"X-Tedi-Auth-TediId": "tedi-example",
	"X-Tedi-Auth-OrgId": "org-example",
	"X-Tedix-Admin-Token": "master-key-example",
	"X-Tedix-Can-Approve-Tools": "true",
	"X-Tedix-Can-Manage-Durable-Code": "true",
	"x-tedix-caller-trust": "member",
};

/** A DO whose collaborators only record that they were reached. */
function recordingDo(calls: string[]) {
	const touched =
		(name: string) =>
		async (..._args: unknown[]) => {
			calls.push(name);
			return undefined as never;
		};
	return tediDo({
		state: {
			tediId: "tedi-example",
			orgId: "org-example",
			slug: "example",
			governanceLoadedAt: 12,
		},
		env: { SECRETS_MASTER_KEY: "master-key-example" },
		hintsFromHeaders: () => ({}),
		ensureIdentity: touched("identity"),
		subAgent: touched("facet"),
		browserTakeoverStatus: touched("takeover"),
		runtimeConfigCache: { invalidate: () => calls.push("invalidate") },
		setState: () => calls.push("state"),
		cronReconcileDone: true,
		reconcilePolicyPackCrons: touched("cron"),
		resumeChatStream: touched("resume"),
		streamChatTurn: touched("stream"),
		getMcpRuntime: touched("mcp"),
		readMessagesForSession: touched("messages"),
		getTools: () => calls.push("tools") && {},
		pageToolBroker: {
			resolve: () => {
				calls.push("page-tool");
				return true;
			},
		},
	});
}

const doRequest = (path: string, method: string, headers: HeadersInit) =>
	new Request(`https://runtime.example${path}`, {
		method,
		headers,
		body: method === "GET" ? null : JSON.stringify({ text: "hi" }),
	});

// --- 1. an unmarked request is refused before any route logic runs ---
const accepted: string[] = [];
for (const route of INTERNAL_ROUTES) {
	for (const path of spellings(route)) {
		for (const method of ["GET", "POST", "PUT"]) {
			const calls: string[] = [];
			const agent = recordingDo(calls);
			let status: number | string;
			try {
				const response = (await agent.onRequest(
					doRequest(path, method, FORGED_HEADERS),
				)) as Response | undefined;
				status = response?.status ?? "no response";
			} catch (error) {
				status = `threw ${String(error).slice(0, 60)}`;
			}
			if (status !== 403 || calls.length > 0)
				accepted.push(
					`${method} ${path} -> ${status}${calls.length ? ` (${calls.join(",")})` : ""}`,
				);
		}
	}
}
assert.deepEqual(
	accepted,
	[],
	`the DO let untrusted internal calls through:\n${accepted.join("\n")}`,
);

// --- 2. the marker is the only thing that opens the gate ---
// `PUT` is a method no internal route accepts, so a 405 proves the request
// passed the caller check and reached the route's own method check.
for (const route of INTERNAL_ROUTES) {
	const calls: string[] = [];
	const agent = recordingDo(calls);
	const response = await agent.onRequest(
		doRequest(route, "PUT", { ...FORGED_HEADERS, "X-Service-Binding": "true" }),
	);
	assert.equal(response.status, 405, `${route} with the marker`);
	assert.deepEqual(calls, [], route);
}
{
	// A marked request still runs the route: config refresh is the cheapest.
	const calls: string[] = [];
	const agent = recordingDo(calls);
	const response = await agent.onRequest(
		doRequest("/__internal/config/refresh", "POST", {
			"X-Service-Binding": "true",
		}),
	);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual(calls, ["invalidate", "state"]);
}
{
	// Any other marker value is not a trusted hop.
	const calls: string[] = [];
	const agent = recordingDo(calls);
	for (const value of ["1", "TRUE", "yes", ""]) {
		const response = await agent.onRequest(
			doRequest("/__internal/config/refresh", "POST", {
				"X-Service-Binding": value,
			}),
		);
		assert.equal(response.status, 403, `marker value ${JSON.stringify(value)}`);
	}
	assert.deepEqual(calls, []);
}

// --- 3. every legitimate edge hop forwards the marker to the DO ---
function forwardedTo(run: { forwarded: Request[] }, path: string): Request {
	const request = run.forwarded.find(
		(item) => new URL(item.url).pathname === path,
	);
	assert.ok(request, `the edge forwarded to ${path}`);
	return request;
}
function assertMarked(request: Request, label: string): void {
	assert.equal(request.headers.get("X-Service-Binding"), "true", label);
}

// The embedded widget capability: a browser session the edge authenticated.
{
	const transcript = await embedded({}, async (request) =>
		new URL(request.url).pathname === "/__internal/messages/read"
			? Response.json({ messages: [] })
			: Response.json({ ok: true }),
	);
	await transcript.adapter.readTranscript(
		await embeddedToken(),
		undefined as never,
	);
	assertMarked(
		forwardedTo(transcript, "/__internal/messages/read"),
		"embedded transcript read",
	);

	const cancel = await embedded({}, () => Response.json({ cancelled: true }));
	await cancel.adapter.cancel(
		await embeddedToken(),
		"turn-1",
		undefined as never,
	);
	assertMarked(forwardedTo(cancel, "/__internal/cancel"), "embedded cancel");

	const stream = await embedded({
		"tedis/listEmbeddedConversationCapabilities": () => ({
			capabilities: [],
		}),
		"tedis/listEmbeddedConversationArtifactPins": () => ({ pins: [] }),
	});
	// A tenant-bound session warms the tool schemas when the panel opens.
	const session = await embeddedToken({
		hostTenantArgument: "company_id",
		hostTenantNamespace: "shop",
		embeddedAssistantCallables: ["shop.list_orders"],
	});
	await stream.adapter.authorize(session);
	await stream.adapter.stream(session, {
		text: "hello",
		turnKey: "turn-1",
		signal: new AbortController().signal,
	} as never);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assertMarked(
		forwardedTo(stream, "/__internal/chat/stream"),
		"embedded stream",
	);
	assertMarked(forwardedTo(stream, "/__internal/chat/warm"), "embedded warm");

	const pageTool = await embedded({}, () => Response.json({ accepted: true }));
	await pageTool.adapter.resolvePageTool!(
		await embeddedToken(),
		{
			runId: "run-1",
			callId: "page_tool_call_1",
			result: { ok: true },
		} as never,
		undefined as never,
	);
	assertMarked(
		forwardedTo(pageTool, "/__internal/page-tool/result"),
		"embedded page tool result",
	);
}

// The service-binding aliases the edge rewrites to internal routes.
for (const [alias, method, target] of [
	["/hooks/chat-stream", "POST", "/__internal/chat/stream"],
	["/hooks/chat-stream?run_id=run-1", "GET", "/__internal/chat/stream"],
	["/hooks/inject", "POST", "/__internal/inject"],
	["/hooks/review-capabilities", "GET", "/__internal/review-capabilities"],
	["/hooks/cancel-turn", "POST", "/__internal/cancel"],
	["/hooks/mesh-inject", "POST", "/__internal/mesh/inject"],
	["/api/cron/sync", "POST", "/__internal/cron/sync"],
	["/api/admin/invalidate-config", "POST", "/__internal/config/refresh"],
] as const) {
	const run = await edgeFetch(
		tediRequest(alias, {
			method,
			serviceBinding: true,
			headers: { "Content-Type": "application/json" },
			body: method === "GET" ? null : "{}",
		}),
	);
	assert.equal(run.response.status, 200, `${method} ${alias}`);
	assert.deepEqual(run.doNames, [EDGE_TEDI.isolateAgentId]);
	assertMarked(forwardedTo(run, target), `${method} ${alias}`);
}

console.log("DO internal caller tests passed");
