// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { CollabRoom, type CollabRoomState, type CollabSocket } from "./room";
import {
	COLLAB_DOC_PATH,
	type CollabServerFrame,
	encodeFrame,
	parseServerFrame,
} from "./protocol";
import {
	COLLAB_PRESENCE_HEADER,
	type CollabVerifiedIdentity,
} from "./presence";
import type { CodeChangeSubmission } from "./ot/wire";

const identity: CollabVerifiedIdentity = {
	displayName: "Ada",
	key: "opaque-ada",
	kind: "human",
	role: "owner",
	verified: true,
};
const other: CollabVerifiedIdentity = {
	displayName: "Grace",
	key: "opaque-grace",
	kind: "human",
	role: "member",
	verified: true,
};

class FakeSocket implements CollabSocket {
	attachment: unknown = null;
	frames: CollabServerFrame[] = [];
	send(data: ArrayBuffer | Uint8Array | string) {
		if (typeof data !== "string") return;
		const frame = parseServerFrame(data);
		if (frame) this.frames.push(frame);
	}
	close() {}
	serializeAttachment(value: unknown) {
		this.attachment = value;
	}
	deserializeAttachment() {
		return this.attachment;
	}
	of<T extends CollabServerFrame["t"]>(
		type: T,
	): Extract<CollabServerFrame, { t: T }>[] {
		return this.frames.filter(
			(frame): frame is Extract<CollabServerFrame, { t: T }> =>
				frame.t === type,
		);
	}
}

type FakeRoomState = CollabRoomState & {
	values: Map<string, unknown>;
	/**
	 * Park the next `storage.get(key)`. `entered` resolves once that read is actually in flight and
	 * `release` lets it finish, so a test can land a whole write between the two — which is the only
	 * way to prove the base handshake reads ONE instant rather than three.
	 */
	holdNextGet: (key: string) => { entered: Promise<void>; release: () => void };
};

function state(sockets: FakeSocket[]): FakeRoomState {
	const values = new Map<string, unknown>();
	const holds = new Map<string, { entered: () => void; gate: Promise<void> }>();
	return {
		values,
		holdNextGet: (key: string) => {
			let release = (): void => {};
			let entered = (): void => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const reached = new Promise<void>((resolve) => {
				entered = resolve;
			});
			holds.set(key, { entered, gate });
			return { entered: reached, release };
		},
		storage: {
			get: async <T>(key: string) => {
				const hold = holds.get(key);
				if (hold !== undefined) {
					holds.delete(key);
					hold.entered();
					await hold.gate;
				}
				return values.get(key) as T | undefined;
			},
			list: async <T>({ prefix }: { prefix: string }) => {
				const matched = new Map<string, T>();
				for (const [key, value] of [...values].sort(([a], [b]) =>
					a < b ? -1 : a > b ? 1 : 0,
				)) {
					if (key.startsWith(prefix)) matched.set(key, value as T);
				}
				return matched;
			},
			put: async (key, value) => void values.set(key, value),
			delete: async (key) => void values.delete(key),
		},
		acceptWebSocket: (ws) => {
			sockets.push(ws as FakeSocket);
		},
		getWebSockets: () => sockets,
	};
}

function upgrade(presence: CollabVerifiedIdentity | null) {
	return new Request("https://collab.internal/", {
		headers: {
			Upgrade: "websocket",
			...(presence
				? { [COLLAB_PRESENCE_HEADER]: JSON.stringify(presence) }
				: {}),
		},
	});
}

/**
 * `WebSocketPair` is a Workers global. The room only needs a pair of objects it
 * can accept and attach to, so the fake supplies exactly that.
 */
function withWebSocketPair(make: () => FakeSocket[]): () => void {
	const globals = globalThis as {
		WebSocketPair?: unknown;
	};
	const previous = globals.WebSocketPair;
	globals.WebSocketPair = function WebSocketPairFake(this: unknown) {
		const [client, server] = make();
		return { 0: client, 1: server } as never;
	};
	return () => {
		globals.WebSocketPair = previous;
	};
}

