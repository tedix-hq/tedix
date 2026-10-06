import { DurableObject } from "cloudflare:workers";
import { RawCutoverDO } from "../../src/pi-cutover-maintenance-do";
import { operateStoredCutover } from "../../src/pi-cutover-admin";
import { RuntimeAdmissionDO } from "../../src/runtime-admission-do";
const claimContexts = new Map<
	string,
	{ ctx: DurableObjectState; db: D1Database }
>();
const actualOriginalClaim = RuntimeAdmissionDO.prototype.assertOriginalClaim;
// Test-only barrier AFTER genuine claim hashing/verification, before its real caller resumes.
RuntimeAdmissionDO.prototype.assertOriginalClaim = async function (input) {
	const accepted = await actualOriginalClaim.call(this, input),
		scope = claimContexts.get(accepted.owner.objectId);
	const race = scope?.ctx.storage.kv.get<string>(
		"fixture:claim-provenance-race",
	);
	if (scope && race) {
		scope.ctx.storage.kv.put("fixture:claim-provenance-verified", {
			runId: accepted.runId,
			generation: accepted.generation,
			requestHash: accepted.requestHash,
		});
		if (race === "canonical")
			await scope.db
				.prepare(
					"UPDATE tedis SET isolate_agent_id='PRIVATE changed during real provenance' WHERE id=?",
				)
				.bind(accepted.owner.tediId)
				.run();
		if (race === "tenant")
			await scope.db
				.prepare(
					"UPDATE tedis SET organization_id='PRIVATE changed during real provenance' WHERE id=?",
				)
				.bind(accepted.owner.tediId)
				.run();
	}
	return accepted;
};
export { RawCutoverDO } from "../../src/pi-cutover-maintenance-do";
export class CaptureRoot extends DurableObject<Cloudflare.Env> {
	/** The binding prototype advertises the RPC, while constructor-selected Raw keeps its actual private brand. */
	async _workflow_handleCallback(input: unknown): Promise<void> {
		return await RawCutoverDO.prototype._workflow_handleCallback.call(
			this as unknown as RawCutoverDO,
			input,
		);
	}

