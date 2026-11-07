import { describe, expect, it } from "vite-plus/test";
import type {
	AgentAlarm,
	AgentEvent,
	AgentJurisdiction,
	AgentRuntime,
} from "./index";

/**
 * How the suite reaches one implementation. The runtime lives inside the
 * agent object, so every step runs there; the harness also opens a client
 * WebSocket and fires the host alarm from outside, as a real client and the
 * real host would.
 */
export interface AgentRuntimeConformanceHarness {
	readonly jurisdiction: AgentJurisdiction;
	/** Runs `fn` inside the agent object named `objectId`. */
	withRuntime<T>(
		objectId: string,
		fn: (runtime: AgentRuntime) => Promise<T>,
	): Promise<T>;
	/** A client WebSocket on the object's events route, not yet accepted. */
	connect(objectId: string, after?: number): Promise<WebSocket>;
	/** Runs the host alarm if one is armed. */
	fireAlarm(objectId: string): Promise<void>;
	/** The alarms the object's handler has received, oldest first. */
	firedAlarms(objectId: string): Promise<AgentAlarm[]>;
	/**
	 * The name of a registered binding whose stub has `add(a, b)` returning
	 * `a + b`, so the suite can prove a binding call crosses the sandbox.
	 */
	readonly adderBinding: string;
}

/**
 * A client that buffers every message from the moment it accepts the socket,
 * so a replay sent before the test looks is never lost.
 */
class EventClient {
	private readonly queue: unknown[] = [];
	private waiting: ((message: unknown) => void) | undefined;

	constructor(readonly ws: WebSocket) {
		ws.addEventListener("message", (event) => {
			const message: unknown = JSON.parse(String(event.data));
			if (this.waiting) {
				const resolve = this.waiting;
				this.waiting = undefined;
				resolve(message);
			} else {
				this.queue.push(message);
			}
		});
		ws.accept();
	}

	next(timeoutMs = 2_000): Promise<unknown> {
		const queued = this.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("No WebSocket message arrived")),
				timeoutMs,
			);
			this.waiting = (message) => {
				clearTimeout(timer);
				resolve(message);
			};
		});
	}
}

async function waitFor<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	timeoutMs = 2_000,
): Promise<T> {
	const until = Date.now() + timeoutMs;
	let value = await read();
	while (!done(value) && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		value = await read();
	}
	return value;
}

/**
 * The one behaviour contract every implementation passes. Each test uses its
 * own object id, so tests never share state.
 */
