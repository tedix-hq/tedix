import assert from "node:assert/strict";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import { CHAT_MESSAGE_TYPES as TYPES } from "agents/chat";
import {
	NativeAcpChannel,
	type NativeAcpHost,
	type AcpConnection,
	type NativeAcpTurnInput,
} from "./acp-channel";

function probe() {
	const data = new Map<string, unknown>();
	const tasks: Promise<unknown>[] = [];
	const inputs: NativeAcpTurnInput[] = [];
	const cancelled: string[] = [];
	const resolutions: unknown[] = [];
	const frames: Record<string, unknown>[] = [];
	const connection: AcpConnection = {
		id: "connection",
		send: (raw) => {
			frames.push(JSON.parse(String(raw)));
		},
	};
	const peers = [connection];
	let clearCount = 0;
	let pending = [
		{
			approvalId: "a",
			runId: "run:tedix:acp:submit-message:r:u",
			toolCallId: "tool",
		},
	];
	let stream = 'data: {"kind":"done"}\n\n';
	let resumeStream = '{"kind":"done"}\n';
	const bytes = (value: string) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				// Deliberately split every character, including framing boundaries.
				for (const character of value)
					controller.enqueue(new TextEncoder().encode(character));
				controller.close();
			},
		});
	const storage = {
		async get(key: string) {
			return data.get(key);
		},
		async put(key: string | Record<string, unknown>, value?: unknown) {
			if (typeof key === "string") data.set(key, value);
			else for (const [k, v] of Object.entries(key)) data.set(k, v);
		},
		async delete(keys: string | string[]) {
			for (const key of typeof keys === "string" ? [keys] : keys)
				data.delete(key);
		},
		async list(options: { prefix: string }) {
			return new Map(
				[...data].filter(([key]) => key.startsWith(options.prefix)),
			);
		},
	} as unknown as DurableObjectStorage;
	const facet = {
		historyMessages: async () => [],
		cancelPiTurn: async () => {},
		clearHistory: async () => {
			clearCount++;
		},
		pendingToolApprovals: async () => pending,
		resolveToolApproval: async (input: unknown) => {
			resolutions.push(input);
		},
		resumeConfiguredConversationTurn: async () => bytes(resumeStream),
	} as unknown as Awaited<ReturnType<NativeAcpHost["facet"]>>;
	const host: NativeAcpHost = {
		storage,
		identity: () => ({ orgId: "org", tediId: "tedi" }),
		waitUntil: (task) => {
			tasks.push(task);
		},
		connections: () => peers,
		facet: async () => facet,
		runId: (id) => `run:${id}`,
		cancelRun: async (id) => {
			cancelled.push(id);
		},
		streamChatTurn: async (input) => {
			inputs.push(input);
			return new Response(bytes(stream));
		},
		onError: () => {},
	};
	const channel = new NativeAcpChannel(host);
	const send = (type: string, rest: Record<string, unknown> = {}) =>
		channel.onMessage(connection, JSON.stringify({ type, ...rest }));
	const submit = (
		text = "hello",
		rest: Record<string, unknown> = {},
		id = "r",
	) =>
		send(TYPES.USE_CHAT_REQUEST, {
			id,
			init: {
				method: "POST",
				body: JSON.stringify({
					sessionKey: "session",
					messages: [
						{ id: "u", role: "user", parts: [{ type: "text", text }] },
					],
					...rest,
				}),
			},
		});
	const connect = (
		subject = "owner",
		query = "sessionKey=session",
		approve = true,
	) =>
		channel.onConnect(
			connection,
			new Request(`https://runtime/acp?${query}`, {
				headers: {
					"X-Tedi-Auth-Subject": subject,
					"X-Tedi-Auth-OrgId": "org",
					"X-Tedi-Auth-TediId": "tedi",
					"X-Tedix-Can-Approve-Tools": String(approve),
				},
			}),
		);
	return {
		data,
		tasks,
		inputs,
		cancelled,
		resolutions,
		frames,
		peers,
		channel,
		send,
		submit,
		connect,
		connection,
		finish: async () => {
			await Promise.all(tasks.splice(0));
		},
		setStream: (value: string) => {
			stream = value;
		},
		setResume: (value: string) => {
			resumeStream = value;
		},
		setPending: (value: typeof pending) => {
			pending = value;
		},
		clearCount: () => clearCount,
	};
}

