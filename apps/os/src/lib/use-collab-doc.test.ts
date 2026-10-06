import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type CollabDocCanonical,
	collabSocketUrl,
	useCollabDoc,
	type UseCollabDocInput,
	type UseCollabDocResult,
} from "./use-collab-doc";
import {
	COLLAB_DOC_PATH,
	type CollabCanonicalStamp,
	type CollabClientFrame,
	type CollabServerFrame,
	encodeFrame,
	parseClientFrame,
} from "@/collab/protocol";
import type { CollabVerifiedIdentity } from "@/collab/presence";
import { diffFiles, type CodeChange } from "@/collab/ot/code-change";

const identity: CollabVerifiedIdentity = {
	displayName: "Grace",
	key: "opaque-grace",
	kind: "human",
	role: "member",
	verified: true,
};

const sockets: FakeWebSocket[] = [];

/**
 * A WebSocket the test drives from the server side. `send` records the client's
 * frames; `deliver` pushes one server frame back.
 */
class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = 0;
	closed = false;
	sent: CollabClientFrame[] = [];
	#listeners = new Map<string, Set<(event: unknown) => void>>();

	constructor(readonly url: string) {
		sockets.push(this);
	}

	addEventListener(name: string, listener: (event: unknown) => void) {
		const set = this.#listeners.get(name) ?? new Set();
		set.add(listener);
		this.#listeners.set(name, set);
	}

	send(data: string) {
		const frame = parseClientFrame(data);
		if (!frame) throw new Error(`unparseable client frame: ${data}`);
		this.sent.push(frame);
	}

	close() {
		this.closed = true;
		this.readyState = FakeWebSocket.CLOSED;
	}

	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.#emit("open", {});
	}

	deliver(frame: CollabServerFrame) {
		this.#emit("message", { data: encodeFrame(frame) });
	}

	drop() {
		this.readyState = FakeWebSocket.CLOSED;
		this.#emit("close", {});
	}

	requestsOf<T extends CollabClientFrame["t"]>(
		type: T,
	): Extract<CollabClientFrame, { t: T }>[] {
		return this.sent.filter(
			(frame): frame is Extract<CollabClientFrame, { t: T }> =>
				frame.t === type,
		);
	}

	#emit(name: string, event: unknown) {
		for (const listener of this.#listeners.get(name) ?? []) listener(event);
	}
}

