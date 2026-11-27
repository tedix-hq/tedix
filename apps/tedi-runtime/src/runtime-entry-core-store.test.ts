import assert from "node:assert/strict";
import {
	coreQueryDb,
	SCHEDULED_CLOSE_DELAY_MS,
} from "@tedix/db/core-store/scope";
import { tediDo } from "../test/tedi-do";

// Exercise the real entry methods and scope. Database and provider execution
// remain the DB session's integration check; postgres.js opens lazily here.
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
	if (args[1] === SCHEDULED_CLOSE_DELAY_MS) args[1] = 0;
	return originalSetTimeout(...args);
}) as typeof setTimeout;

try {
	for (const CORE_STORE of ["d1", "postgres"]) {
		const env = {
			CORE_STORE,
			DB: {} as D1Database,
			CORE_HYPERDRIVE: {
				connectionString: "postgres://127.0.0.1:1/fixture",
			},
		};
		const scheduled: Promise<unknown>[] = [];
		const reads: object[] = [];
		const read = async () => {
			await Promise.resolve();
			const db = coreQueryDb(env);
			reads.push(db);
		};
		const agent = tediDo({
			env,
			state: { tediId: "fixture-tedi", orgId: "fixture-org" },
			ctx: {
				waitUntil: (promise: Promise<unknown>) => scheduled.push(promise),
			},
			ensureIdentity: read,
			maintenance: { ensure: async () => true, run: read },
			eventOutbox: { ensureRedrive: read },
			nativeTelegram: async () => null,
			poppy: { recover: read },
			hintsFromHeaders: () => ({}),
			subAgent: async () => ({
				historyMessages: async () => {
					await read();
					return [{ id: "fixture-message" }];
				},
			}),
		});

		await agent.onStart();
		assert.equal(reads.length, 3, "startup and its background work can read");
		if (CORE_STORE === "postgres") {
			assert.equal(new Set(reads).size, 1, "startup shares one scoped client");
			assert.throws(() => coreQueryDb(env), /requires a withCoreStore scope/);
			assert.equal(
				scheduled.length,
				2,
				"background work and close use waitUntil",
			);
		}
		await Promise.all(scheduled.splice(0));
		reads.length = 0;

		const response = await agent.onRequest(
			new Request("https://fixture.invalid/get-messages", {
				headers: {
					"X-Tedi-Auth-Subject": "fixture-user",
					"X-Tedi-Auth-TediId": "fixture-tedi",
				},
			}),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), [{ id: "fixture-message" }]);
		assert.equal(reads.length, 2, "request identity and history can read");
		if (CORE_STORE === "postgres") {
			assert.equal(new Set(reads).size, 1, "request shares one scoped client");
			assert.equal(scheduled.length, 1, "request close uses waitUntil");
			assert.throws(() => coreQueryDb(env), /requires a withCoreStore scope/);
		}
		await Promise.all(scheduled.splice(0));
		await agent.onParentMaintenance({}, {});
		await Promise.all(scheduled.splice(0));
	}
} finally {
	globalThis.setTimeout = originalSetTimeout;
}

console.log("Runtime entry core-store scopes passed on Postgres and D1");