async function connect(
	room: CollabRoom,
	sockets: FakeSocket[],
	presence: CollabVerifiedIdentity = identity,
): Promise<FakeSocket> {
	const server = new FakeSocket();
	Object.assign(server, { accept: () => {} });
	const restore = withWebSocketPair(() => [new FakeSocket(), server]);
	try {
		await room.fetch(upgrade(presence));
	} catch {
		// `new Response(null, {status: 101})` is a Workers-only construction and
		// throws under Node's undici. Everything the upgrade does — accepting the
		// socket, attaching the verified identity, sending `hello` and the roster —
		// has already happened by then, which is what these tests assert.
	} finally {
		restore();
	}
	return server;
}

/**
 * A canonical revision as a client offers it. Every handshake states WHICH revision its content
 * is: the room records it, and a commit's compare-and-swap is pinned to it rather than to whatever
 * the canonical store reports at the instant the user presses Commit.
 */
function offer(revision: number, text: string) {
	return {
		revision,
		revisionId: `rev-${revision}`,
		files: [[COLLAB_DOC_PATH, text]] as [string, string][],
	};
}

function submission(
	overrides: Partial<CodeChangeSubmission> = {},
): CodeChangeSubmission {
	return {
		generation: 0,
		revision: 0,
		clientId: "client-a",
		seq: 1,
		change: [[COLLAB_DOC_PATH, { edit: [5, [0, " world"]] }]],
		...overrides,
	};
}

describe("CollabRoom upgrade", () => {
	it("refuses an upgrade without the Worker's verified presence envelope", async () => {
		const room = new CollabRoom(state([]));
		expect((await room.fetch(upgrade(null))).status).toBe(403);
	});

	it("refuses a request that is not a WebSocket upgrade", async () => {
		const room = new CollabRoom(state([]));
		const response = await room.fetch(new Request("https://collab.internal/"));
		expect(response.status).toBe(426);
	});

	it("greets a socket with its own peer id and the current roster", async () => {
		const sockets: FakeSocket[] = [];
		const roomState = state(sockets);
		const room = new CollabRoom(roomState);

		const first = await connect(room, sockets);
		await room.webSocketMessage(
			first,
			encodeFrame({
				t: "presence",
				state: { location: { surface: "canvas" } },
			}),
		);
		const second = await connect(room, sockets, other);

		const hello = second.of("hello")[0];
		expect(hello?.peerId).toBeGreaterThan(0);
		expect(hello?.peerId).not.toBe(first.of("hello")[0]?.peerId);
		// The roster the newcomer receives already carries the peer who was here.
		expect(second.of("presence").at(-1)?.peers).toHaveLength(1);
	});
});