	#reads: Array<{
		kind: string;
		prefix?: string;
		limit?: number;
		key?: string;
	}> = [];
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		claimContexts.set(ctx.id.toString(), { ctx, db: env.DB });
		const selected = {
			...env,
			PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([ctx.id.toString()]),
		};
		if (ctx.storage.kv.get("fixture:raw") === true) {
			let reads = 0;
			const original = selected.DB;
			const db = new Proxy(original, {
				get(target, key) {
					if (key !== "prepare") {
						const value = Reflect.get(target, key);
						return typeof value === "function" ? value.bind(target) : value;
					}
					return (sql: string) => {
						const statement = target.prepare(sql);
						return new Proxy(statement, {
							get(stmt, method) {
								if (method !== "bind") {
									const value = Reflect.get(stmt, method);
									return typeof value === "function" ? value.bind(stmt) : value;
								}
								return (...values: unknown[]) => {
									const bound = stmt.bind(...values);
									return new Proxy(bound, {
										get(query, action) {
											if (action !== "first") {
												const value = Reflect.get(query, action);
												return typeof value === "function"
													? value.bind(query)
													: value;
											}
											return async () => {
												const row = await query.first();
												reads++;
												const race =
													ctx.storage.kv.get<string>("fixture:raw-race");
												if (reads === 2 && race === "owner")
													ctx.storage.sql.exec(
														"UPDATE cf_agents_state SET state=?",
														JSON.stringify({
															tediId: "PRIVATE",
															orgId: "PRIVATE",
														}),
													);
												if (reads === 2 && race === "epoch")
													ctx.storage.sql.exec(
														"UPDATE runtime_admission SET record=json_set(record,'$.generation',99)",
													);
												if (reads === 1 && race === "canonical")
													await original
														.prepare(
															"UPDATE tedis SET isolate_agent_id='PRIVATE' WHERE isolate_agent_id=?",
														)
														.bind(ctx.storage.kv.get("__ps_name"))
														.run();
												if (reads === 1 && race === "d1Owner")
													await original
														.prepare(
															"UPDATE tedis SET organization_id='PRIVATE' WHERE isolate_agent_id=?",
														)
														.bind(ctx.storage.kv.get("__ps_name"))
														.run();
												return row;
											};
										},
									});
								};
							},
						});
					};
				},
			});
			// Preserve the actual native DurableObjectState brand for production Raw construction.
			const receiver = new RawCutoverDO(ctx, { ...selected, DB: db });
			const sql = ctx.storage.sql;
			const exec = sql.exec.bind(sql);
			let sealAttempts = 0,
				refsAtFailure = 0;
			Object.defineProperty(sql, "fixtureSealAttempts", {
				get: () => sealAttempts,
			});
			Object.defineProperty(sql, "fixtureRefsAtFailure", {
				get: () => refsAtFailure,
			});
			Object.defineProperty(sql, "exec", {
				value: (query: string, ...values: SqlStorageValue[]) => {
					if (
						ctx.storage.kv.get("fixture:fail-seal") === true &&
						query.startsWith("INSERT INTO historical_replay_seals")
					) {
						sealAttempts++;
						refsAtFailure = exec<{ count: number }>(
							"SELECT COUNT(*) AS count FROM historical_liability_refs",
						).toArray()[0]!.count;
						throw Error("PRIVATE late seal failure");
					}
					return exec(query, ...values);
				},
			});
			return receiver as unknown as CaptureRoot;
		}
		super(ctx, selected);
	}
	accesses() {
		return this.#reads;
	}
	async fetch(request: Request) {
		const actual = this.ctx.storage,
			reads = this.#reads;
		let reading = false;
		const kv = {
			get<T>(key: string): T | undefined {
				reads.push({ kind: "get", key });
				if (key.startsWith("private:irrelevant"))
					throw Error("Private irrelevant value accessed");
				return actual.kv.get<T>(key);
			},
			list<T>(options?: SyncKvListOptions): Iterable<[string, T]> {
				if (!options?.prefix || options.limit !== 1)
					throw Error("Unbounded KV listing");
				reads.push({
					kind: "list",
					prefix: options.prefix,
					limit: options.limit,
				});
				return {
					*[Symbol.iterator]() {
						if (reading) throw Error("Previous selected iterator still live");
						reading = true;
						try {
							for (const pair of actual.kv.list<T>(options)) {
								reads.push({ kind: "item", key: pair[0] });
								if (
									pair[0].startsWith("private:irrelevant") ||
									pair[0] === "cf_agents_is_facet_PRIVATE"
								)
									throw Error("Private irrelevant value accessed");
								yield pair;
							}
						} finally {
							reading = false;
						}
					},
				};
			},
		};
		const storage = new Proxy(actual, {
			get(target, key) {
				if (key === "kv") return kv;
				const v = Reflect.get(target, key);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const ctx = new Proxy(this.ctx, {
			get(target, key) {
				if (key === "storage") return storage;
				const v = Reflect.get(target, key);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const original = this.env.DB;
		let calls = 0;
		const db = {
			prepare(sql: string) {
				const stmt = original.prepare(sql);
				return {
					bind(...values: unknown[]) {
						const bound = stmt.bind(...values);
						return {
							async first<T>() {
								const row = await bound.first<T>();
								calls++;
								const race = actual.kv.get<string>("fixture:race");
								if (calls === 1 && race === "owner")
									actual.sql.exec(
										"UPDATE cf_agents_state SET state=?",
										JSON.stringify({ tediId: "foreign", orgId: "foreign" }),
									);
								if (calls === 1 && race === "name")
									actual.kv.put("__ps_name", "foreign");
								if (calls === 1 && race === "epoch")
									actual.sql.exec(
										"UPDATE runtime_admission SET record=json_set(record,'$.generation',99)",
									);
								if (calls === 2 && race === "canonical")
									await original
										.prepare(
											"UPDATE tedis SET isolate_agent_id='foreign' WHERE isolate_agent_id=?",
										)
										.bind(actual.kv.get("__ps_name"))
										.run();
								return row;
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		return operateStoredCutover({ ctx, env: { ...this.env, DB: db }, request });
	}
}
export default {
	fetch() {
		return new Response("Not found", { status: 404 });
	},
};
