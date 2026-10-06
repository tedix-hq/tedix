/**
 * The service-binding policy-cron reconciliation route: Worker-edge auth,
 * forwarding to the tedi's DO, and the DO's awaited, serialized reconcile.
 */
import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";
import { EDGE_TEDI, edgeFetch, tediRequest } from "../test/tedi-edge";

// --- edge: the internal path is never public; the alias forwards ---
{
	const direct = await edgeFetch(
		tediRequest("/__internal/cron/sync", {
			method: "POST",
			serviceBinding: true,
		}),
	);
	assert.equal(direct.response.status, 404);
	assert.equal(direct.forwarded.length, 0);

	const publicCaller = await edgeFetch(
		tediRequest("/api/cron/sync", { method: "POST" }),
	);
	assert.equal(publicCaller.response.status, 403);
	assert.equal(publicCaller.forwarded.length, 0);

	const forwarded = await edgeFetch(
		tediRequest("/api/cron/sync?forceUpdate=true", {
			method: "POST",
			serviceBinding: true,
		}),
	);
	assert.equal(forwarded.response.status, 200);
	assert.deepEqual(forwarded.doNames, [EDGE_TEDI.isolateAgentId]);
	const [toDo] = forwarded.forwarded;
	assert.ok(toDo);
	const toDoUrl = new URL(toDo.url);
	assert.equal(toDoUrl.pathname, "/__internal/cron/sync");
	assert.equal(toDoUrl.searchParams.get("forceUpdate"), "true");
	assert.equal(toDo.method, "POST");
	assert.equal(toDo.headers.get("X-Tedi-Id"), EDGE_TEDI.id);
	assert.equal(toDo.headers.get("X-Tedi-Slug"), EDGE_TEDI.slug);
}

// --- DO route: suppress the implicit reconcile, await one forced pass ---
const cronSync = (search = "") =>
	new Request(`https://do.internal/__internal/cron/sync${search}`, {
		method: "POST",
		headers: { "X-Tedi-Id": "tedi-1", "X-Tedi-Slug": "acme" },
	});

{
	const seen: { doneDuringIdentity?: boolean; options?: unknown } = {};
	const agent = tediDo({
		env: {},
		cronReconcileDone: false,
		async ensureIdentity(hints: { tediId?: string }) {
			assert.equal(hints.tediId, "tedi-1");
			seen.doneDuringIdentity = agent.cronReconcileDone;
		},
		async reconcilePolicyPackCrons(options: unknown) {
			seen.options = options;
			return { ok: true, appliedCount: 1 };
		},
	});
	const response = await agent.onRequest(cronSync("?forceUpdate=true"));
	assert.equal(
		seen.doneDuringIdentity,
		true,
		"identity resolution must not launch a racing implicit reconcile",
	);
	assert.deepEqual(seen.options, { forceUpdate: true });
	assert.deepEqual(await response.json(), {
		success: true,
		cronBootstrap: { ok: true, appliedCount: 1 },
	});
	assert.equal(agent.cronReconcileDone, true);
}

{
	const agent = tediDo({
		env: {},
		cronReconcileDone: false,
		async ensureIdentity() {},
		async reconcilePolicyPackCrons() {
			return { ok: false, errors: ["policy_read:d1 down"] };
		},
	});
	const response = await agent.onRequest(cronSync());
	assert.deepEqual(await response.json(), {
		success: false,
		cronBootstrap: { ok: false, errors: ["policy_read:d1 down"] },
	});
	assert.equal(
		agent.cronReconcileDone,
		false,
		"a failed pass must leave the implicit reconcile armed for retry",
	);
}

{
	const agent = tediDo({
		env: {},
		cronReconcileDone: false,
		async ensureIdentity() {
			throw new Error("identity unavailable");
		},
	});
	await assert.rejects(agent.onRequest(cronSync()), /identity unavailable/);
	assert.equal(agent.cronReconcileDone, false);
}

// --- reconcile passes serialize through one per-DO queue ---
{
	const events: string[] = [];
	let releaseFirst!: () => void;
	const agent = tediDo({
		cronReconcileQueue: Promise.resolve(),
		reconcilePolicyPackCronsNow(options: { forceUpdate?: boolean }) {
			const label = options.forceUpdate ? "forced" : "startup";
			events.push(`start:${label}`);
			if (label === "startup") {
				return new Promise((resolve) => {
					releaseFirst = () => {
						events.push(`end:${label}`);
						resolve({ ok: true });
					};
				});
			}
			events.push(`end:${label}`);
			return Promise.resolve({ ok: true });
		},
	});
	const first = agent.reconcilePolicyPackCrons();
	const second = agent.reconcilePolicyPackCrons({ forceUpdate: true });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(events, ["start:startup"]);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(events, [
		"start:startup",
		"end:startup",
		"start:forced",
		"end:forced",
	]);
}

// --- a policy read that fails never resurrects opted-out defaults ---
const policyDb = (first: () => Promise<unknown>) => ({
	prepare: () => ({ bind: () => ({ first }) }),
});

{
	const agent = tediDo({
		env: {
			DB: policyDb(async () => {
				throw new Error("d1 down");
			}),
		},
	});
	const load = await agent.loadPolicyPackCronTemplates("tedi-1");
	assert.deepEqual(load, { ok: false, templates: [], error: "d1 down" });
}

// --- an update mints a fresh schedule id (opts out of cron idempotency) ---
{
	const scheduled: Array<{ callback: string; options: unknown }> = [];
	const cancelled: string[] = [];
	const definition = JSON.stringify({
		cronPolicy: {
			disableCognitiveDefaults: true,
			cronTemplates: [
				{ name: "digest", schedule: "0 9 * * *", message: "new text" },
			],
		},
	});
	const agent = tediDo({
		state: { tediId: "tedi-1", slug: "acme" },
		env: {
			DB: policyDb(async () => ({ definition, runtimeOverrides: null })),
		},
		async listSchedules() {
			return [
				{
					id: "old-id",
					callback: "onCronFire",
					type: "cron",
					cron: "0 9 * * *",
					payload: {
						name: "digest",
						message: "old text",
						source: "template",
					},
				},
			];
		},
		async schedule(
			_expr: string,
			callback: string,
			_payload: unknown,
			options: unknown,
		) {
			scheduled.push({ callback, options });
			return { id: "new-id" };
		},
		async cancelSchedule(id: string) {
			cancelled.push(id);
			return true;
		},
	});
	const receipt = await agent.reconcilePolicyPackCronsNow({});
	assert.equal(receipt.ok, true);
	assert.deepEqual(receipt.actions, [{ op: "update", name: "digest" }]);
	assert.deepEqual(scheduled, [
		{ callback: "onCronFire", options: { idempotent: false } },
	]);
	assert.deepEqual(cancelled, ["old-id"]);
}

console.log("cron-sync-route OK");
