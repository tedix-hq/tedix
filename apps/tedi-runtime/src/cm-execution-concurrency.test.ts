import assert from "node:assert/strict";
import { CmSessionGate, type CmSessionGateStorage } from "./cm-execution-gate";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class DeferredStorage implements CmSessionGateStorage {
	readonly values = new Map<string, string>();
	getError = false;
	putError = false;
	private pendingPut:
		| {
				entered: ReturnType<typeof deferred>;
				release: ReturnType<typeof deferred>;
		  }
		| undefined;

	holdNextPut() {
		const pending = { entered: deferred(), release: deferred() };
		this.pendingPut = pending;
		return pending;
	}

	async get(key: string): Promise<unknown> {
		if (this.getError) {
			this.getError = false;
			throw new Error("get rejected");
		}
		return this.values.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		const pending = this.pendingPut;
		this.pendingPut = undefined;
		if (pending) {
			pending.entered.resolve();
			await pending.release.promise;
		}
		if (this.putError) {
			this.putError = false;
			throw new Error("put rejected");
		}
		this.values.set(key, value);
	}
}

const replay = (id: string) => ({
	sessionKey: "session",
	codeHash: `hash-${id}`,
	sourceExecutionId: `execution-${id}`,
	authorizedBy: "operator",
});

// Hold the first consumer's persistence while a second gate consumes the same grant.
{
	const storage = new DeferredStorage();
	const first = new CmSessionGate(storage);
	const second = new CmSessionGate(storage);
	await first.authorizeReplay(replay("a"));
	const pending = storage.holdNextPut();
	const a = first.consumeReplayGrant("session", "hash-a").then((grant) => {
		assert.equal(
			storage.values.get("cm_execution_replay_grants"),
			"[]",
			"consumption must persist before returning authority",
		);
		return grant;
	});
	await pending.entered.promise;
	const b = second.consumeReplayGrant("session", "hash-a");
	pending.release.resolve();
	const results = await Promise.all([a, b]);
	assert.equal(
		results.filter(Boolean).length,
		1,
		"one grant must authorize exactly one overlapping consumer",
	);
	assert.deepEqual(results.find(Boolean), {
		sourceExecutionId: "execution-a",
		authorizedBy: "operator",
	});
}

// Distinct concurrent authorizations and consumes cannot erase or resurrect peers.
{
	const storage = new DeferredStorage();
	const first = new CmSessionGate(storage);
	const second = new CmSessionGate(storage);
	await first.authorizeReplay(replay("unrelated"));
	const pending = storage.holdNextPut();
	const a = first.authorizeReplay(replay("a"));
	await pending.entered.promise;
	const b = second.authorizeReplay(replay("b"));
	pending.release.resolve();
	await Promise.all([a, b]);

	const consuming = storage.holdNextPut();
	const consumedA = first.consumeReplayGrant("session", "hash-a");
	await consuming.entered.promise;
	const consumedB = second.consumeReplayGrant("session", "hash-b");
	consuming.release.resolve();
	assert.deepEqual(await Promise.all([consumedA, consumedB]), [
		{ sourceExecutionId: "execution-a", authorizedBy: "operator" },
		{ sourceExecutionId: "execution-b", authorizedBy: "operator" },
	]);
	assert.equal(await first.consumeReplayGrant("session", "hash-a"), null);
	assert.equal(await second.consumeReplayGrant("session", "hash-b"), null);
	assert.equal(
		(await first.consumeReplayGrant("session", "hash-unrelated"))
			?.sourceExecutionId,
		"execution-unrelated",
	);
}

// Authorize/consume overlap retains exact binding and grants for other sessions.
{
	const storage = new DeferredStorage();
	const first = new CmSessionGate(storage);
	const second = new CmSessionGate(storage);
	await first.authorizeReplay({ ...replay("a"), sessionKey: "other-session" });
	const pending = storage.holdNextPut();
	const authorization = first.authorizeReplay(replay("a"));
	await pending.entered.promise;
	const consumption = second.consumeReplayGrant("session", "hash-a");
	pending.release.resolve();
	await authorization;
	assert.deepEqual(await consumption, {
		sourceExecutionId: "execution-a",
		authorizedBy: "operator",
	});
	assert.equal(await first.consumeReplayGrant("session", "hash-changed"), null);
	assert.equal(
		(await second.consumeReplayGrant("other-session", "hash-a"))
			?.sourceExecutionId,
		"execution-a",
	);
	assert.equal(await second.isSessionAuthorized("session"), false);
}

