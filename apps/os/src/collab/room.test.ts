// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import {
	CollabRoom,
	COLLAB_ACCESS_CHECK_MS,
	type CollabRoomState,
	type CollabSocket,
} from "./room";
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
import type {
	RepositoryCandidateDescriptor,
	RepositoryCandidateState,
} from "@tedix/api-contract/schemas/repository-candidate";
import {
	repositoryCandidateDocKey,
	repositoryCandidateRoomName,
} from "@tedix/api-contract/utils/repository-candidate";
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
				const hold = holds.get(prefix);
				if (hold !== undefined) {
					holds.delete(prefix);
					hold.entered();
					await hold.gate;
				}
				const matched = new Map<string, T>();
				for (const [key, value] of [...values].sort(([a], [b]) =>
					a < b ? -1 : a > b ? 1 : 0,
				)) {
					if (key.startsWith(prefix)) matched.set(key, value as T);
				}
				return matched;
			},
			put: async (key, value) => {
				if (JSON.stringify(value).length * 2 > 2 * 1024 * 1024) {
					throw new Error("SQLite value exceeds 2 MiB");
				}
				values.set(key, value);
			},
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

describe("live workspace access", () => {
	it("arms a durable check on open and keeps a reconnected use presence session until removal", async () => {
		const socket = new FakeSocket();
		const roomState = state([]);
		roomState.storage.getAlarm = async () => null;
		roomState.storage.setAlarm = vi.fn(async () => {});
		let role: string | null = "use";
		const env = {
			API_SERVICE: {
				fetch: async () => Response.json({ roles: { guest: role } }),
			},
		};
		const headers = new Headers(upgrade(identity).headers);
		headers.set(
			"X-Tedix-Collab-Access",
			JSON.stringify({
				workspaceId: "workspace-1",
				userId: "guest",
				role: "use",
			}),
		);
		const restore = withWebSocketPair(() => [new FakeSocket(), socket]);
		try {
			await new CollabRoom(roomState, env)
				.fetch(new Request("https://collab.internal/", { headers }))
				.catch(() => {});
		} finally {
			restore();
		}
		expect(socket.of("hello")).toHaveLength(1);
		expect(roomState.storage.setAlarm).toHaveBeenCalledOnce();
		const close = vi.spyOn(socket, "close");
		await new CollabRoom(roomState, env).alarm();
		expect(close).not.toHaveBeenCalled();
		role = null;
		await new CollabRoom(roomState, env).alarm();
		expect(close).toHaveBeenCalledWith(
			4003,
			"Workspace access changed; reconnect.",
		);
	});
	it.each([null, "use", "unavailable"])(
		"cuts %s peers after hibernation and keeps the owner connected",
		async (role) => {
			const removed = new FakeSocket();
			const owner = new FakeSocket();
			removed.serializeAttachment({
				peerId: 1,
				identity,
				access: { workspaceId: "workspace-1", userId: "guest" },
			});
			owner.serializeAttachment({
				peerId: 2,
				identity: other,
				access: { workspaceId: "workspace-1", userId: "owner" },
			});
			const cut = vi.spyOn(removed, "close");
			const ownerCut = vi.spyOn(owner, "close");
			const roomState = state([removed, owner]);
			roomState.storage.getAlarm = async () => null;
			roomState.storage.setAlarm = vi.fn(async () => {});
			const requests: Request[] = [];
			const env = {
				API_SERVICE: {
					fetch: async (request: Request) => {
						requests.push(request);
						return role === "unavailable"
							? new Response(null, { status: 503 })
							: Response.json({ roles: { guest: role, owner: "build" } });
					},
				},
			};
			// Constructing a fresh room uses only the durable socket attachments.
			await new CollabRoom(roomState, env).alarm();
			expect(cut).toHaveBeenCalledWith(
				4003,
				"Workspace access changed; reconnect.",
			);
			expect(ownerCut).toHaveBeenCalledTimes(role === "unavailable" ? 1 : 0);
			expect(requests).toHaveLength(1);
			expect(await requests[0]!.json()).toEqual({
				workspaceId: "workspace-1",
				userIds: ["guest", "owner"],
			});
			for (const header of ["Cookie", "Authorization", "X-API-Key"])
				expect(requests[0]!.headers.has(header)).toBe(false);
			await new CollabRoom(roomState, env).webSocketMessage(
				removed,
				encodeFrame({ t: "presence", state: { user: { name: "Forged" } } }),
			);
			expect(removed.frames).toEqual([]);
			if (role !== "unavailable") {
				expect(owner.frames.at(-1)).toMatchObject({ t: "presence", peers: [] });
				expect(roomState.storage.setAlarm).toHaveBeenCalledOnce();
				const next = vi.mocked(roomState.storage.setAlarm).mock.calls[0]![0];
				expect(next).toBeLessThanOrEqual(Date.now() + COLLAB_ACCESS_CHECK_MS);
			} else expect(roomState.storage.setAlarm).not.toHaveBeenCalled();
		},
	);
});