(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

function lastSocket(): FakeWebSocket {
	const socket = sockets[sockets.length - 1];
	if (!socket) throw new Error("no socket opened");
	return socket;
}

/** Minimal hook harness (this app carries no @testing-library dependency). */
function renderCollabDoc(input: UseCollabDocInput) {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	const root: Root = createRoot(container);
	const result = { current: null as UseCollabDocResult | null };
	function Harness(props: { input: UseCollabDocInput }) {
		result.current = useCollabDoc(props.input);
		return null;
	}
	const render = (nextInput: UseCollabDocInput) => {
		act(() => {
			root.render(createElement(Harness, { input: nextInput }));
		});
	};
	render(input);
	return {
		result,
		rerender: render,
		unmount: () => act(() => root.unmount()),
	};
}

/** Canonical truth as a surface loads it: the text and which revision it is. */
function canonicalDoc(text: string, revision = 1): CollabDocCanonical {
	return { text, revision, revisionId: `rev-${revision}` };
}

/** The input a surface passes once it has loaded canonical truth. */
function input(overrides: Partial<UseCollabDocInput> = {}): UseCollabDocInput {
	return {
		workspaceId: "ws-1",
		docKey: "output:7",
		enabled: true,
		canonical: canonicalDoc("hello"),
		...overrides,
	};
}

/**
 * Open the socket and complete the base handshake at `revision` with `text`,
 * answering with the grounding stamp the room reports — which canonical
 * revision that content is.
 */
async function handshake(
	socket: FakeWebSocket,
	text: string,
	revision = 0,
	canonical: CollabCanonicalStamp = { revision: 1, revisionId: "rev-1" },
): Promise<void> {
	await act(async () => {
		socket.open();
		await Promise.resolve();
	});
	const request = socket.requestsOf("base").at(-1);
	await act(async () => {
		socket.deliver({ t: "hello", peerId: 11 });
		socket.deliver({
			t: "base",
			id: request?.id ?? 1,
			generation: 0,
			revision,
			files: [[COLLAB_DOC_PATH, text]],
			canonical,
		});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** Answer the offer this client just sent with the room's decision. */
async function answerOffer(
	socket: FakeWebSocket,
	outcome: "adopted" | "repaired" | "current" | "edited",
	canonical: CollabCanonicalStamp,
): Promise<void> {
	const request = socket.requestsOf("canonical").at(-1);
	await act(async () => {
		socket.deliver({
			t: "canonicalResult",
			id: request?.id ?? 1,
			outcome,
			canonical,
		});
		await Promise.resolve();
		await Promise.resolve();
	});
}

function row(revision: number, change: CodeChange): CollabServerFrame {
	return {
		t: "row",
		row: {
			generation: 0,
			revision,
			timestampMs: 1,
			author: identity,
			change,
		},
	};
}

/**
 * One keystroke, applied exactly the way the editor applies one: the change plus
 * the text the editor's own buffer now holds.
 */
async function typeCharacter(
	rendered: { result: { current: UseCollabDocResult | null } },
	at: number,
	text: string,
	after: string,
): Promise<void> {
	await act(async () => {
		rendered.result.current?.session?.applyLocal(
			[[COLLAB_DOC_PATH, { edit: [at, [0, text]] }]],
			COLLAB_DOC_PATH,
			after,
		);
		await Promise.resolve();
		await Promise.resolve();
	});
}

afterEach(() => {
	sockets.length = 0;
});

describe("collabSocketUrl", () => {
	it("addresses the room by path and escapes the document key", () => {
		expect(
			collabSocketUrl(
				{ protocol: "https:", host: "tedix.os.tedix.dev" },
				"ws-1",
				"output:7",
			),
		).toBe("wss://tedix.os.tedix.dev/collab/ws-1/output%3A7");
		expect(
			collabSocketUrl(
				{ protocol: "http:", host: "localhost:3030" },
				"ws-1",
				"g",
			),
		).toBe("ws://localhost:3030/collab/ws-1/g");
	});
});

describe("useCollabDoc", () => {
	it("opens no socket until it is enabled and canonical truth has loaded", () => {
		const rendered = renderCollabDoc(input({ canonical: null }));
		expect(sockets).toHaveLength(0);
		// A room must never be seeded empty: without a seed there is nothing to
		// establish the base from, so the connection waits.
		rendered.rerender(input({ canonical: canonicalDoc("{}") }));
		expect(sockets).toHaveLength(1);
		rendered.unmount();
	});

	it("opens no socket while the surface is disabled, and closes one when it is", async () => {
		const rendered = renderCollabDoc(input({ enabled: false }));
		expect(sockets).toHaveLength(0);

		rendered.rerender(input({ enabled: true }));
		expect(sockets).toHaveLength(1);
		await handshake(lastSocket(), "hello");
		expect(rendered.result.current?.status).toBe("connected");

		// Disabling tears the room down: the socket closes, the session is dropped,
		// and every derived state goes back to its idle value rather than lingering
		// as a claim about a room nobody is connected to.
		rendered.rerender(input({ enabled: false }));
		expect(lastSocket().closed).toBe(true);
		expect(rendered.result.current?.session).toBeNull();
		expect(rendered.result.current?.status).toBe("disconnected");
		expect(rendered.result.current?.canonical).toBeNull();
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		expect(rendered.result.current?.commitBasis()).toBeNull();
		rendered.unmount();
	});

	it("offers the canonical seed on the base handshake and publishes the room's text", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc('{"kind":"document"}') }),
		);
		const socket = lastSocket();
		await handshake(socket, "hello");

		// The seed states which canonical revision it is, not only what it says: a
		// base whose grounding is unknown is what let a commit overwrite an unseen
		// revision.
		expect(socket.requestsOf("base")[0]?.seed).toEqual({
			revision: 1,
			revisionId: "rev-1",
			files: [[COLLAB_DOC_PATH, '{"kind":"document"}']],
		});
		expect(rendered.result.current?.canonical).toEqual({
			revision: 1,
			revisionId: "rev-1",
		});
		expect(rendered.result.current?.status).toBe("connected");
		expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
			"hello",
		);
		rendered.unmount();
		expect(socket.closed).toBe(true);
	});

	it("delivers a remote row to the editor as one ordinary change", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("hello") }),
		);
		const socket = lastSocket();
		await handshake(socket, "hello");
		const session = rendered.result.current?.session;
		const seen: CodeChange[] = [];
		session?.onRemote((change) => seen.push(change));

		await act(async () => {
			socket.deliver(row(1, [[COLLAB_DOC_PATH, { edit: [5, [0, " world"]] }]]));
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(seen).toEqual([[[COLLAB_DOC_PATH, { edit: [5, [0, " world"]] }]]]);
		expect(session?.text(COLLAB_DOC_PATH)).toBe("hello world");
		rendered.unmount();
	});

	it("submits a local edit and retires it on its own echo", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("hello") }),
		);
		const socket = lastSocket();
		await handshake(socket, "hello");
		const session = rendered.result.current?.session;
		const seen: CodeChange[] = [];
		session?.onRemote((change) => seen.push(change));

		await act(async () => {
			session?.applyLocal(
				[[COLLAB_DOC_PATH, { edit: [5, [0, "!"]] }]],
				COLLAB_DOC_PATH,
				"hello!",
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		const submitted = socket.requestsOf("submit").at(-1);
		expect(submitted?.submission.change).toEqual([
			[COLLAB_DOC_PATH, { edit: [5, [0, "!"]] }],
		]);
		expect(session?.text(COLLAB_DOC_PATH)).toBe("hello!");

		await act(async () => {
			// The authority broadcasts before it responds; the echo is the ack.
			socket.deliver({
				t: "row",
				row: {
					generation: 0,
					revision: 1,
					timestampMs: 1,
					author: identity,
					change: [[COLLAB_DOC_PATH, { edit: [5, [0, "!"]] }]],
					submission: {
						clientId: submitted?.submission.clientId ?? "",
						seq: 1,
					},
				},
			});
			socket.deliver({
				t: "result",
				id: submitted?.id ?? 1,
				result: { ok: true, duplicate: false, generation: 0, revision: 1 },
			});
			await Promise.resolve();
			await Promise.resolve();
		});

		// The editor is told nothing about its own acknowledged edit: it already
		// displays it, and a notification would reset the view for every keystroke.
		expect(seen).toEqual([]);
		expect(session?.text(COLLAB_DOC_PATH)).toBe("hello!");
		rendered.unmount();
	});

	it("collapses verified remote sessions into a roster and excludes itself", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("hello") }),
		);
		const socket = lastSocket();
		await handshake(socket, "hello");

		await act(async () => {
			socket.deliver({
				t: "presence",
				peers: [
					[11, { user: identity, location: { surface: "canvas" } }],
					[12, { user: identity }],
					[
						13,
						{ user: { ...identity, key: "opaque-ada", displayName: "Ada" } },
					],
				],
			});
			await Promise.resolve();
		});

		// Peer 11 is this client — the `hello` frame named it — so it is excluded
		// even though its state is well-formed. 12 and 13 are two distinct verified
		// principals, sorted by display name.
		const participants = rendered.result.current?.participants ?? [];
		expect(participants.map((peer) => peer.key)).toEqual([
			"opaque-ada",
			"opaque-grace",
		]);
		expect(rendered.result.current?.peers).toBe(3);
		rendered.unmount();
	});

	it("carries a peer's caret across a change instead of leaving it stale", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("hello") }),
		);
		const socket = lastSocket();
		await handshake(socket, "hello");

		await act(async () => {
			socket.deliver({
				t: "presence",
				peers: [
					[
						12,
						{
							user: identity,
							selection: { path: COLLAB_DOC_PATH, anchor: 5, head: 5 },
						},
					],
				],
			});
			await Promise.resolve();
		});
		expect(rendered.result.current?.participants[0]?.selection).toEqual({
			path: COLLAB_DOC_PATH,
			anchor: 5,
			head: 5,
		});

		await act(async () => {
			// Six characters inserted at offset 0: the caret must move with them.
			socket.deliver(row(1, [[COLLAB_DOC_PATH, { edit: [[0, "there "], 5] }]]));
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(rendered.result.current?.participants[0]?.selection).toEqual({
			path: COLLAB_DOC_PATH,
			anchor: 11,
			head: 11,
		});
		rendered.unmount();
	});

	it("keeps the document usable across a transient disconnect", async () => {
		const rendered = renderCollabDoc(input());
		const socket = lastSocket();
		await handshake(socket, "hello");
		expect(rendered.result.current?.status).toBe("connected");
		const session = rendered.result.current?.session;

		await act(async () => {
			socket.drop();
			await Promise.resolve();
		});

		expect(rendered.result.current?.status).toBe("disconnected");
		expect(rendered.result.current?.participants).toEqual([]);
		expect(rendered.result.current?.peers).toBe(0);
		// The session survives, and that is the point. This app's realtime lane
		// retries on a 30s ladder and holds leases across bfcache, so a blip is
		// routine; nulling the session would unmount the editor, destroy
		// CodeMirror's view, and take the user's cursor and scroll with it. The
		// surface makes the document read-only from `status` instead.
		expect(rendered.result.current?.session).toBe(session);
		expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
			"hello",
		);
		rendered.unmount();
	});

	it("reconnects on a widening ladder and resets it once a socket opens", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(input());
			const first = lastSocket();
			await act(async () => {
				first.open();
				await Promise.resolve();
			});

			// The ladder is the justification for keeping the editor mounted: a blip is
			// routine, and the surface goes read-only instead of destroying the view.
			await act(async () => {
				first.drop();
				await Promise.resolve();
			});
			expect(sockets).toHaveLength(1);
			await act(async () => {
				vi.advanceTimersByTime(999);
			});
			expect(sockets).toHaveLength(1);
			await act(async () => {
				vi.advanceTimersByTime(1);
			});
			expect(sockets).toHaveLength(2);
			expect(rendered.result.current?.status).toBe("connecting");

			// A second failure without an intervening open widens the delay: 1s, then 2s.
			await act(async () => {
				lastSocket().drop();
				vi.advanceTimersByTime(1_000);
			});
			expect(sockets).toHaveLength(2);
			await act(async () => {
				vi.advanceTimersByTime(1_000);
			});
			expect(sockets).toHaveLength(3);

			// An open resets it, so a long-lived session does not inherit an old backoff.
			await act(async () => {
				lastSocket().open();
				await Promise.resolve();
			});
			await act(async () => {
				lastSocket().drop();
				vi.advanceTimersByTime(1_000);
			});
			expect(sockets).toHaveLength(4);

			// And a disposed session climbs no further, whatever is still on the clock.
			rendered.unmount();
			await act(async () => {
				lastSocket().drop();
				vi.advanceTimersByTime(60_000);
			});
			expect(sockets).toHaveLength(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps the reconnect ladder rather than widening it forever", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(input());
			// 1s, 2s, 4s, 8s, 15s (capped), 15s. Ten failures must not become a delay
			// nobody waits out: a WS-blocking middlebox flap is routine, and the
			// document is read-only until the room comes back.
			for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
				const before = sockets.length;
				await act(async () => {
					lastSocket().drop();
					vi.advanceTimersByTime(delay - 1);
				});
				expect(sockets).toHaveLength(before);
				await act(async () => {
					vi.advanceTimersByTime(1);
				});
				expect(sockets).toHaveLength(before + 1);
			}
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("recycles the connection when the document changes", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("hello") }),
		);
		const first = lastSocket();
		await handshake(first, "hello");
		rendered.rerender(
			input({ docKey: "output:8", canonical: canonicalDoc("other") }),
		);
		expect(first.closed).toBe(true);
		expect(sockets).toHaveLength(2);
		expect(lastSocket().url).toContain("/collab/ws-1/output%3A8");
		rendered.unmount();
	});

	it("reports the ROOM's grounding, never the revision the surface loaded", async () => {
		// The surface has revision 6; the room's content is still revision 5. A
		// commit pinned to 6 would satisfy the compare-and-swap while writing
		// revision-5 text, destroying revision 6 silently and permanently.
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("six", 6) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });

		expect(rendered.result.current?.canonical).toEqual({
			revision: 5,
			revisionId: "rev-5",
		});
		// And the newer revision is offered to the room, which owns the decision.
		expect(socket.requestsOf("canonical").at(-1)?.offer).toEqual({
			revision: 6,
			revisionId: "rev-6",
			files: [[COLLAB_DOC_PATH, "six"]],
		});
		// Never forced on this module's own initiative.
		expect(socket.requestsOf("canonical").at(-1)?.force).toBeUndefined();
		rendered.unmount();
	});

	it("carries an unedited room forward and clears the recovery state", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("six", 6) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		await answerOffer(socket, "adopted", { revision: 6, revisionId: "rev-6" });

		expect(rendered.result.current?.canonical).toEqual({
			revision: 6,
			revisionId: "rev-6",
		});
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		rendered.unmount();
	});

	it("reports a rejected explicit restore instead of silently completing", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("saved", 2) }),
		);
		const socket = lastSocket();
		await handshake(socket, "invalid draft", 4, {
			revision: 2,
			revisionId: "rev-2",
		});
		const result = rendered.result.current!.replaceWithCanonical();
		const request = socket.requestsOf("canonical").at(-1)!;
		await act(async () => {
			socket.deliver({
				t: "canonicalResult",
				id: request.id,
				outcome: "busy",
				canonical: { revision: 2, revisionId: "rev-2" },
			});
			await Promise.resolve();
		});
		expect(await result).toMatchObject({
			ok: false,
			message: expect.stringContaining("busy"),
		});
		expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
			"invalid draft",
		);
		rendered.unmount();
	});

	it("sends explicit recovery even at the current revision and applies its shared row", async () => {
		const saved = "saved document";
		const broken = "invalid draft";
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc(saved, 2) }),
		);
		const socket = lastSocket();
		await handshake(socket, broken, 4, { revision: 2, revisionId: "rev-2" });
		expect(socket.requestsOf("canonical")).toHaveLength(0);
		await act(async () => {
			rendered.result.current?.replaceWithCanonical();
			await Promise.resolve();
		});
		expect(socket.requestsOf("canonical").at(-1)).toMatchObject({
			force: true,
			offer: {
				revision: 2,
				revisionId: "rev-2",
				files: [[COLLAB_DOC_PATH, saved]],
			},
		});
		await act(async () => {
			socket.deliver(
				row(
					5,
					diffFiles(
						new Map([[COLLAB_DOC_PATH, broken]]),
						new Map([[COLLAB_DOC_PATH, saved]]),
					),
				),
			);
			await Promise.resolve();
		});
		await answerOffer(socket, "adopted", { revision: 2, revisionId: "rev-2" });
		expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(saved);
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		rendered.unmount();
	});

	it("surfaces an edited room's refusal and offers it exactly once", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("six", 6) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		await answerOffer(socket, "edited", { revision: 5, revisionId: "rev-5" });

		expect(rendered.result.current?.recoveryRequired).toBe(true);
		// Still grounded at 5: the refusal changed nothing, and the commit pin must
		// keep naming the revision the room's content actually is.
		expect(rendered.result.current?.canonical).toEqual({
			revision: 5,
			revisionId: "rev-5",
		});
		// One offer per (target, room) pair. Re-offering on every broadcast would
		// be a retry loop against a decision only the user can change.
		expect(socket.requestsOf("canonical")).toHaveLength(1);

		// The user's explicit, warned choice — and only then is `force` set.
		await act(async () => {
			rendered.result.current?.replaceWithCanonical();
			await Promise.resolve();
		});
		const forced = socket.requestsOf("canonical").at(-1);
		expect(forced?.force).toBe(true);
		await answerOffer(socket, "adopted", { revision: 6, revisionId: "rev-6" });
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		expect(rendered.result.current?.canonical).toEqual({
			revision: 6,
			revisionId: "rev-6",
		});
		rendered.unmount();
	});

	it("takes a peer's adoption from the broadcast instead of re-offering", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("six", 6) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		await answerOffer(socket, "edited", { revision: 5, revisionId: "rev-5" });
		expect(rendered.result.current?.recoveryRequired).toBe(true);

		await act(async () => {
			// A peer resolved it. Every socket is told, so no peer keeps pinning its
			// commits to a revision the room has left behind.
			socket.deliver({
				t: "canonical",
				canonical: { revision: 6, revisionId: "rev-6" },
			});
			await Promise.resolve();
		});

		expect(rendered.result.current?.canonical).toEqual({
			revision: 6,
			revisionId: "rev-6",
		});
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		expect(socket.requestsOf("canonical")).toHaveLength(1);
		rendered.unmount();
	});

	it("offers nothing to a room already at the revision the surface loaded", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("five", 5) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });

		expect(socket.requestsOf("canonical")).toEqual([]);
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		rendered.unmount();
	});

	it("offers a revision the surface only loaded after the socket was up", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("five", 5) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		expect(socket.requestsOf("canonical")).toEqual([]);

		// A refetch carried revision 6. The session reads the box at offer time,
		// but nothing else would tell it to look.
		await act(async () => {
			rendered.rerender(input({ canonical: canonicalDoc("six", 6) }));
			await Promise.resolve();
		});

		expect(socket.requestsOf("canonical").at(-1)?.offer.revision).toBe(6);
		// The same socket, and the same session: a later canonical value must not
		// recreate the connection and discard the user's in-flight edits.
		expect(sockets).toHaveLength(1);
		rendered.unmount();
	});

	it("grounds the room on its own commit instead of offering it as an adoption", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("five", 5) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		const session = rendered.result.current?.session;

		// The user types, and the edit is acknowledged: the room is at revision 1.
		await act(async () => {
			session?.applyLocal(
				[[COLLAB_DOC_PATH, { edit: [4, [0, "x"]] }]],
				COLLAB_DOC_PATH,
				"fivex",
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		const submitted = socket.requestsOf("submit").at(-1);
		await act(async () => {
			socket.deliver({
				t: "row",
				row: {
					generation: 0,
					revision: 1,
					timestampMs: 1,
					author: identity,
					change: [[COLLAB_DOC_PATH, { edit: [4, [0, "x"]] }]],
					submission: {
						clientId: submitted?.submission.clientId ?? "",
						seq: 1,
					},
				},
			});
			await Promise.resolve();
			await Promise.resolve();
		});

		// The basis is taken before the commit: the text, and the position it came from.
		const basis = rendered.result.current?.commitBasis();
		expect(basis).toEqual({
			text: "fivex",
			position: { generation: 0, revision: 1 },
		});

		// ...and the user keeps typing while the commit is in flight.
		await act(async () => {
			session?.applyLocal(
				[[COLLAB_DOC_PATH, { edit: [5, [0, "y"]] }]],
				COLLAB_DOC_PATH,
				"fivexy",
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		// The commit produced revision 6. Ground on it.
		await act(async () => {
			rendered.result.current?.groundCommit(basis!, 6, "rev-6");
			await Promise.resolve();
		});
		const claim = socket.requestsOf("ground").at(-1);
		expect(claim?.offer).toEqual({
			revision: 6,
			revisionId: "rev-6",
			files: [[COLLAB_DOC_PATH, "fivex"]],
		});
		expect(claim?.at).toEqual({ generation: 0, revision: 1 });
		await act(async () => {
			socket.deliver({
				t: "canonicalResult",
				id: claim?.id ?? 1,
				outcome: "repaired",
				canonical: { revision: 6, revisionId: "rev-6" },
			});
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(rendered.result.current?.canonical).toEqual({
			revision: 6,
			revisionId: "rev-6",
		});
		expect(rendered.result.current?.recoveryRequired).toBe(false);

		// The wedge. The surface's query now refetches revision 6. Offered as an
		// ordinary adoption it would be refused -- the room is ahead of it, not
		// behind -- and the panel would block Commit and offer only a replacement
		// that discards everything typed since. Grounded, there is nothing to offer.
		await act(async () => {
			rendered.rerender(input({ canonical: canonicalDoc("fivex", 6) }));
			await Promise.resolve();
		});
		expect(socket.requestsOf("canonical")).toEqual([]);
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
			"fivexy",
		);
		rendered.unmount();
	});

	it("falls back to the ordinary offer when the room refuses the claim", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("five", 5) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		const basis = rendered.result.current?.commitBasis();

		await act(async () => {
			rendered.result.current?.groundCommit(basis!, 6, "rev-6");
			await Promise.resolve();
		});
		await act(async () => {
			socket.deliver({
				t: "canonicalResult",
				id: socket.requestsOf("ground").at(-1)?.id ?? 1,
				outcome: "edited",
				canonical: { revision: 5, revisionId: "rev-5" },
			});
			await Promise.resolve();
			await Promise.resolve();
		});

		// The position that commit named no longer describes the room, so the claim
		// is dropped rather than retried: the room is still grounded at 5, and the
		// surface has loaded nothing newer to offer it yet.
		expect(rendered.result.current?.canonical).toEqual({
			revision: 5,
			revisionId: "rev-5",
		});
		expect(rendered.result.current?.recoveryRequired).toBe(false);

		// Once the refetch carries revision 6, it goes out as an ordinary offer,
		// which can still succeed if the room has since converged on the committed
		// text byte for byte -- and is refused, with the user's explicit recovery, if
		// it has not. A dropped claim never becomes a retry loop.
		await act(async () => {
			rendered.rerender(input({ canonical: canonicalDoc("five", 6) }));
			await Promise.resolve();
		});
		expect(socket.requestsOf("canonical").at(-1)?.offer.revision).toBe(6);
		expect(socket.requestsOf("ground")).toHaveLength(1);
		await answerOffer(socket, "edited", { revision: 5, revisionId: "rev-5" });
		expect(rendered.result.current?.recoveryRequired).toBe(true);
		rendered.unmount();
	});

	it("never wedges a room that typed through its own commit, and loses none of it", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("five", 5) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		const session = rendered.result.current?.session;

		/** One keystroke, applied the way the editor applies one. */
		const type = async (at: number, text: string, after: string) => {
			await act(async () => {
				session?.applyLocal(
					[[COLLAB_DOC_PATH, { edit: [at, [0, text]] }]],
					COLLAB_DOC_PATH,
					after,
				);
				await Promise.resolve();
				await Promise.resolve();
			});
		};
		/** The room agrees to the submission that is out, exactly as the authority echoes it. */
		const ack = async (revision: number, at: number, text: string) => {
			const submitted = socket.requestsOf("submit").at(-1);
			await act(async () => {
				socket.deliver({
					t: "row",
					row: {
						generation: 0,
						revision,
						timestampMs: 1,
						author: identity,
						change: [[COLLAB_DOC_PATH, { edit: [at, [0, text]] }]],
						submission: {
							clientId: submitted?.submission.clientId ?? "",
							seq: submitted?.submission.seq ?? 1,
						},
					},
				});
				await Promise.resolve();
				await Promise.resolve();
			});
		};

		// The user keeps typing. While anything is unacknowledged there is no stream position that
		// describes the text on screen, so there is no basis -- and the surface must not commit.
		await type(4, "x", "fivex");
		expect(rendered.result.current?.unacknowledged).toBe(true);
		expect(rendered.result.current?.commitBasis()).toBeNull();
		await type(5, "y", "fivexy");
		expect(rendered.result.current?.unacknowledged).toBe(true);
		expect(rendered.result.current?.commitBasis()).toBeNull();

		// And it clears, which is why waiting is not a LIVELOCK. Submissions compose: "x" was out,
		// "y" rode the next one, and two acknowledgements settle everything typed so far however
		// many keystrokes went into them.
		await ack(1, 4, "x");
		await ack(2, 5, "y");
		expect(rendered.result.current?.unacknowledged).toBe(false);
		const basis = rendered.result.current?.commitBasis();
		expect(basis).toEqual({
			text: "fivexy",
			position: { generation: 0, revision: 2 },
		});

		// The commit goes out on that basis, and the user types through the round trip.
		await type(6, "z", "fivexyz");
		await act(async () => {
			rendered.result.current?.groundCommit(basis!, 6, "rev-6");
			await Promise.resolve();
		});
		await act(async () => {
			socket.deliver({
				t: "canonicalResult",
				id: socket.requestsOf("ground").at(-1)?.id ?? 1,
				outcome: "repaired",
				canonical: { revision: 6, revisionId: "rev-6" },
			});
			await Promise.resolve();
			await Promise.resolve();
		});

		// The surface's query refetches revision 6 -- the revision this room just wrote.
		await act(async () => {
			rendered.rerender(input({ canonical: canonicalDoc("fivexy", 6) }));
			await Promise.resolve();
		});

		// No wedge. Nothing was offered as an adoption, so nothing was refused, so the user is not
		// staring at a destructive Replace as the only way out...
		expect(socket.requestsOf("canonical")).toEqual([]);
		expect(rendered.result.current?.recoveryRequired).toBe(false);
		// ...and the keystroke that rode through the commit is still in the document.
		expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
			"fivexyz",
		);

		// The out-of-band protection is untouched, and it is the entire point of this record: a
		// revision 7 nobody in this room committed -- a proposal merge, a tedi edit, the API --
		// still goes out as an ordinary offer, is still refused, and still demands the user's
		// explicit recovery.
		await act(async () => {
			rendered.rerender(input({ canonical: canonicalDoc("a merge", 7) }));
			await Promise.resolve();
		});
		expect(socket.requestsOf("canonical").at(-1)?.offer.revision).toBe(7);
		await answerOffer(socket, "edited", { revision: 6, revisionId: "rev-6" });
		expect(rendered.result.current?.recoveryRequired).toBe(true);
		rendered.unmount();
	});

	it("re-grounds its own commit after a reconnect instead of offering it", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });
			const basis = rendered.result.current?.commitBasis();

			// The commit produced revision 6 and the claim goes out -- and the socket dies before
			// the room answers it, so the room is still grounded on 5.
			await act(async () => {
				rendered.result.current?.groundCommit(basis!, 6, "rev-6");
				await Promise.resolve();
			});
			expect(first.requestsOf("ground")).toHaveLength(1);
			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});

			// A fresh socket rebuilds the client and re-observes the room's old stamp.
			const second = lastSocket();
			expect(second).not.toBe(first);
			await handshake(second, "five", 0, {
				revision: 5,
				revisionId: "rev-5",
			});

			// Only now does the surface's query refetch revision 6. This is the path: the room is
			// behind a revision this client itself wrote, and offering it as an ordinary adoption
			// would be refused the moment anyone had typed -- the wedge. The record of what was
			// committed, and the position it came from, outlives the socket, so the claim is simply
			// made again.
			await act(async () => {
				rendered.rerender(input({ canonical: canonicalDoc("five", 6) }));
				await Promise.resolve();
			});

			expect(second.requestsOf("canonical")).toEqual([]);
			const claim = second.requestsOf("ground").at(-1);
			expect(claim?.offer).toEqual({
				revision: 6,
				revisionId: "rev-6",
				files: [[COLLAB_DOC_PATH, "five"]],
			});
			expect(claim?.at).toEqual({ generation: 0, revision: 0 });
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes no commit basis while this client holds unacknowledged edits", async () => {
		const rendered = renderCollabDoc(
			input({ canonical: canonicalDoc("five", 5) }),
		);
		const socket = lastSocket();
		await handshake(socket, "five", 0, { revision: 5, revisionId: "rev-5" });
		expect(rendered.result.current?.commitBasis()).not.toBeNull();

		await act(async () => {
			rendered.result.current?.session?.applyLocal(
				[[COLLAB_DOC_PATH, { edit: [4, [0, "x"]] }]],
				COLLAB_DOC_PATH,
				"fivex",
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		// The displayed text is not any stream position's content while a submission
		// is out, so there is nothing the room could later be grounded on.
		expect(rendered.result.current?.commitBasis()).toBeNull();
		rendered.unmount();
	});

	it("clears `unacknowledged` when a reconnect replaces a client that held edits", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });
			expect(rendered.result.current?.unacknowledged).toBe(false);

			await typeCharacter(rendered, 4, "x", "fivex");
			expect(rendered.result.current?.unacknowledged).toBe(true);
			expect(rendered.result.current?.commitBasis()).toBeNull();

			// The socket dies before the ACK. This state lives on the session, which
			// outlives the socket, while the client that published it does not: the
			// ladder disposes the dirty client and builds a fresh one whose own
			// transition guard starts `false`. A rebuild tail that published through
			// that guard compared `false === false` and stayed silent, so
			// `unacknowledged` stayed `true` forever and Commit was permanently
			// disabled — escapable only by typing another character and waiting for an
			// ack, a wedge whose exit costs the user an edit. The tail therefore
			// publishes `false` unconditionally; this is the test that fails without it.
			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			const second = lastSocket();
			expect(second).not.toBe(first);
			await handshake(second, "five", 0, { revision: 5, revisionId: "rev-5" });

			expect(rendered.result.current?.unacknowledged).toBe(false);
			// And Commit is genuinely available again, not merely un-greyed: the room's
			// text sits at a stream position, so a commit taken now has a basis.
			expect(rendered.result.current?.commitBasis()).toEqual({
				text: "five",
				position: { generation: 0, revision: 0 },
			});
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears `blocked` when a reconnect replaces a client the room had blocked", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });
			expect(rendered.result.current?.blocked).toBeNull();

			await typeCharacter(rendered, 4, "x", "fivex");
			const submitted = first.requestsOf("submit").at(-1);
			expect(submitted).toBeDefined();

			// The room refuses for capacity. Not a hard rejection: the client keeps
			// resending on a backoff (a commit reseeds the room and the next attempt
			// lands), so the edit stays unacknowledged and unsent while blocked.
			await act(async () => {
				first.deliver({
					t: "result",
					id: submitted?.id ?? 1,
					result: { ok: false, code: "capacity", message: "Room is full." },
				});
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(rendered.result.current?.blocked?.code).toBe("capacity");
			expect(rendered.result.current?.unsynced).toBe(true);
			expect(rendered.result.current?.unacknowledged).toBe(true);

			// The socket dies while blocked. `blocked` lives on the session, which
			// outlives the socket; the client that published it does not. Teardown
			// neither clears the session's copy nor reports one, and the replacement
			// client's own transition guard starts `null` — so a rebuild tail that
			// published through that guard compared `null === null` and stayed silent.
			// `canvas-editor` computes `editable = !readOnly && block === null`, so the
			// editor stayed permanently read-only under a false "Editing paused" alert,
			// escapable only by a full page reload. The tail therefore publishes `null`
			// unconditionally; this is the test that fails without it. It cannot be
			// written against `OtClient` alone: the defect needs a client replaced under
			// a surviving session, which only this hook produces.
			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			const second = lastSocket();
			expect(second).not.toBe(first);
			await handshake(second, "five", 0, { revision: 5, revisionId: "rev-5" });

			expect(rendered.result.current?.blocked).toBeNull();
			// The session's own copy, not merely the React mirror: that is the value
			// teardown left stale, and the one the surface would keep reading.
			expect(rendered.result.current?.session?.blocked()).toBeNull();
			// Its two siblings clear on the same rebuild, and all three must agree —
			// an editable editor that still claims unsent edits is its own wedge.
			expect(rendered.result.current?.unsynced).toBe(false);
			expect(rendered.result.current?.unacknowledged).toBe(false);
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says so when a reconnect discarded unacknowledged edits", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });

			await typeCharacter(rendered, 4, "x", "fivex");
			expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
				"fivex",
			);

			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			await handshake(lastSocket(), "five", 0, {
				revision: 5,
				revisionId: "rev-5",
			});

			// The character is gone. There is no offline log: the buffers died with the
			// client and the replacement rebuilt from the room's base. The user must be
			// told — a keystroke that silently never existed is the worst outcome this
			// module can produce, and `unacknowledged` clearing on its own would
			// otherwise read as "saved".
			expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
				"five",
			);
			expect(rendered.result.current?.discarded).toBe(1);
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("warns exactly once, not again on every row that follows", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });

			await typeCharacter(rendered, 4, "x", "fivex");
			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			await handshake(lastSocket(), "five", 0, {
				revision: 5,
				revisionId: "rev-5",
			});
			expect(rendered.result.current?.discarded).toBe(1);

			// The latch must be cleared WHERE it IS read. A suspicion that survives its own
			// resolution is a stuck-true signal: every later remote row publishes content and
			// would re-raise the warning, for the life of the session, over a document that is
			// losing nothing. One real loss must produce exactly one warning.
			await act(async () => {
				lastSocket().deliver(
					row(1, [[COLLAB_DOC_PATH, { edit: [4, [0, "!"]] }]]),
				);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
				"five!",
			);
			expect(rendered.result.current?.discarded).toBe(1);
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not warn when the reconnect lost a submission the room had already taken", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });

			await typeCharacter(rendered, 4, "x", "fivex");
			expect(first.requestsOf("submit")).toHaveLength(1);

			// The room accepted that submission and the response died on the wire. The buffers
			// still look unacknowledged at teardown, so the loss latch fires -- but the
			// replacement's base already carries the character and nothing was lost. Warning here
			// is the spurious alert the client refuses to raise on its own path: it renders
			// "the document below is what every connected editor now sees" over a document that
			// did not change, and teaches the user to ignore the warning that is true.
			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			await handshake(lastSocket(), "fivex", 1, {
				revision: 5,
				revisionId: "rev-5",
			});

			expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
				"fivex",
			);
			expect(rendered.result.current?.discarded).toBe(0);
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("republishes the room's content BEFORE it reports the discard", async () => {
		vi.useFakeTimers();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });
			await typeCharacter(rendered, 4, "x", "fivex");

			// An ordering discriminator, not a supported listener: an editor must not throw out of
			// a remote change. It is the only way to observe which of the two calls happens first,
			// and the order is load-bearing for the surface's copy -- the warning claims the
			// document below is what everyone now sees, which is false while the editor is still
			// showing the text that was discarded. So the discard is reported only after the
			// republish, never before it.
			rendered.result.current?.session?.onRemote(() => {
				throw new Error("editor refused the remote change");
			});

			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			await handshake(lastSocket(), "five", 0, {
				revision: 5,
				revisionId: "rev-5",
			});

			expect(rendered.result.current?.discarded).toBe(0);
			rendered.unmount();
		} finally {
			errors.mockRestore();
			vi.useRealTimers();
		}
	});

	it("clears the discard warning when the document changes", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });
			await typeCharacter(rendered, 4, "x", "fivex");
			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			await handshake(lastSocket(), "five", 0, {
				revision: 5,
				revisionId: "rev-5",
			});
			expect(rendered.result.current?.discarded).toBe(1);

			// `discarded` describes one document's session. Carrying it across a document change
			// would put "unsent edits were discarded" over a document that never had any, and
			// nothing inside this hook would prevent it -- the consuming surface's `key` is in
			// another file and one edit away from not being there.
			rendered.rerender(
				input({ docKey: "output:8", canonical: canonicalDoc("other", 5) }),
			);

			expect(rendered.result.current?.discarded).toBe(0);
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("warns about no discard when the reconnect had nothing to eat", async () => {
		vi.useFakeTimers();
		try {
			const rendered = renderCollabDoc(
				input({ canonical: canonicalDoc("five", 5) }),
			);
			const first = lastSocket();
			await handshake(first, "five", 0, { revision: 5, revisionId: "rev-5" });

			// A blip with nothing unacknowledged loses nothing, and a spurious "your
			// edits were discarded" alert over an ordinary reconnect teaches the user
			// to ignore the one that is true.
			await act(async () => {
				first.drop();
				vi.advanceTimersByTime(1_000);
			});
			await handshake(lastSocket(), "five", 0, {
				revision: 5,
				revisionId: "rev-5",
			});

			expect(rendered.result.current?.discarded).toBe(0);
			expect(rendered.result.current?.session?.text(COLLAB_DOC_PATH)).toBe(
				"five",
			);
			rendered.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("publishes the surface's Canvas location and nothing else", async () => {
		const rendered = renderCollabDoc(
			input({
				location: {
					surface: "canvas",
					artifactKind: "gadget",
					artifactLabel: "Research",
				},
			}),
		);
		const socket = lastSocket();
		await handshake(socket, "hello");
		expect(socket.requestsOf("presence").at(-1)?.state).toEqual({
			location: {
				surface: "canvas",
				artifactKind: "gadget",
				artifactLabel: "Research",
			},
		});
		rendered.unmount();
	});
});