// Revoke cannot overwrite a concurrent authorization of another session.
{
	const storage = new DeferredStorage();
	const first = new CmSessionGate(storage);
	const second = new CmSessionGate(storage);
	await first.authorizeSession("revoked", "operator");
	await first.authorizeSession("unrelated", "operator");
	const pending = storage.holdNextPut();
	const revocation = first.revokeSession("revoked");
	await pending.entered.promise;
	const authorization = second.authorizeSession("new", "operator");
	pending.release.resolve();
	await Promise.all([revocation, authorization]);
	assert.equal(await first.isSessionAuthorized("revoked"), false);
	assert.equal(await first.isSessionAuthorized("new"), true);
	assert.equal(await first.isSessionAuthorized("unrelated"), true);

	const reauthorizing = storage.holdNextPut();
	const revokeAgain = first.revokeSession("new");
	await reauthorizing.entered.promise;
	const reauthorize = second.authorizeSession("new", "operator");
	reauthorizing.release.resolve();
	await Promise.all([revokeAgain, reauthorize]);
	assert.equal(await first.isSessionAuthorized("new"), true);
}

// Consumption returns no authority until its write succeeds; rejection unblocks
// a queued consumer without removing the original or unrelated grant.
{
	const storage = new DeferredStorage();
	const first = new CmSessionGate(storage);
	const second = new CmSessionGate(storage);
	await first.authorizeReplay(replay("a"));
	await first.authorizeReplay(replay("unrelated"));
	const pending = storage.holdNextPut();
	storage.putError = true;
	let returnedAuthority = false;
	const failed = first.consumeReplayGrant("session", "hash-a").then((grant) => {
		returnedAuthority = grant !== null;
		return grant;
	});
	const rejected = assert.rejects(failed, /put rejected/);
	await pending.entered.promise;
	assert.equal(returnedAuthority, false);
	const retry = second.consumeReplayGrant("session", "hash-a");
	pending.release.resolve();
	await rejected;
	assert.equal(returnedAuthority, false);
	assert.equal((await retry)?.sourceExecutionId, "execution-a");
	assert.equal(
		(await first.consumeReplayGrant("session", "hash-unrelated"))
			?.sourceExecutionId,
		"execution-unrelated",
	);
	assert.equal(await second.consumeReplayGrant("session", "hash-a"), null);
}

// A failed read must not write an empty array over unrelated live grants.
// Every mutating operation also releases the shared queue after get/put errors.
for (const failure of ["getError", "putError"] as const) {
	for (const operation of [
		"authorizeSession",
		"authorizeReplay",
		"revokeSession",
		"consumeReplayGrant",
	] as const) {
		const storage = new DeferredStorage();
		const gate = new CmSessionGate(storage);
		const peer = new CmSessionGate(storage);
		await gate.authorizeSession("existing", "operator");
		await gate.authorizeReplay(replay("existing"));
		const before = new Map(storage.values);
		storage[failure] = true;
		const attempt =
			operation === "authorizeSession"
				? gate.authorizeSession("new", "operator")
				: operation === "authorizeReplay"
					? gate.authorizeReplay(replay("new"))
					: operation === "revokeSession"
						? gate.revokeSession("existing")
						: gate.consumeReplayGrant("session", "hash-existing");
		await assert.rejects(
			attempt,
			failure === "getError" ? /get rejected/ : /put rejected/,
		);
		assert.deepEqual(
			storage.values,
			before,
			`${operation} preserves storage on ${failure}`,
		);
		await peer.authorizeSession("later", "operator");
		assert.equal(await peer.isSessionAuthorized("existing"), true);
		assert.equal(await peer.isSessionAuthorized("later"), true);
		assert.equal(
			(await peer.consumeReplayGrant("session", "hash-existing"))
				?.sourceExecutionId,
			"execution-existing",
		);
	}
}

// Reads remain fail-closed, and queued consumption evaluates TTL after waiting.
{
	let now = 1000;
	const storage = new DeferredStorage();
	const gate = new CmSessionGate(storage, () => now);
	const peer = new CmSessionGate(storage, () => now);
	await gate.authorizeSession("session", "operator");
	storage.getError = true;
	assert.equal(await gate.isSessionAuthorized("session"), false);
	assert.equal(await gate.isSessionAuthorized("session"), true);
	await gate.authorizeReplay({ ...replay("a"), ttlMs: 10 });
	const pending = storage.holdNextPut();
	const blocking = gate.authorizeSession("other", "operator");
	await pending.entered.promise;
	const consumption = peer.consumeReplayGrant("session", "hash-a");
	now += 10;
	pending.release.resolve();
	await blocking;
	assert.equal(await consumption, null);
	storage.values.set("cm_session_allowlist", "invalid json");
	assert.equal(await gate.isSessionAuthorized("session"), false);
	storage.values.set("cm_execution_replay_grants", "invalid json");
	assert.equal(await gate.consumeReplayGrant("session", "hash-a"), null);
}

console.log("cm-execution-concurrency.test.ts OK");
