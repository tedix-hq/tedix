import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";

const request = (path: string, method = "POST", body?: string) =>
	new Request(`https://runtime.example${path}`, { method, body });
// An internal route reached on a trusted hop; `do-internal-caller.test.ts`
// proves the DO refuses it without the marker.
const internal = (path: string, method = "POST", body?: string) =>
	new Request(`https://runtime.example${path}`, {
		method,
		headers: { "X-Service-Binding": "true" },
		body,
	});

{
	const calls: string[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-example" },
		async ensureIdentity() {
			calls.push("identity");
		},
		async subAgent(_facet: unknown, name: string) {
			calls.push(name);
			return { historyMessages: async () => [{ id: "message-example" }] };
		},
	});
	assert.equal((await agent.onRequest(request("/get-messages"))).status, 405);
	assert.deepEqual(calls, []);
	assert.equal(
		(await agent.onRequest(request("/get-messages", "GET"))).status,
		403,
	);
	assert.deepEqual(calls.splice(0), ["identity"]);
	const authenticated = new Request(
		"https://runtime.example/get-messages?sessionKey=chat:example",
		{
			headers: {
				"X-Tedi-Auth-Subject": "owner-example",
				"X-Tedi-Auth-TediId": "tedi-example",
			},
		},
	);
	assert.deepEqual(await (await agent.onRequest(authenticated)).json(), [
		{ id: "message-example" },
	]);
	assert.deepEqual(calls, ["identity", "chat_example"]);
}

{
	const calls: string[] = [];
	const agent = tediDo({
		async ensureIdentity() {
			calls.push("identity");
		},
		async nativeTelegram() {
			calls.push("telegram");
			return null;
		},
	});
	assert.equal(
		(await agent.onRequest(request("/webhooks/telegram", "GET"))).status,
		405,
	);
	assert.deepEqual(calls, []);
	assert.equal(
		(await agent.onRequest(request("/webhooks/telegram"))).status,
		404,
	);
	assert.deepEqual(calls, ["identity", "telegram"]);
	agent.nativeTelegram = async () => ({
		handleRequest: async (received: Request) => {
			assert.equal(received, incoming);
			return new Response("handled", { status: 202 });
		},
	});
	const incoming = request("/webhooks/telegram");
	assert.equal(await (await agent.onRequest(incoming)).text(), "handled");
}

{
	const calls: string[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-example", governanceLoadedAt: 12 },
		runtimeConfigCache: { invalidate: () => calls.push("invalidate") },
		setState(state: unknown) {
			calls.push("state");
			this.state = state;
		},
	});
	assert.equal(
		(await agent.onRequest(internal("/__internal/config/refresh", "GET")))
			.status,
		405,
	);
	assert.deepEqual(calls, []);
	assert.deepEqual(
		await (
			await agent.onRequest(internal("/__internal/config/refresh"))
		).json(),
		{ ok: true },
	);
	assert.deepEqual(calls, ["invalidate", "state"]);
	assert.equal(agent.state.governanceLoadedAt, 0);
	assert.equal(agent.state.tediId, "tedi-example");
}

{
	const agent = tediDo({ env: {}, async ensureIdentity() {} });
	for (const path of [
		"/__admin/force-compact",
		"/__internal/browser/takeover-status",
	]) {
		assert.equal((await agent.onRequest(request(path))).status, 403, path);
	}
	for (const [path, body, error] of [
		["/__internal/chat/stream", "{", "invalid_json"],
		["/__internal/chat/stream", "{}", "client_request_id is required"],
		["/__internal/inject", "{", "invalid_json"],
		["/__internal/inject", "{}", "text is required"],
		[
			"/__internal/inject",
			'{"text":"hello"}',
			"client_request_id (or message_id / idempotency_key) is required",
		],
	]) {
		const response = await agent.onRequest(internal(path!, "POST", body));
		assert.equal(response.status, 400);
		assert.equal(((await response.json()) as { error: string }).error, error);
	}
}
console.log("Runtime request boundary characterization tests passed");