describe("CollabRoom change stream", () => {
	it("seeds once from the client handshake and ignores every later offer", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const first = await connect(room, sockets);
		const second = await connect(room, sockets, other);

		await Promise.all([
			room.webSocketMessage(
				first,
				encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
			),
			room.webSocketMessage(
				second,
				encodeFrame({
					t: "base",
					id: 1,
					seed: offer(3, "a completely different body"),
				}),
			),
		]);

		const firstBase = first.of("base")[0];
		const secondBase = second.of("base")[0];
		// One base, seen identically by both: concurrent seed offers converge on
		// a single base rather than diverging, so no server-side canonical seed
		// endpoint is needed.
		expect(firstBase?.files).toEqual(secondBase?.files);
		expect(firstBase?.revision).toBe(0);
		// And both learn the same grounding stamp, so neither pins a commit to a
		// revision this room's content is not.
		expect(firstBase?.canonical).toEqual({ revision: 3, revisionId: "rev-3" });
		expect(secondBase?.canonical).toEqual(firstBase?.canonical);
	});

	it("answers the base handshake from ONE snapshot, never from separate reads", async () => {
		const sockets: FakeSocket[] = [];
		const roomState = state(sockets);
		const room = new CollabRoom(roomState);
		const first = await connect(room, sockets);
		await room.webSocketMessage(
			first,
			encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
		);
		const second = await connect(room, sockets, other);

		// Park the newcomer's base read, then land an adoption COMPLETELY inside that window: a
		// server-authored row is appended, the head moves, and the grounding stamp moves with it.
		const hold = roomState.holdNextGet("ot:base");
		const handshake = room.webSocketMessage(
			second,
			encodeFrame({ t: "base", id: 2 }),
		);
		await hold.entered;
		await room.webSocketMessage(
			first,
			encodeFrame({ t: "canonical", id: 3, offer: offer(4, "hello world") }),
		);
		hold.release();
		await handshake;

		const base = second.of("base").at(-1);
		// WHICHEVER SIDE OF THE ADOPTION IT FELL ON, IT IS ONE SIDE OF IT. Assembled from separate
		// `head()` / `content()` / `canonical()` reads the three can describe three instants, and a
		// client handed post-adoption content under a pre-adoption position applies the adoption row
		// a SECOND time and throws out of its own fold. `snapshot()` is what makes that impossible,
		// and nothing but this test stops the room going back to the three-read assembly.
		const stamped =
			base?.canonical.revision === 4
				? { revision: 1, text: "hello world" }
				: { revision: 0, text: "hello" };
		expect(base?.revision).toBe(stamped.revision);
		expect(base?.files).toEqual([[COLLAB_DOC_PATH, stamped.text]]);
	});

	it("accepts a submission, broadcasts the row to everyone, and answers the sender", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const first = await connect(room, sockets);
		const second = await connect(room, sockets, other);
		await room.webSocketMessage(
			first,
			encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
		);

		await room.webSocketMessage(
			first,
			encodeFrame({ t: "submit", id: 2, submission: submission() }),
		);

		const result = first.of("result")[0]?.result;
		expect(result).toEqual({
			ok: true,
			duplicate: false,
			generation: 0,
			revision: 1,
		});
		// EVERY socket, the submitter's included: the client retires its pending
		// edit on its own echo.
		expect(first.of("row")).toHaveLength(1);
		expect(second.of("row")).toHaveLength(1);
		expect(second.of("row")[0]?.row.author).toEqual(identity);

		await room.webSocketMessage(second, encodeFrame({ t: "base", id: 9 }));
		expect(second.of("base").at(-1)?.files).toEqual([
			[COLLAB_DOC_PATH, "hello world"],
		]);
	});

	it("attributes a row to the socket's verified identity, never to the client's claim", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const socket = await connect(room, sockets, other);
		await room.webSocketMessage(
			socket,
			encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
		);
		await room.webSocketMessage(
			socket,
			encodeFrame({
				t: "submit",
				id: 2,
				submission: { ...submission(), clientId: "spoofed" },
			}),
		);
		expect(socket.of("row")[0]?.row.author).toEqual(other);
	});

	it("survives a hibernation wake: the stream rehydrates from DO storage", async () => {
		const sockets: FakeSocket[] = [];
		const roomState = state(sockets);
		const room = new CollabRoom(roomState);
		const socket = await connect(room, sockets);
		await room.webSocketMessage(
			socket,
			encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
		);
		await room.webSocketMessage(
			socket,
			encodeFrame({ t: "submit", id: 2, submission: submission() }),
		);

		// A wake is a NEW instance over the SAME storage, with no in-memory state
		// and no alarm to have fired: the authority persists each row inside the
		// span that accepts it, so nothing was waiting on a debounce.
		const woken = new CollabRoom(roomState);
		const after = await connect(woken, sockets);
		await woken.webSocketMessage(after, encodeFrame({ t: "base", id: 1 }));
		const base = after.of("base")[0];
		expect(base?.files).toEqual([[COLLAB_DOC_PATH, "hello world"]]);
		expect(base?.revision).toBe(1);
	});

	it("carries an unedited room onto a newer canonical revision and tells every socket", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const first = await connect(room, sockets);
		const second = await connect(room, sockets, other);
		await room.webSocketMessage(
			first,
			encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
		);

		await room.webSocketMessage(
			second,
			encodeFrame({ t: "canonical", id: 4, offer: offer(4, "hello world") }),
		);

		expect(second.of("canonicalResult")[0]).toMatchObject({
			id: 4,
			outcome: "adopted",
			canonical: { revision: 4, revisionId: "rev-4" },
		});
		// The adoption is ONE SERVER-AUTHORED ROW, so it reaches every socket through
		// the ordinary broadcast path and the replicas converge instead of being reset.
		expect(first.of("row")).toHaveLength(1);
		expect(first.of("row")[0]?.row.author).toEqual(other);
		expect(first.of("row")[0]?.row.submission).toBeUndefined();
		// And EVERY socket learns the moved grounding, or a peer keeps pinning its
		// commits to a canonical revision this room has left behind.
		expect(first.of("canonical").at(-1)?.canonical).toEqual({
			revision: 4,
			revisionId: "rev-4",
		});
		await room.webSocketMessage(first, encodeFrame({ t: "base", id: 9 }));
		expect(first.of("base").at(-1)?.canonical).toEqual({
			revision: 4,
			revisionId: "rev-4",
		});
	});

	it("refuses to replace an edited room, and broadcasts nothing when it does", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const socket = await connect(room, sockets);
		await room.webSocketMessage(
			socket,
			encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
		);
		await room.webSocketMessage(
			socket,
			encodeFrame({ t: "submit", id: 2, submission: submission() }),
		);

		await room.webSocketMessage(
			socket,
			encodeFrame({ t: "canonical", id: 3, offer: offer(4, "replaced") }),
		);

		// The user resolves this, not the server: a room with unsaved edits is never
		// silently replaced.
		expect(socket.of("canonicalResult").at(-1)).toMatchObject({
			outcome: "edited",
			canonical: { revision: 3, revisionId: "rev-3" },
		});
		expect(socket.of("canonical")).toHaveLength(0);
		expect(socket.of("row")).toHaveLength(1);

		// ...until the user explicitly forces it, which lands as one ordinary row.
		await room.webSocketMessage(
			socket,
			encodeFrame({
				t: "canonical",
				id: 4,
				offer: offer(4, "replaced"),
				force: true,
			}),
		);
		expect(socket.of("canonicalResult").at(-1)?.outcome).toBe("adopted");
		expect(socket.of("row")).toHaveLength(2);
		await room.webSocketMessage(socket, encodeFrame({ t: "base", id: 5 }));
		expect(socket.of("base").at(-1)?.files).toEqual([
			[COLLAB_DOC_PATH, "replaced"],
		]);
	});

	it("grounds the room on a revision its own commit produced, and verifies the claim", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const first = await connect(room, sockets);
		const second = await connect(room, sockets, other);
		await room.webSocketMessage(
			first,
			encodeFrame({ t: "base", id: 1, seed: offer(3, "hello") }),
		);
		await room.webSocketMessage(
			first,
			encodeFrame({ t: "submit", id: 2, submission: submission() }),
		);
		// "hello world" at revision 1 is what the commit wrote; then the user keeps typing.
		await room.webSocketMessage(
			first,
			encodeFrame({
				t: "submit",
				id: 3,
				submission: submission({
					revision: 1,
					seq: 2,
					change: [[COLLAB_DOC_PATH, { edit: [11, [0, "!"]] }]],
				}),
			}),
		);

		// A claim the stream does NOT corroborate: revision 4's content, but named at the position
		// that also carries the unsaved "!". Refused, or those keystrokes would count as committed.
		await room.webSocketMessage(
			first,
			encodeFrame({
				t: "ground",
				id: 4,
				offer: offer(4, "hello world"),
				at: { generation: 0, revision: 2 },
			}),
		);
		expect(first.of("canonicalResult").at(-1)).toMatchObject({
			id: 4,
			outcome: "edited",
			canonical: { revision: 3, revisionId: "rev-3" },
		});

		// The honest claim, at the position the commit was written from.
		await room.webSocketMessage(
			first,
			encodeFrame({
				t: "ground",
				id: 5,
				offer: offer(4, "hello world"),
				at: { generation: 0, revision: 1 },
			}),
		);

		expect(first.of("canonicalResult").at(-1)).toMatchObject({
			id: 5,
			outcome: "repaired",
			canonical: { revision: 4, revisionId: "rev-4" },
		});
		// Nothing was written to the document: no new row, and the "!" is still there.
		expect(first.of("row")).toHaveLength(2);
		await room.webSocketMessage(first, encodeFrame({ t: "base", id: 6 }));
		expect(first.of("base").at(-1)?.files).toEqual([
			[COLLAB_DOC_PATH, "hello world!"],
		]);
		// EVERY socket learns the moved grounding, exactly as it does for an adoption.
		expect(second.of("canonical").at(-1)?.canonical).toEqual({
			revision: 4,
			revisionId: "rev-4",
		});
	});

	it("drops malformed, binary, and oversized frames without failing the room", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const socket = await connect(room, sockets);
		await room.webSocketMessage(socket, "{not json");
		await room.webSocketMessage(socket, new ArrayBuffer(8));
		await room.webSocketMessage(socket, "x".repeat(1024 * 1024 + 1));
		expect(socket.of("base")).toHaveLength(0);
		expect(socket.of("result")).toHaveLength(0);
	});
});

