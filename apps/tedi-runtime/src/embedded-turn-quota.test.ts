/**
 * The embedded turn counter: fixed hourly buckets per visitor and per origin,
 * independent keys, retry-after to the bucket edge, and stale-bucket cleanup.
 */
import assert from "node:assert/strict";
import { memoryStorage } from "../test/tedi-do";
import {
	admitEmbeddedTurn,
	EMBEDDED_TURN_QUOTA_BUCKET_MS,
	EMBEDDED_TURN_QUOTA_DEFAULTS,
	embeddedTurnQuotaFromPayload,
	embeddedTurnQuotaScope,
} from "./embedded-turn-quota";

const HOUR = EMBEDDED_TURN_QUOTA_BUCKET_MS;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
const scope = (
	over: Partial<Parameters<typeof admitEmbeddedTurn>[1]> = {},
) => ({
	origin: "https://a.example",
	visitorKey: "1:alice",
	visitorTurnsPerHour: 3,
	originTurnsPerHour: 5,
	...over,
});

// --- the visitor ceiling refuses the (n+1)th turn without counting it ---
{
	const storage = memoryStorage();
	for (let i = 0; i < 3; i++)
		assert.deepEqual(await admitEmbeddedTurn(storage, scope(), T0 + 1000), {
			ok: true,
		});
	const refused = await admitEmbeddedTurn(storage, scope(), T0 + 90_000);
	assert.deepEqual(refused, {
		ok: false,
		kind: "visitor",
		count: 3,
		limit: 3,
		retryAfterSeconds: 3600 - 90,
	});
	// Refusals do not count: the stored counter stays at the ceiling.
	assert.equal(
		storage.data.get("embedded-quota:visitor:1:alice:" + T0 / HOUR),
		3,
	);
}

// --- per-key independence: another visitor on the same origin still runs,
//     and the origin ceiling refuses only once the origin total is reached ---
{
	const storage = memoryStorage();
	for (let i = 0; i < 3; i++) await admitEmbeddedTurn(storage, scope(), T0);
	assert.equal((await admitEmbeddedTurn(storage, scope(), T0)).ok, false);
	const bob = scope({ visitorKey: "1:bob" });
	assert.equal((await admitEmbeddedTurn(storage, bob, T0)).ok, true);
	assert.equal((await admitEmbeddedTurn(storage, bob, T0)).ok, true);
	const originRefused = await admitEmbeddedTurn(storage, bob, T0);
	assert.equal(originRefused.ok, false);
	assert.equal(!originRefused.ok && originRefused.kind, "origin");
	assert.equal(!originRefused.ok && originRefused.count, 5);
	// A different origin is untouched by either counter.
	const other = scope({ origin: "https://b.example", visitorKey: "2:carol" });
	assert.equal((await admitEmbeddedTurn(storage, other, T0)).ok, true);
}

// --- bucket rollover: the next hour starts fresh and stale buckets are dropped ---
{
	const storage = memoryStorage();
	for (let i = 0; i < 3; i++) await admitEmbeddedTurn(storage, scope(), T0);
	assert.equal((await admitEmbeddedTurn(storage, scope(), T0)).ok, false);
	assert.equal((await admitEmbeddedTurn(storage, scope(), T0 + HOUR)).ok, true);
	// Two hours on, the first bucket is older than the previous one: deleted.
	assert.equal(
		(await admitEmbeddedTurn(storage, scope(), T0 + 2 * HOUR)).ok,
		true,
	);
	const keys = [...storage.data.keys()];
	assert.ok(!keys.some((key) => key.endsWith(`:${T0 / HOUR}`)), keys.join());
	assert.ok(keys.some((key) => key.endsWith(`:${T0 / HOUR + 1}`)));
	assert.ok(keys.some((key) => key.endsWith(`:${T0 / HOUR + 2}`)));
}

// --- retry-after is the distance to the bucket edge, never below 1s ---
{
	const storage = memoryStorage();
	for (let i = 0; i < 3; i++) await admitEmbeddedTurn(storage, scope(), T0);
	const refused = await admitEmbeddedTurn(storage, scope(), T0 + HOUR - 1);
	assert.equal(!refused.ok && refused.retryAfterSeconds, 1);
}

// --- scope: non-embedded turns have none; embedded turns without the edge
//     payload count the visitor by session key at the platform default ---
{
	assert.equal(embeddedTurnQuotaScope({ sessionKey: "main" }), null);
	assert.deepEqual(embeddedTurnQuotaScope({ sessionKey: "embed:x" }), {
		origin: undefined,
		visitorKey: "embed:x",
		visitorTurnsPerHour: EMBEDDED_TURN_QUOTA_DEFAULTS.visitorTurnsPerHour,
		originTurnsPerHour: EMBEDDED_TURN_QUOTA_DEFAULTS.originTurnsPerHour,
	});
	assert.deepEqual(
		embeddedTurnQuotaScope({
			sessionKey: "embed:x",
			embeddedQuota: embeddedTurnQuotaFromPayload({
				origin: "https://a.example",
				visitor_key: "1:alice",
				visitor_turns_per_hour: 7,
				origin_turns_per_hour: -1,
			}),
		}),
		{
			origin: "https://a.example",
			visitorKey: "1:alice",
			visitorTurnsPerHour: 7,
			originTurnsPerHour: EMBEDDED_TURN_QUOTA_DEFAULTS.originTurnsPerHour,
		},
	);
}

console.log("embedded-turn-quota OK");