describe("proposal room revalidation", () => {
	it("orders an internal agent edit with human socket edits, deduplicates retry and refuses a stale proposal", async () => {
		const sockets: FakeSocket[] = [];
		const room = new CollabRoom(state(sockets));
		const human = await connect(room, sockets);
		const canonical = {
			revision: 3,
			revisionId: "base",
			files: [
				["client.js", "client"],
				["server.js", "server"],
			],
		};
		await room.webSocketMessage(
			human,
			encodeFrame({
				t: "base",
				id: 1,
				seed: canonical as {
					revision: number;
					revisionId: string;
					files: [string, string][];
				},
			}),
		);
		await room.webSocketMessage(
			human,
			encodeFrame({
				t: "submit",
				id: 2,
				submission: submission({
					change: [["client.js", { edit: [6, [0, " human"]] }]],
				}),
			}),
		);
		const agent = {
			...other,
			key: "opaque-agent",
			kind: "external_agent",
			role: "build",
		};
		const change = {
			generation: 0,
			revision: 0,
			clientId: "agent-client",
			seq: 1,
			change: [["server.js", { edit: [6, [0, " agent"]] }]],
		};
		const send = (revision: number, submission?: unknown) =>
			room.fetch(
				new Request("https://room.internal/__internal/app-draft", {
					method: "POST",
					body: JSON.stringify({
						actor: agent,
						canonical: { ...canonical, revision },
						...(submission ? { submission } : {}),
					}),
				}),
			);
		const result = (await (await send(3, change)).json()) as {
			result: unknown;
			snapshot: { files: Record<string, string> };
		};
		expect(result.result).toMatchObject({
			ok: true,
			duplicate: false,
			revision: 2,
		});
		expect(result.snapshot.files).toEqual({
			"client.js": "client human",
			"server.js": "server agent",
		});
		expect(human.of("row").at(-1)?.row.author).toMatchObject({
			key: "opaque-agent",
			kind: "external_agent",
		});
		expect(await (await send(3, change)).json()).toMatchObject({
			result: { ok: true, duplicate: true, revision: 2 },
		});
		expect((await send(2)).status).toBe(409);
		expect((await send(4)).status).toBe(409);
	});
	it("converges concurrent edits to separate code files and retains them through hibernation", async () => {
		const sockets: FakeSocket[] = [];
		const stored = state(sockets);
		let room = new CollabRoom(stored);
		const ada = await connect(room, sockets);
		const grace = await connect(room, sockets, other);
		await room.webSocketMessage(
			ada,
			encodeFrame({
				t: "base",
				id: 1,
				seed: {
					revision: 3,
					revisionId: "base",
					files: [
						["client.js", "client"],
						["server.js", "server"],
					],
				},
			}),
		);
		await room.webSocketMessage(grace, encodeFrame({ t: "base", id: 2 }));
		await room.webSocketMessage(
			ada,
			encodeFrame({
				t: "submit",
				id: 3,
				submission: submission({
					change: [["client.js", { edit: [6, [0, " human"]] }]],
				}),
			}),
		);
		await room.webSocketMessage(
			grace,
			encodeFrame({
				t: "submit",
				id: 4,
				submission: submission({
					clientId: "agent-client",
					change: [["server.js", { edit: [6, [0, " agent"]] }]],
				}),
			}),
		);
		expect(ada.of("result").at(-1)?.result.ok).toBe(true);
		expect(grace.of("result").at(-1)?.result.ok).toBe(true);
		room = new CollabRoom(stored);
		await room.webSocketMessage(ada, encodeFrame({ t: "base", id: 5 }));
		await room.webSocketMessage(grace, encodeFrame({ t: "base", id: 6 }));
		const expected = [
			["client.js", "client human"],
			["server.js", "server agent"],
		];
		expect(ada.of("base").at(-1)?.files).toEqual(expected);
		expect(grace.of("base").at(-1)?.files).toEqual(expected);
		await room.webSocketMessage(
			grace,
			encodeFrame({
				t: "canonical",
				id: 7,
				offer: {
					revision: 4,
					revisionId: "base",
					files: [
						["client.js", "outside change"],
						["server.js", "server"],
					],
				},
			}),
		);
		expect(grace.of("canonicalResult").at(-1)?.outcome).toBe("edited");
	});
	it("retains the exact proposal and base across hibernation and cuts a closed scope", async () => {
		const socket = new FakeSocket();
		const appDraft = {
			gadgetId: "app",
			proposalId: "proposal",
			baseRevisionId: "base",
		};
		socket.serializeAttachment({
			peerId: 1,
			identity,
			access: {
				workspaceId: "workspace-1",
				userId: "builder",
				role: "build",
				appDraft,
			},
		});
		const roomState = state([socket]);
		roomState.storage.setAlarm = vi.fn(async () => {});
		const requests: Request[] = [];
		const env = {
			API_SERVICE: {
				fetch: async (request: Request) => {
					requests.push(request);
					return Response.json({ roles: {} });
				},
			},
		};
		const close = vi.spyOn(socket, "close");
		await new CollabRoom(roomState, env).alarm();
		expect(await requests[0]!.json()).toEqual({
			workspaceId: "workspace-1",
			userIds: ["builder"],
			appDraft,
		});
		expect(close).toHaveBeenCalledWith(
			4003,
			"Workspace access changed; reconnect.",
		);
	});
});

