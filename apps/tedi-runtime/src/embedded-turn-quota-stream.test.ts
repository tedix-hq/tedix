/**
 * `streamChatTurn` refuses an embedded turn past the visitor's hourly ceiling
 * with the capacity error the widget already understands, before the model
 * runs; another origin's visitor is unaffected.
 */
import assert from "node:assert/strict";
import { chatTurnProbe, memoryStorage } from "../test/tedi-do";
import { EMBEDDED_TURN_QUOTA_DEFAULTS } from "./embedded-turn-quota";

const probe = () => {
	const storage = memoryStorage();
	const p = chatTurnProbe({
		async facetTurn() {
			return { assistantText: "ok" };
		},
		fields: { ctx: { storage, waitUntil() {} } },
	});
	return { ...p, storage };
};
const turn = (origin: string, visitor: string, n: number) => ({
	sessionKey: `embed:${visitor}`,
	clientRequestId: `${visitor}-${n}`,
	text: "hello",
	trust: "untrusted",
	trustChannel: "widget",
	embeddedQuota: { origin, visitorKey: visitor },
});

{
	const p = probe();
	const limit = EMBEDDED_TURN_QUOTA_DEFAULTS.visitorTurnsPerHour;
	assert.equal(limit, 60);
	for (let i = 1; i <= limit; i++) {
		const { frames } = await p.run(turn("https://a.example", "1:alice", i));
		assert.ok(!frames.some((f) => f.kind === "error"), JSON.stringify(frames));
	}
	assert.equal(p.facetInputs.length, limit);

	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => errors.push(String(args[0]));
	let refused: Awaited<ReturnType<typeof p.run>>;
	try {
		refused = await p.run(turn("https://a.example", "1:alice", limit + 1));
	} finally {
		console.error = original;
	}
	assert.equal(refused.response.headers.get("Retry-After") !== null, true);
	assert.equal(refused.frames.length, 1);
	assert.equal(refused.frames[0]!.kind, "error");
	assert.match(
		String(refused.frames[0]!.message),
		/inference_capacity_exhausted/,
	);
	assert.equal(typeof refused.frames[0]!.retryAfterSeconds, "number");
	assert.equal(p.facetInputs.length, limit, "the model is not invoked");
	assert.equal(
		p.appended.filter((entry) => entry.sessionKey === "embed:1:alice").length,
		limit * 2,
		"the refused turn is not recorded (user + assistant per admitted turn)",
	);
	const log = errors
		.map((line) => JSON.parse(line))
		.find((entry) => entry._tr === "embedded_quota");
	assert.deepEqual(log, {
		_tr: "embedded_quota",
		tediId: "tedi-1",
		origin: "https://a.example",
		kind: "visitor",
		count: 60,
		limit: 60,
	});

	// A visitor on a different origin is unaffected.
	const other = await p.run(turn("https://b.example", "2:bob", 1));
	assert.ok(!other.frames.some((f) => f.kind === "error"));
	assert.equal(p.facetInputs.length, limit + 1);
}

// --- the signed origin ceiling, when it is the smaller one, refuses by origin ---
{
	const p = probe();
	const withOrigin = (n: number, visitor: string) => ({
		...turn("https://a.example", visitor, n),
		embeddedQuota: {
			origin: "https://a.example",
			visitorKey: visitor,
			originTurnsPerHour: 2,
		},
	});
	await p.run(withOrigin(1, "1:alice"));
	await p.run(withOrigin(1, "1:bob"));
	const original = console.error;
	console.error = () => {};
	let refused: Awaited<ReturnType<typeof p.run>>;
	try {
		refused = await p.run(withOrigin(1, "1:carol"));
	} finally {
		console.error = original;
	}
	assert.match(String(refused.frames[0]!.message), /origin turn quota/);
	assert.equal(p.facetInputs.length, 2);
}

// --- a non-embedded turn never touches the counter ---
{
	const p = probe();
	await p.run({ text: "hello" });
	assert.equal(
		[...p.storage.data.keys()].some((k) => k.startsWith("embedded-quota:")),
		false,
	);
}

console.log("embedded-turn-quota-stream OK");
