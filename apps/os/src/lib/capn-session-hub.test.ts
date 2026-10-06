import { describe, expect, it } from "vite-plus/test";
import type { CapnSessionStub } from "@/capnweb/contract";
import { createCapnSessionHub } from "./capn-session-hub";

type FakeRoot = CapnSessionStub & {
	disposed: boolean;
	break(): void;
};

function fakeConnect(mode: "object" | "function" = "object") {
	const roots: FakeRoot[] = [];
	let attempts = 0;
	let failNext = false;
	let ping: () => Promise<void> = async () => {};
	const connect = async (): Promise<CapnSessionStub> => {
		attempts += 1;
		if (failNext) {
			failNext = false;
			throw new Error("dial refused");
		}
		let onBroken: (() => void) | null = null;
		const shared = {
			disposed: false,
			ping: () => ping(),
			// Throws synchronously, so its `never` return satisfies the pipelined
			// capability type without a cast. These tests only exercise the socket
			// lease, never a conversation.
			openConversation: () => {
				throw new Error("unused in these tests");
			},
			onRpcBroken(callback: (error: unknown) => void) {
				onBroken = () => callback(new Error("socket died"));
			},
			[Symbol.dispose]() {
				this.disposed = true;
			},
			break() {
				onBroken?.();
			},
		};
		const root: FakeRoot =
			mode === "function"
				? Object.assign(
						(() => {
							throw new Error("unused in these tests");
						}) as object,
						shared,
					)
				: shared;
		roots.push(root);
		return root;
	};
	return {
		connect,
		roots,
		attempts: () => attempts,
		failOnce() {
			failNext = true;
		},
		setPing(next: () => Promise<void>) {
			ping = next;
		},
	};
}

describe("createCapnSessionHub", () => {
	it("dials ONCE for concurrent leases and disposes on the last release", async () => {
		const dialer = fakeConnect();
		const hub = createCapnSessionHub({ connect: dialer.connect });

		const a = hub.lease();
		const b = hub.lease();
		const [first, second] = await Promise.all([a.session(), b.session()]);

		// One socket for the whole tab: the server's limits are per session root,
		// so a second socket buys nothing and doubles the upstream pumps.
		expect(dialer.attempts()).toBe(1);
		expect(first.root).toBe(second.root);
		expect(hub.leaseCount()).toBe(2);
		expect(hub.isConnected()).toBe(true);

		a.release();
		expect(hub.isConnected()).toBe(true);
		expect(dialer.roots[0]?.disposed).toBe(false);

		b.release();
		// No subscribers means no socket — enforced, not aspirational.
		expect(hub.leaseCount()).toBe(0);
		expect(hub.isConnected()).toBe(false);
		expect(dialer.roots[0]?.disposed).toBe(true);
	});

	it("bumps the generation on socket death and notifies that generation's listeners", async () => {
		const dialer = fakeConnect();
		const hub = createCapnSessionHub({ connect: dialer.connect });
		const lease = hub.lease();
		const session = await lease.session();
		let broken = 0;
		lease.onBroken(session.generation, () => {
			broken += 1;
		});

		dialer.roots[0]?.break();
		expect(broken).toBe(1);
		expect(hub.getGeneration()).not.toBe(session.generation);
		expect(hub.isConnected()).toBe(false);
		expect(dialer.roots[0]?.disposed).toBe(true);

		// The next session() re-dials; retry pacing belongs to the machine, so the
		// hub itself neither waits nor backs off.
		const next = await lease.session();
		expect(dialer.attempts()).toBe(2);
		expect(next.root).not.toBe(session.root);
		lease.release();
	});

	it("notifies immediately when the requested generation is ALREADY dead", async () => {
		const dialer = fakeConnect();
		const hub = createCapnSessionHub({ connect: dialer.connect });
		const lease = hub.lease();
		const session = await lease.session();
		dialer.roots[0]?.break();

		let broken = false;
		lease.onBroken(session.generation, () => {
			broken = true;
		});
		// Registration order must never decide whether the caller learns about a
		// death that already happened.
		expect(broken).toBe(false);
		await Promise.resolve();
		expect(broken).toBe(true);
		lease.release();
	});

	it("a failed dial leaves no session behind and the next attempt re-dials", async () => {
		const dialer = fakeConnect();
		const hub = createCapnSessionHub({ connect: dialer.connect });
		const lease = hub.lease();
		dialer.failOnce();
		await expect(lease.session()).rejects.toThrow("dial refused");
		expect(hub.isConnected()).toBe(false);

		const session = await lease.session();
		expect(dialer.attempts()).toBe(2);
		expect(session.root).toBe(dialer.roots[0]);
		lease.release();
	});

	it("disposes a socket that lands after the last lease released", async () => {
		const dialer = fakeConnect();
		const hub = createCapnSessionHub({ connect: dialer.connect });
		const lease = hub.lease();
		const pending = lease.session();
		lease.release();
		await expect(pending).rejects.toThrow(/released/);
		// The socket that arrived for nobody must not become the shared root.
		expect(hub.isConnected()).toBe(false);
		expect(dialer.roots[0]?.disposed).toBe(true);
	});

	it("tracks the session stub for leak accounting and releases it on teardown", async () => {
		const dialer = fakeConnect();
		const tracked: string[] = [];
		let releases = 0;
		const hub = createCapnSessionHub({
			connect: dialer.connect,
			trackStub: (label) => {
				tracked.push(label);
				return () => {
					releases += 1;
				};
			},
		});
		const lease = hub.lease();
		await lease.session();
		expect(tracked).toEqual(["session"]);
		expect(releases).toBe(0);
		lease.release();
		expect(releases).toBe(1);
	});

	it("disposes function-style stubs (RpcPromise-style) on lease teardown", async () => {
		const dialer = fakeConnect("function");
		const hub = createCapnSessionHub({ connect: dialer.connect });
		const lease = hub.lease();
		const pending = lease.session();
		await pending;
		lease.release();
		expect(dialer.roots[0]?.disposed).toBe(true);
	});

	it("suppresses recent and duplicate probes, then records a successful proof", async () => {
		let now = 1_000;
		const dialer = fakeConnect();
		let resolvePing: (() => void) | undefined;
		let pings = 0;
		dialer.setPing(
			() =>
				new Promise<void>((resolve) => {
					pings += 1;
					resolvePing = resolve;
				}),
		);
		const hub = createCapnSessionHub({
			connect: dialer.connect,
			now: () => now,
		});
		const lease = hub.lease();
		await lease.session();
		expect(await hub.probe()).toBe(true);
		expect(pings).toBe(0);

		now += 15_000;
		const first = hub.probe();
		const duplicate = hub.probe();
		expect(pings).toBe(1);
		resolvePing?.();
		expect(await Promise.all([first, duplicate])).toEqual([true, true]);
		expect(pings).toBe(1);
		lease.release();
	});

	it("kills a zombie session so existing broken listeners own reconnect", async () => {
		let now = 1_000;
		const dialer = fakeConnect();
		dialer.setPing(async () => {
			throw new Error("zombie socket");
		});
		const hub = createCapnSessionHub({
			connect: dialer.connect,
			now: () => now,
		});
		const lease = hub.lease();
		const session = await lease.session();
		let broken = 0;
		lease.onBroken(session.generation, () => {
			broken += 1;
		});
		now += 15_000;
		expect(await hub.probe()).toBe(false);
		expect(broken).toBe(1);
		expect(hub.isConnected()).toBe(false);
		lease.release();
	});
});