describe("large workbook rooms", () => {
	it("edits a 12-tab workbook, wakes with its edits, and grounds a save", async () => {
		const { largeSheetText } = await import("./large-sheet.fixture");
		const text = largeSheetText();
		expect(text.length).toBeGreaterThan(1_824_753);
		expect(text.length).toBeLessThan(2_000_000);
		const workbook = JSON.parse(text).workbook;
		expect(workbook.sheets).toHaveLength(12);
		expect(workbook.sheets[0].rows).toHaveLength(208);
		expect(workbook.sheets[0].columns).toHaveLength(31);
		const sockets: FakeSocket[] = [];
		const stored = state(sockets);
		let room = new CollabRoom(stored);
		const ada = await connect(room, sockets);
		await room.webSocketMessage(
			ada,
			encodeFrame({ t: "base", id: 1, seed: offer(23, text) }),
		);
		expect(ada.of("base").at(-1)?.files).toEqual([[COLLAB_DOC_PATH, text]]);
		const grace = await connect(room, sockets, other);
		await room.webSocketMessage(grace, encodeFrame({ t: "base", id: 2 }));
		expect(grace.of("base").at(-1)?.files).toEqual([[COLLAB_DOC_PATH, text]]);
		// A full replacement exercises chunked rows as well as materialized bases.
		const changed = text.replace(
			"Sample research note 0/0/0",
			"Shared research note 0/0/0",
		);
		await room.webSocketMessage(
			ada,
			encodeFrame({
				t: "submit",
				id: 3,
				submission: submission({
					change: [[COLLAB_DOC_PATH, { set: changed }]],
				}),
			}),
		);
		expect(ada.of("result").at(-1)?.result.ok).toBe(true);
		expect(grace.of("row").at(-1)?.row.change).toEqual([
			[COLLAB_DOC_PATH, { set: changed }],
		]);
		expect(
			[...stored.values.keys()].some((key) => key.startsWith("ot:base:chunk:")),
		).toBe(true);
		expect(
			[...stored.values.keys()].some((key) =>
				key.startsWith("ot:row:000000000001:chunk:"),
			),
		).toBe(true);
		room = new CollabRoom(stored);
		await room.webSocketMessage(grace, encodeFrame({ t: "base", id: 4 }));
		const base = grace.of("base").at(-1)!;
		expect(base.files).toEqual([[COLLAB_DOC_PATH, changed]]);
		expect(base.revision).toBe(1);
		const updated = changed + " ";
		await room.webSocketMessage(
			grace,
			encodeFrame({
				t: "submit",
				id: 5,
				submission: submission({
					revision: 1,
					clientId: "client-b",
					change: [[COLLAB_DOC_PATH, { edit: [changed.length, [0, " "]] }]],
				}),
			}),
		);
		expect(grace.of("result").at(-1)?.result.ok).toBe(true);
		await room.webSocketMessage(
			grace,
			encodeFrame({
				t: "ground",
				id: 6,
				offer: offer(24, updated),
				at: { generation: 0, revision: 2 },
			}),
		);
		expect(grace.of("canonicalResult").at(-1)?.outcome).toBe("repaired");
		room = new CollabRoom(stored);
		await room.webSocketMessage(ada, encodeFrame({ t: "base", id: 7 }));
		expect(ada.of("base").at(-1)).toMatchObject({
			files: [[COLLAB_DOC_PATH, updated]],
			canonical: { revision: 24, revisionId: "rev-24" },
		});
	});

	it.each(["x", "界"])(
		"rejects oversized UTF-8 frames (%s) with an error and 1009 close",
		async (char) => {
			const { MAX_MESSAGE_BYTES } = await import("./protocol");
			const sockets: FakeSocket[] = [];
			const room = new CollabRoom(state(sockets));
			const ws = await connect(room, sockets);
			const close = vi.spyOn(ws, "close");
			const width = new TextEncoder().encode(char).byteLength;
			await room.webSocketMessage(
				ws,
				char.repeat(Math.floor(MAX_MESSAGE_BYTES / width) + 1),
			);
			expect(ws.of("error").at(-1)).toMatchObject({
				id: null,
				message: expect.stringContaining("exceeds"),
			});
			expect(close).toHaveBeenCalledWith(
				1009,
				expect.stringContaining("too large"),
			);
			expect(ws.of("base")).toHaveLength(0);
		},
	);
});