describe("CollabRoom presence boundary", () => {
	it("overwrites spoofed identity and strips private fields before broadcast", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const first = await connect(room, sockets);
		const second = await connect(room, sockets, other);

		await room.webSocketMessage(
			first,
			encodeFrame({
				t: "presence",
				state: {
					user: { displayName: "Spoofed", email: "private@example.com" },
					location: { surface: "canvas", artifactKind: "output" },
					selection: { path: COLLAB_DOC_PATH, anchor: 2, head: 5 },
					token: "never broadcast",
				},
			}),
		);

		const peers = second.of("presence").at(-1)?.peers ?? [];
		expect(peers).toHaveLength(1);
		expect(peers[0]?.[1]).toEqual({
			user: identity,
			location: { surface: "canvas", artifactKind: "output" },
			selection: { path: COLLAB_DOC_PATH, anchor: 2, head: 5 },
		});
		expect(JSON.stringify(peers)).not.toContain("private@example.com");
		expect(JSON.stringify(peers)).not.toContain("token");
	});

	it("broadcasts the departure when a socket closes", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const first = await connect(room, sockets);
		const second = await connect(room, sockets, other);
		await room.webSocketMessage(
			first,
			encodeFrame({
				t: "presence",
				state: { location: { surface: "canvas" } },
			}),
		);
		expect(second.of("presence").at(-1)?.peers).toHaveLength(1);

		sockets.splice(sockets.indexOf(first), 1);
		await room.webSocketClose(first);

		expect(second.of("presence").at(-1)?.peers).toEqual([]);
	});

	it("rebuilds an emptied roster from a client's re-broadcast after a wake", async () => {
		const sockets: FakeSocket[] = [];
		const roomState = state(sockets);
		const first = await connect(new CollabRoom(roomState), sockets);
		const second = await connect(new CollabRoom(roomState), sockets, other);

		// A new instance holds no roster at all: presence is memory-only on
		// purpose, and the clients' periodic re-broadcast is what refills it.
		const woken = new CollabRoom(roomState);
		await woken.webSocketMessage(
			first,
			encodeFrame({
				t: "presence",
				state: { location: { surface: "canvas" } },
			}),
		);
		expect(second.of("presence").at(-1)?.peers).toHaveLength(1);
	});
});