{
	const p = probe();
	assert.equal(await p.channel.onMessage(p.connection, "not JSON"), false);
	await assert.rejects(p.submit(), /Authenticated ACP/);
	await p.connect();
	await p.submit();
	await p.finish();
	assert.equal(p.inputs[0]?.clientRequestId, "tedix:acp:submit-message:r:u");
	assert.equal(p.inputs[0]?.originalUiMessage?.parts[0]?.type, "text");
	assert.equal(p.frames.at(-1)?.done, true);
	assert.equal(p.frames.at(-1)?.error, undefined);
	await assert.rejects(p.submit("changed"), /different immutable input/);
	await assert.rejects(
		p.submit("changed", {}, "new-request"),
		/user id reused/,
	);
	assert.equal(p.inputs.length, 1);
}
{
	const p = probe();
	await p.connect();
	await assert.rejects(
		p.submit("hello", { trigger: "regenerate-message" }),
		/server-owned/,
	);
	await p.submit();
	await p.finish();
	await p.submit("hello", { trigger: "regenerate-message" }, "regen");
	await p.finish();
	assert.equal(p.inputs[1]?.regenerationOf, "tedix:acp:submit-message:r:u");
	await assert.rejects(
		p.submit("modified", { trigger: "regenerate-message" }, "regen2"),
		/cannot alter/,
	);
	await assert.rejects(
		p.submit("hello", { clientTools: ["x"] }, "tools"),
		/server-resolved/,
	);
}
{
	const p = probe();
	await p.connect("owner", "sessionKey=session", false);
	await p.submit();
	await p.finish();
	await assert.rejects(
		p.send(TYPES.TOOL_APPROVAL, { toolCallId: "tool", approved: true }),
		/operator/,
	);
	await p.connect();
	p.setPending([{ approvalId: "a", runId: "another-run", toolCallId: "tool" }]);
	await assert.rejects(
		p.send(TYPES.TOOL_APPROVAL, { toolCallId: "tool", approved: true }),
		/owned run/,
	);
	p.setPending([
		{
			approvalId: "a",
			runId: "run:tedix:acp:submit-message:r:u",
			toolCallId: "tool",
		},
	]);
	await p.send(TYPES.TOOL_APPROVAL, { toolCallId: "tool", approved: false });
	assert.deepEqual(p.resolutions, [{ approvalId: "a", approved: false }]);
	await p.send(TYPES.CHAT_REQUEST_CANCEL, { id: "foreign" });
	assert.equal(p.cancelled.length, 0);
	await p.send(TYPES.CHAT_REQUEST_CANCEL, { id: "r" });
	assert.deepEqual(p.cancelled, ["run:tedix:acp:submit-message:r:u"]);
}
{
	const p = probe();
	await p.connect();
	await p.submit();
	await p.finish();
	const otherFrames: unknown[] = [];
	p.peers.push({
		id: "other",
		send: (value) => {
			otherFrames.push(value);
		},
	});
	p.data.set("pi:acp:session:other", "session");
	p.data.set("pi:acp:identity:other", {
		subject: "other",
		orgId: "org",
		tediId: "tedi",
	});
	for (const [id, orgId, tediId] of [
		["foreign-org", "other-org", "tedi"],
		["foreign-tedi", "org", "other-tedi"],
	]) {
		p.peers.push({
			id: id!,
			send: (value) => {
				otherFrames.push(value);
			},
		});
		p.data.set(`pi:acp:session:${id}`, "session");
		p.data.set(`pi:acp:identity:${id}`, { subject: "owner", orgId, tediId });
	}
	await p.send(TYPES.CHAT_CLEAR);
	assert.equal(p.clearCount(), 1);
	assert.equal(otherFrames.length, 0);
	assert.equal(p.data.has("pi:acp:owned:owner:session"), false);
}
{
	const p = probe();
	await p.connect();
	p.setStream(
		'data: {"kind":"chunk","body":"{\\"type\\":\\"text-delta\\",\\"delta\\":\\"hi\\"}"}\n\n',
	);
	await p.submit();
	await p.finish();
	assert.equal(p.frames.at(-1)?.error, true);
	assert.match(String(p.frames.at(-1)?.body), /without terminal/);
}
{
	const p = probe();
	await p.connect();
	await p.submit();
	await p.finish();
	p.data.set("pi:acp:identity:connection", {
		subject: "owner",
		orgId: "foreign",
		tediId: "tedi",
	});
	await assert.rejects(
		p.send(TYPES.STREAM_RESUME_REQUEST),
		/Authenticated ACP resume/,
	);
	await p.connect();
	await p.send(TYPES.STREAM_RESUME_REQUEST, { probeId: "probe" });
	assert.equal(p.frames.at(-1)?.id, "r");
	await p.send(TYPES.STREAM_RESUME_ACK, { id: "foreign" });
	assert.equal(p.tasks.length, 0);
	p.setResume(
		'{"kind":"chunk","body":"{\\"type\\":\\"text-delta\\",\\"delta\\":\\"hi\\"}"}\n',
	);
	await p.send(TYPES.STREAM_RESUME_ACK, { id: "r" });
	await p.finish();
	assert.equal(p.frames.at(-1)?.error, true);
	assert.match(String(p.frames.at(-1)?.body), /without terminal/);
	p.setResume('{"kind":"done"}\n');
	await p.send(TYPES.STREAM_RESUME_ACK, { id: "r" });
	await p.finish();
	assert.equal(p.frames.at(-1)?.replay, true);
	assert.equal(p.frames.at(-1)?.error, undefined);
}
{
	const p = probe();
	await p.connect("owner", "conversationId=obsolete");
	assert.equal(p.data.get("pi:acp:session:connection"), DEFAULT_SESSION_KEY);
}
console.log(
	"ACP authority, immutable input, cancellation, regeneration, isolated clear and strict stream completion passed",
);
