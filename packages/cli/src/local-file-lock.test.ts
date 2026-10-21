import { afterEach, describe, expect, test } from "bun:test";
import { fork, type ChildProcess } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginFileLock, withFileLockSync } from "./local-file-lock";

// Each child imports only the primitive, with no CLI setup or credential access.
const childSource = `
import { beginFileLock } from ${JSON.stringify(new URL("./local-file-lock.ts", import.meta.url).pathname)};
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv[2];
const counter = process.argv[3];
const acknowledgments = new Map();
let serial = 0;
let lock;
const lifetime = setTimeout(() => process.exit(2), 20_000);
const observe = (event) => new Promise((resolve) => {
	const sequence = ++serial;
	acknowledgments.set(sequence, resolve);
	process.send({ event, sequence });
});
process.on("message", async (message) => {
	if (message.ack !== undefined) {
		acknowledgments.get(message.ack)?.();
		acknowledgments.delete(message.ack);
		return;
	}
	try {
		let value;
		switch (message.command) {
			case "ping": value = process.pid; break;
			case "begin":
				lock = beginFileLock(directory);
				value = readdirSync(directory).find((name) => name.startsWith(process.pid + "-"));
				break;
			case "ready": value = lock.ready(); break;
			case "release": lock.release(); break;
			case "peer":
				writeFileSync(join(directory, message.name), JSON.stringify({ pid: process.pid, ticket: message.ticket }));
				break;
			case "run":
				for (let round = 0; round < message.rounds; round++) {
					if (round > 0) lock = beginFileLock(directory);
					try {
						while (!lock.ready()) await new Promise((resolve) => setTimeout(resolve, 1));
						await observe("enter");
						const value = Number(readFileSync(counter, "utf8"));
						await new Promise((resolve) => setImmediate(resolve));
						writeFileSync(counter, String(value + 1));
						await observe("leave");
					} finally { lock.release(); }
				}
				break;
			default: throw new Error("Unknown fixture command");
		}
		process.send({ id: message.id, value });
	} catch (error) {
		process.send({ id: message.id, error: String(error) });
	}
});
process.on("disconnect", () => { clearTimeout(lifetime); process.exit(0); });
`;

interface Message {
	id?: number;
	value?: unknown;
	error?: string;
	event?: "enter" | "leave";
	sequence?: number;
}

const fixtures: Array<{ directory: string; children: ChildProcess[] }> = [];