describe("Work repository candidates", () => {
	function descriptor(): RepositoryCandidateDescriptor {
		const scope = {
			organizationId: "org-example",
			workItemId: "11111111-1111-4111-8111-111111111111",
			attemptId: "22222222-2222-4222-8222-222222222222",
			admissionId: "33333333-3333-4333-8333-333333333333",
			baseRevision: "a".repeat(40),
			selectionDigest: "b".repeat(64),
		};
		return {
			version: 1,
			...scope,
			repositoryId: "example-repo",
			repositoryName: "work-example",
			files: [
				{ path: "client.js", blobRevision: "c".repeat(40), bytes: 6 },
				{ path: "server.js", blobRevision: "d".repeat(40), bytes: 6 },
			],
			roomName: repositoryCandidateRoomName(scope),
			docKey: repositoryCandidateDocKey(scope),
			createdAt: "2026-11-03T00:00:00.000Z",
		};
	}
	const actor = {
		key: "verified-native-agent",
		kind: "external_agent",
		displayName: "Agent",
		role: "build",
		verified: true,
	};
	function call(
		room: CollabRoom,
		operation: string,
		scope: RepositoryCandidateDescriptor,
		extra: Record<string, unknown> = {},
	) {
		return room.fetch(
			new Request("https://room/__internal/repository-candidate", {
				method: "POST",
				body: JSON.stringify({ operation, descriptor: scope, actor, ...extra }),
			}),
		);
	}
	function setup() {
		const sockets: FakeSocket[] = [];
		const roomState = state(sockets);
		roomState.storage.getAlarm = async () => null;
		roomState.storage.setAlarm = vi.fn(async () => {});
		const check = vi.fn(async () =>
			Response.json({
				allowed: true,
				expiresAt: new Date(Date.now() + 60000).toISOString(),
				roles: { owner: "build" },
			}),
		);
		const env = { API_SERVICE: { fetch: check } };
		return {
			sockets,
			roomState,
			env,
			check,
			room: new CollabRoom(roomState, env),
		};
	}
	async function initialize(
		room: CollabRoom,
		scope: RepositoryCandidateDescriptor,
	) {
		const response = await call(room, "initialize", scope, {
			files: { "client.js": "client", "server.js": "server" },
		});
		expect(response.status).toBe(200);
		return (await response.json()) as RepositoryCandidateState;
	}
	function peer(scope: RepositoryCandidateDescriptor) {
		const socket = new FakeSocket();
		socket.close = vi.fn();
		socket.serializeAttachment({
			peerId: 7,
			identity,
			repositoryAccess: { descriptor: scope, userId: "owner" },
		});
		return socket;
	}
	it("shares two files across human and native agent edits, deduplicates, survives hibernation and seals exact content", async () => {
		const h = setup(),
			scope = descriptor();
		await initialize(h.room, scope);
		const human = peer(scope);
		h.sockets.push(human);
		await h.room.webSocketMessage(
			human,
			encodeFrame({
				t: "base",
				id: 1,
				seed: {
					revision: 999,
					revisionId: "forged",
					files: [["outside", "malicious"]],
				},
			}),
		);
		expect(human.of("base").at(-1)?.files).toEqual([
			["client.js", "client"],
			["server.js", "server"],
		]);
		await h.room.webSocketMessage(
			human,
			encodeFrame({
				t: "submit",
				id: 2,
				submission: submission({
					change: [["client.js", { edit: [6, [0, " human"]] }]],
				}),
			}),
		);
		const agentEdit = submission({
			clientId: "native-client",
			change: [["server.js", { edit: [6, [0, " agent"]] }]],
		});
		expect(
			(await call(h.room, "submit", scope, { submission: agentEdit })).status,
		).toBe(200);
		const duplicate = await call(h.room, "submit", scope, {
			submission: agentEdit,
		});
		const saved = (await duplicate.json()) as RepositoryCandidateState;
		expect(saved.snapshot.position.revision).toBe(2);
		expect(saved.snapshot.files).toEqual({
			"client.js": "client human",
			"server.js": "server agent",
		});
		expect(await initialize(h.room, scope)).toEqual(saved);
		const woken = new CollabRoom(h.roomState, h.env);
		expect(await (await call(woken, "read", scope)).json()).toEqual(saved);
		expect(
			(
				await call(woken, "seal", scope, {
					expectedPosition: { generation: 0, revision: 1 },
					expectedContentDigest: saved.contentDigest,
				})
			).status,
		).toBe(409);
		const sealInput = {
			expectedPosition: saved.snapshot.position,
			expectedContentDigest: saved.contentDigest,
		};
		const sealed = (await (
			await call(woken, "seal", scope, sealInput)
		).json()) as RepositoryCandidateState;
		expect(sealed.sealed).toBe(true);
		expect(sealed.seal).toEqual({
			position: saved.snapshot.position,
			contentDigest: saved.contentDigest,
		});
		expect((await call(woken, "seal", scope, sealInput)).status).toBe(200);
		expect(
			(
				await call(woken, "submit", scope, {
					submission: submission({
						seq: 2,
						revision: 2,
						clientId: "native-client",
						change: [["server.js", { edit: [12, [0, "!"]] }]],
					}),
				})
			).status,
		).toBe(409);
		expect(human.close).toHaveBeenCalledWith(
			4003,
			expect.stringContaining("Repository authority"),
		);
	});
	it.each([
		[["outside", { set: "x" }]],
		[["client.js", { remove: true }]],
		[["client.js", { set: "replacement" }]],
	])(
		"refuses non-edit operations and never advances the candidate",
		async (change) => {
			const h = setup(),
				scope = descriptor();
			await initialize(h.room, scope);
			const response = await call(h.room, "submit", scope, {
				submission: submission({
					change: [change] as CodeChangeSubmission["change"],
				}),
			});
			expect(response.status).toBe(409);
			const saved = (await (
				await call(h.room, "read", scope)
			).json()) as RepositoryCandidateState;
			expect(saved.snapshot.position.revision).toBe(0);
		},
	);
	it("enforces the UTF8 file cap after transformation without advancing the stream", async () => {
		const h = setup(),
			scope = descriptor();
		await initialize(h.room, scope);
		const response = await call(h.room, "submit", scope, {
			submission: submission({
				change: [["client.js", { edit: [6, [0, "x".repeat(65536)]] }]],
			}),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			message: "A selected file exceeds the shared editing limit",
		});
		const saved = (await (
			await call(h.room, "read", scope)
		).json()) as RepositoryCandidateState;
		expect(saved.snapshot.position.revision).toBe(0);
		expect(saved.snapshot.files["client.js"]).toBe("client");
	});

	it("closes revoked peers after hibernation before accepting another mutation", async () => {
		const h = setup(),
			scope = descriptor();
		await initialize(h.room, scope);
		const socket = peer(scope);
		h.sockets.push(socket);
		h.check.mockImplementation(async () =>
			Response.json({ allowed: false, roles: {}, expiresAt: null }),
		);
		const woken = new CollabRoom(h.roomState, h.env);
		await woken.webSocketMessage(
			socket,
			encodeFrame({
				t: "submit",
				id: 1,
				submission: submission({
					change: [["client.js", { edit: [6, [0, " denied"]] }]],
				}),
			}),
		);
		expect(socket.close).toHaveBeenCalledWith(
			4003,
			expect.stringContaining("Repository authority"),
		);
		expect((await call(woken, "read", scope)).status).toBe(409);
		h.check.mockImplementation(async () =>
			Response.json({
				allowed: true,
				expiresAt: new Date(Date.now() + 60000).toISOString(),
				roles: { owner: "build" },
			}),
		);
		const saved = (await (
			await call(woken, "read", scope)
		).json()) as RepositoryCandidateState;
		expect(saved.snapshot.position.revision).toBe(0);
	});
	it("cannot replace the frozen descriptor or re-ground from the browser", async () => {
		const h = setup(),
			scope = descriptor();
		await initialize(h.room, scope);
		expect(
			(
				await call(
					h.room,
					"initialize",
					{ ...scope, repositoryId: "replacement" },
					{ files: { "client.js": "client", "server.js": "server" } },
				)
			).status,
		).toBe(409);
		const socket = peer(scope);
		h.sockets.push(socket);
		await h.room.webSocketMessage(
			socket,
			encodeFrame({
				t: "canonical",
				id: 8,
				force: true,
				offer: {
					revision: 1,
					revisionId: "forged",
					files: [["client.js", "overwrite"]],
				},
			}),
		);
		expect(socket.of("error").at(-1)?.message).toContain("immutable base");
		expect(
			(
				(await (
					await call(h.room, "read", scope)
				).json()) as RepositoryCandidateState
			).snapshot.position.revision,
		).toBe(0);
	});
});