export function describeAgentRuntimeConformance(
	label: string,
	harness: AgentRuntimeConformanceHarness,
): void {
	let counter = 0;
	const fresh = () => `${label}-${Date.now()}-${(counter += 1)}`;

	describe(`${label} agent runtime`, () => {
		it("reports its object id and jurisdiction", async () => {
			const id = fresh();
			const seen = await harness.withRuntime(id, async (runtime) => ({
				objectId: runtime.objectId,
				jurisdiction: runtime.jurisdiction,
			}));
			expect(seen).toEqual({
				objectId: id,
				jurisdiction: harness.jurisdiction,
			});
		});

		describe("storage", () => {
			it("writes and reads rows", async () => {
				const rows = await harness.withRuntime(fresh(), async ({ storage }) => {
					await storage.exec(
						"CREATE TABLE notes (note_id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
					);
					const written = await storage.exec(
						"INSERT INTO notes (body) VALUES (?), (?)",
						["one", "two"],
					);
					expect(written.rowsWritten).toBe(2);
					return storage.query<{ body: string }>(
						"SELECT body FROM notes ORDER BY note_id",
					);
				});
				expect(rows).toEqual([{ body: "one" }, { body: "two" }]);
			});

			it("rolls a failing batch back entirely", async () => {
				const rows = await harness.withRuntime(fresh(), async ({ storage }) => {
					await storage.exec(
						"CREATE TABLE items (item_id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)",
					);
					await storage.exec("INSERT INTO items (label) VALUES ('kept')");
					await expect(
						storage.batch([
							{ sql: "INSERT INTO items (label) VALUES (?)", params: ["new"] },
							{ sql: "INSERT INTO items (label) VALUES (?)", params: ["kept"] },
						]),
					).rejects.toThrow();
					return storage.query<{ label: string }>(
						"SELECT label FROM items ORDER BY item_id",
					);
				});
				expect(rows).toEqual([{ label: "kept" }]);
			});

			it("applies each migration once, in order, and records it", async () => {
				const id = fresh();
				const migrations = [
					{
						name: "001-notes",
						statements: ["CREATE TABLE notes (note_id INTEGER PRIMARY KEY)"],
					},
					{
						name: "002-notes-body",
						statements: ["ALTER TABLE notes ADD COLUMN body TEXT"],
					},
				];
				const first = await harness.withRuntime(id, ({ storage }) =>
					storage.migrate(migrations),
				);
				expect(first).toEqual(["001-notes", "002-notes-body"]);
				const second = await harness.withRuntime(id, ({ storage }) =>
					storage.migrate([
						...migrations,
						{
							name: "003-tags",
							statements: ["CREATE TABLE tags (tag TEXT PRIMARY KEY)"],
						},
					]),
				);
				expect(second).toEqual(["003-tags"]);
				const applied = await harness.withRuntime(id, ({ storage }) =>
					storage.appliedMigrations(),
				);
				expect(applied).toEqual(["001-notes", "002-notes-body", "003-tags"]);
			});

			it("refuses a migration list with a repeated name", async () => {
				await expect(
					harness.withRuntime(fresh(), ({ storage }) =>
						storage.migrate([
							{ name: "same", statements: [] },
							{ name: "same", statements: [] },
						]),
					),
				).rejects.toThrow(/listed twice/);
			});
		});

		describe("bindings", () => {
			it("describes a binding with its whole declaration in one call", async () => {
				const text = await harness.withRuntime(
					fresh(),
					async ({ bindings }) => {
						bindings.register({
							name: "MAILBOX",
							description: "The workspace's mailbox.",
							declaration:
								"interface Mailbox {\n  send(to: string, body: string): Promise<void>;\n}",
							stub: {},
						});
						return bindings.describe("MAILBOX");
					},
				);
				expect(text).toContain("Binding: MAILBOX");
				expect(text).toContain("The workspace's mailbox.");
				expect(text).toContain(
					"send(to: string, body: string): Promise<void>;",
				);
			});

			it("names the registered bindings when one is unknown", async () => {
				await expect(
					harness.withRuntime(fresh(), async ({ bindings }) => {
						bindings.register({
							name: "KNOWN",
							description: "A binding.",
							declaration: "type Known = {}",
							stub: {},
						});
						return bindings.describe("MISSING");
					}),
				).rejects.toThrow(/MISSING.*KNOWN/s);
			});

			it("rejects names the sandbox could not use safely", async () => {
				const outcomes = await harness.withRuntime(
					fresh(),
					async ({ bindings }) => {
						const attempt = (name: string) => {
							try {
								bindings.register({
									name,
									description: "x",
									declaration: "type X = {}",
									stub: {},
								});
								return "accepted";
							} catch (error) {
								return error instanceof Error ? error.message : String(error);
							}
						};
						return [
							attempt("lowercase"),
							attempt("__PROTO__"),
							attempt("HAS_OWN_PROPERTY".toLowerCase()),
							attempt("OK_1"),
						];
					},
				);
				expect(outcomes[0]).toMatch(/must match/);
				expect(outcomes[1]).toMatch(/must match/);
				expect(outcomes[2]).toMatch(/must match/);
				expect(outcomes[3]).toBe("accepted");
			});

			it("lists a catalog of every binding", async () => {
				const catalog = await harness.withRuntime(
					fresh(),
					async ({ bindings }) => {
						bindings.register({
							name: "B_ONE",
							description: "First.",
							declaration: "type One = {}",
							stub: {},
						});
						bindings.register({
							name: "A_TWO",
							description: "Second.",
							declaration: "type Two = {}",
							stub: {},
						});
						return {
							text: bindings.catalog(),
							names: bindings.list().map((b) => b.name),
						};
					},
				);
				expect(catalog.names).toEqual(
					["A_TWO", "B_ONE", harness.adderBinding].sort((a, b) =>
						a.localeCompare(b),
					),
				);
				expect(catalog.text).toContain("env.A_TWO: Second.");
				expect(catalog.text).toContain("env.B_ONE: First.");
			});
		});

		describe("sandbox", () => {
			it("returns the snippet's value and its console output", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `console.log("working", { n: 1 }); return { sum: 1 + 2 };`,
					}),
				);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.value).toEqual({ sum: 3 });
				expect(result.logs).toEqual(['log: working {"n":1}']);
				expect(result.truncated).toBe(false);
			});

			it("accepts a module with a default export", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `export default async function (env) { return Object.keys(env).sort(); }`,
						bindings: [],
					}),
				);
				expect(result).toMatchObject({ ok: true, value: [] });
			});

			it("calls a binding through env", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `return await env.${harness.adderBinding}.add(20, 22);`,
					}),
				);
				expect(result).toMatchObject({ ok: true, value: 42 });
			});

			it("exposes only the bindings a run asks for", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `return typeof env.${harness.adderBinding};`,
						bindings: [],
					}),
				);
				expect(result).toMatchObject({ ok: true, value: "undefined" });
			});

			it("has no network", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `const response = await fetch("https://example.com/"); return response.status;`,
					}),
				);
				expect(result.ok).toBe(false);
			});

			it("exposes no bindings through the importable env", async () => {
				// The bindings travel as the run call's argument, never through the
				// manifest env, so an import of `env` finds nothing to reach.
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `import { env } from "cloudflare:workers";\nexport default async () => Object.keys(env ?? {});`,
					}),
				);
				expect(result).toMatchObject({ ok: true, value: [] });
			});

			it("reports a thrown error with its logs", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `console.warn("about to fail"); throw new Error("boom");`,
					}),
				);
				expect(result).toMatchObject({
					ok: false,
					reason: "error",
					logs: ["warn: about to fail"],
				});
				if (!result.ok) expect(result.error).toContain("boom");
			});

			it("stops at the time limit", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `await new Promise((resolve) => setTimeout(resolve, 5000)); return 1;`,
						limits: { timeoutMs: 100 },
					}),
				);
				expect(result).toMatchObject({ ok: false, reason: "timeout" });
			});

			it("cuts a result past the size limit and says so", async () => {
				const result = await harness.withRuntime(fresh(), ({ sandbox }) =>
					sandbox.run({
						code: `return "x".repeat(1000);`,
						limits: { maxResultChars: 10 },
					}),
				);
				expect(result).toMatchObject({ ok: true, truncated: true });
				if (result.ok) expect(String(result.value)).toHaveLength(10);
			});
		});

		describe("events", () => {
			it("numbers events, replays after a cursor and reports the head", async () => {
				const seen = await harness.withRuntime(fresh(), async ({ events }) => {
					const first = await events.publish({ type: "a", payload: { n: 1 } });
					const second = await events.publish({ type: "b", payload: "two" });
					return {
						cursors: [first.cursor, second.cursor],
						replay: await events.replay(first.cursor),
						head: await events.head(),
					};
				});
				expect(seen.cursors).toEqual([1, 2]);
				expect(seen.replay).toMatchObject([
					{ cursor: 2, type: "b", payload: "two" },
				]);
				expect(seen.head).toBe(2);
			});

			it("replays missed events to a subscriber, then delivers live ones", async () => {
				const received = await harness.withRuntime(
					fresh(),
					async ({ events }) => {
						await events.publish({ type: "before", payload: 1 });
						const got: AgentEvent[] = [];
						const stop = await events.subscribe((event) => got.push(event), {
							after: 0,
						});
						await events.publish({ type: "live", payload: 2 });
						stop();
						await events.publish({ type: "after-stop", payload: 3 });
						return got.map((e) => e.type);
					},
				);
				expect(received).toEqual(["before", "live"]);
			});

			it("pushes stored and live events to a connected client", async () => {
				const id = fresh();
				await harness.withRuntime(id, ({ events }) =>
					events.publish({ type: "stored", payload: null }),
				);
				const client = new EventClient(await harness.connect(id, 0));
				const stored = await client.next();
				expect(stored).toMatchObject({
					kind: "event",
					cursor: 1,
					type: "stored",
				});
				const connections = await harness.withRuntime(
					id,
					async ({ events }) => {
						const count = events.connections();
						await events.publish({ type: "live", payload: { ok: true } });
						return count;
					},
				);
				expect(connections).toBe(1);
				const live = await client.next();
				expect(live).toMatchObject({ kind: "event", cursor: 2, type: "live" });
				client.ws.send(JSON.stringify({ kind: "replay", after: 1 }));
				const replayed = await client.next();
				expect(replayed).toMatchObject({ kind: "event", cursor: 2 });
				client.ws.close();
			});
		});

		describe("alarms", () => {
			it("keeps alarms sorted and cancels by id", async () => {
				const seen = await harness.withRuntime(fresh(), async ({ alarms }) => {
					const later = await alarms.schedule(Date.now() + 60_000, "later");
					const sooner = await alarms.schedule(Date.now() + 30_000, "sooner");
					const ordered = (await alarms.list()).map((a) => a.payload);
					const cancelled = await alarms.cancel(later.id);
					const again = await alarms.cancel(later.id);
					return {
						ordered,
						cancelled,
						again,
						left: (await alarms.list()).map((a) => a.id),
						sooner: sooner.id,
					};
				});
				expect(seen.ordered).toEqual(["sooner", "later"]);
				expect(seen.cancelled).toBe(true);
				expect(seen.again).toBe(false);
				expect(seen.left).toEqual([seen.sooner]);
			});

			it("delivers due alarms through the host timer and keeps the rest", async () => {
				const id = fresh();
				const future = await harness.withRuntime(id, async ({ alarms }) => {
					await alarms.schedule(Date.now() - 1, { job: "due" });
					return alarms.schedule(Date.now() + 60_000, { job: "later" });
				});
				// The host may run a past-due alarm on its own before the harness
				// asks, so wait for the delivery rather than for the helper.
				await harness.fireAlarm(id);
				const fired = await waitFor(
					() => harness.firedAlarms(id),
					(alarms) => alarms.length > 0,
				);
				expect(fired.map((a) => a.payload)).toEqual([{ job: "due" }]);
				const left = await harness.withRuntime(id, ({ alarms }) =>
					alarms.list(),
				);
				expect(left.map((a) => a.id)).toEqual([future.id]);
			});
		});
	});
}