afterEach(async () => {
	for (const { directory, children } of fixtures.splice(0)) {
		await Promise.all(
			children.map(async (child) => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				const exited = new Promise<void>((resolve) =>
					child.once("exit", () => resolve()),
				);
				child.kill("SIGKILL");
				await exited;
			}),
		);
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "tedix-file-lock-test-"));
	const locks = join(directory, "locks");
	const counter = join(directory, "counter");
	const script = join(directory, "contender.ts");
	const children: ChildProcess[] = [];
	fixtures.push({ directory, children });
	mkdirSync(locks);
	writeFileSync(counter, "0");
	writeFileSync(script, childSource);
	const observed = { inside: 0, peak: 0, entries: 0, overlaps: 0 };
	return {
		locks,
		counter,
		observed,
		child() {
			const child = fork(script, [locks, counter], {
				execPath: process.execPath,
				execArgv: [],
				cwd: directory,
				env: {
					PATH: process.env.PATH,
					HOME: directory,
					TEDIX_CONFIG_DIR: directory,
				},
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			});
			children.push(child);
			let serial = 0;
			const pending = new Map<
				number,
				{ resolve: (value: unknown) => void; reject: (error: Error) => void }
			>();
			child.on("message", (raw) => {
				const message = raw as Message;
				if (message.event) {
					if (message.event === "enter") {
						observed.inside++;
						observed.entries++;
						observed.peak = Math.max(observed.peak, observed.inside);
						if (observed.inside > 1) observed.overlaps++;
					} else observed.inside--;
					// Acknowledge leave before the child releases: cross-process IPC
					// delivery order cannot manufacture an apparent overlap.
					child.send({ ack: message.sequence });
				} else if (message.id !== undefined) {
					const request = pending.get(message.id);
					pending.delete(message.id);
					if (message.error) request?.reject(new Error(message.error));
					else request?.resolve(message.value);
				}
			});
			const fail = (error: Error) => {
				for (const request of pending.values()) request.reject(error);
				pending.clear();
			};
			child.on("error", fail);
			child.on("exit", (code, signal) =>
				fail(new Error(`Fixture exited: ${code}/${signal}`)),
			);
			return {
				process: child,
				async call(
					command: string,
					args: Record<string, unknown> = {},
				): Promise<unknown> {
					const id = ++serial;
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						return await new Promise((resolve, reject) => {
							pending.set(id, { resolve, reject });
							timer = setTimeout(() => {
								pending.delete(id);
								reject(new Error(`Fixture command timed out: ${command}`));
							}, 10_000);
							child.send({ id, command, ...args }, (error) => {
								if (error) {
									pending.delete(id);
									reject(error);
								}
							});
						});
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

describe("local file-lock bakery protocol", () => {
	for (const repetition of [1, 2, 3]) {
		test(`simultaneous processes exclude each other (run ${repetition})`, async () => {
			const f = fixture();
			const children = Array.from({ length: 4 }, () => f.child());
			// Start acquisition only after every child acknowledges the IPC barrier.
			await Promise.all(children.map((child) => child.call("ping")));
			const names = await Promise.all(
				children.map((child) => child.call("begin")),
			);
			expect(new Set(names).size).toBe(4);
			expect(readdirSync(f.locks)).toHaveLength(4);
			const ready = await Promise.all(
				children.map((child) => child.call("ready")),
			);
			expect(ready.filter(Boolean)).toHaveLength(1);
			await Promise.all(
				children.map((child) => child.call("run", { rounds: 6 })),
			);
			expect(f.observed).toEqual({
				inside: 0,
				peak: 1,
				entries: 24,
				overlaps: 0,
			});
			expect(readFileSync(f.counter, "utf8")).toBe("24");
			expect(readdirSync(f.locks)).toEqual([]);
		}, 20_000);
	}

	test("ticket zero blocks until a live choosing peer publishes its ticket", async () => {
		const f = fixture();
		const peer = f.child();
		await peer.call("peer", { name: "choosing.json", ticket: 0 });
		const lock = beginFileLock(f.locks);
		try {
			expect(lock.ready()).toBe(false);
			expect(
				JSON.parse(readFileSync(join(f.locks, "choosing.json"), "utf8")).ticket,
			).toBe(0);
			await peer.call("peer", { name: "choosing.json", ticket: 2 });
			expect(lock.ready()).toBe(true);
		} finally {
			lock.release();
		}
	}, 20_000);

	test("equal tickets use claim names in both tie-break directions", async () => {
		const f = fixture();
		const peer = f.child();
		const lock = beginFileLock(f.locks);
		const ownName = readdirSync(f.locks)[0]!;
		try {
			expect(
				JSON.parse(readFileSync(join(f.locks, ownName), "utf8")).ticket,
			).toBe(1);
			await peer.call("peer", { name: "zzz-peer.json", ticket: 1 });
			expect(ownName < "zzz-peer.json").toBe(true);
			expect(lock.ready()).toBe(true);
			await peer.call("peer", { name: "000-peer.json", ticket: 1 });
			expect("000-peer.json" < ownName).toBe(true);
			expect(lock.ready()).toBe(false);
			rmSync(join(f.locks, "000-peer.json"));
			expect(lock.ready()).toBe(true);
		} finally {
			lock.release();
		}
		expect(readdirSync(f.locks)).toEqual(["zzz-peer.json"]);
	}, 20_000);

	test("preserves a live owner and recovers its claim only after confirmed death", async () => {
		const f = fixture();
		const owner = f.child();
		const name = (await owner.call("begin")) as string;
		const original = readFileSync(join(f.locks, name), "utf8");
		const waiter = beginFileLock(f.locks);
		try {
			expect(await owner.call("ready")).toBe(true);
			expect(waiter.ready()).toBe(false);
			expect(readFileSync(join(f.locks, name), "utf8")).toBe(original);
			const exited = new Promise<void>((resolve) =>
				owner.process.once("exit", () => resolve()),
			);
			owner.process.kill("SIGKILL");
			await exited;
			expect(waiter.ready()).toBe(true);
			expect(readdirSync(f.locks)).toHaveLength(1);
			expect(readdirSync(f.locks)).not.toContain(name);
		} finally {
			waiter.release();
		}
		expect(readdirSync(f.locks)).toEqual([]);
	}, 20_000);

	test("an old releaser cannot remove a successor process claim", async () => {
		const f = fixture();
		const old = f.child();
		await old.call("begin");
		await old.call("release");
		expect(await old.call("ready")).toBe(false);
		expect(readdirSync(f.locks)).toEqual([]);
		const successor = f.child();
		const name = (await successor.call("begin")) as string;
		const claim = readFileSync(join(f.locks, name), "utf8");
		await old.call("release");
		await old.call("release");
		expect(readFileSync(join(f.locks, name), "utf8")).toBe(claim);
		expect(await successor.call("ready")).toBe(true);
		const waiter = beginFileLock(f.locks);
		try {
			expect(waiter.ready()).toBe(false);
		} finally {
			waiter.release();
		}
		await successor.call("release");
		expect(readdirSync(f.locks)).toEqual([]);
	}, 20_000);

	const invalidClaims = [
		["malformed JSON", "{"],
		["null", "null"],
		["missing pid", JSON.stringify({ ticket: 1 })],
		["zero pid", JSON.stringify({ pid: 0, ticket: 1 })],
		["negative pid", JSON.stringify({ pid: -1, ticket: 1 })],
		["fractional pid", JSON.stringify({ pid: 1.5, ticket: 1 })],
		["string pid", JSON.stringify({ pid: String(process.pid), ticket: 1 })],
		[
			"unsafe pid",
			JSON.stringify({ pid: Number.MAX_SAFE_INTEGER + 1, ticket: 1 }),
		],
		["missing ticket", JSON.stringify({ pid: process.pid })],
		["negative ticket", JSON.stringify({ pid: process.pid, ticket: -1 })],
		["fractional ticket", JSON.stringify({ pid: process.pid, ticket: 1.5 })],
		["string ticket", JSON.stringify({ pid: process.pid, ticket: "1" })],
		[
			"unsafe ticket",
			JSON.stringify({ pid: process.pid, ticket: Number.MAX_SAFE_INTEGER + 1 }),
		],
	];
	for (const [label, content] of invalidClaims) {
		test(`${label} fails without leaking the caller claim or deleting peers`, () => {
			const f = fixture();
			const peer = beginFileLock(f.locks);
			const peerName = readdirSync(f.locks)[0]!;
			const peerContent = readFileSync(join(f.locks, peerName), "utf8");
			writeFileSync(join(f.locks, "bad.json"), content!);
			writeFileSync(join(f.locks, "unpublished.json.tmp"), "incomplete");
			try {
				expect(() => beginFileLock(f.locks)).toThrow();
				let called = false;
				expect(() =>
					withFileLockSync(f.locks, () => {
						called = true;
					}),
				).toThrow();
				expect(called).toBe(false);
				expect(readdirSync(f.locks).sort()).toEqual(
					[peerName, "bad.json", "unpublished.json.tmp"].sort(),
				);
				expect(readFileSync(join(f.locks, peerName), "utf8")).toBe(peerContent);
				expect(readFileSync(join(f.locks, "bad.json"), "utf8")).toBe(content!);
				expect(
					readFileSync(join(f.locks, "unpublished.json.tmp"), "utf8"),
				).toBe("incomplete");
			} finally {
				peer.release();
			}
		});
	}

	test("a synchronous callback throw releases before the next acquisition", () => {
		const f = fixture();
		const failure = new Error("synthetic callback failure");
		expect(() =>
			withFileLockSync(f.locks, () => {
				expect(readdirSync(f.locks)).toHaveLength(1);
				throw failure;
			}),
		).toThrow(failure);
		expect(readdirSync(f.locks)).toEqual([]);
		expect(withFileLockSync(f.locks, () => 42)).toBe(42);
		expect(readdirSync(f.locks)).toEqual([]);
	});
});
