/**
 * Collaborative-editing room Durable Object: the OT authority for one document,
 * plus its live presence roster.
 *
 * The room holds live session state only: it is never canonical truth and it never
 * writes D1. Canonical commits flow through the `apps/api` revision contracts.
 * What the DO owns is the ordering of uncommitted edits — `./ot/authority` is
 * the single point at which one submission is transformed onto the head and
 * appended to the revision stream, and a Durable Object is what makes that
 * single-writer, run-to-completion span exist at all.
 *
 * No AUTH logic lives here. The worker (`src/worker.ts`) authorizes the caller
 * against `apps/api` before routing the upgrade to this DO; by the time `fetch`
 * runs, the request is already authorized for this room. The DO never sees a
 * credential, only the Worker's verified presence projection.
 *
 * The room holds no second copy of D1 truth, but it does know which revision it
 * is grounded on. The server-agreed revision is the base: the stream starts
 * from one seed and every later state is that seed plus an ordered list of
 * changes, so there is no separate draft to reconcile against canonical. What
 * the room records is the answer to "WHICH ONE" — the canonical revision the
 * seed came from (`OtAuthority.seed`) and the offers that carry it forward
 * (`adoptCanonical`) — because a commit's compare-and-swap must be pinned to
 * the revision the user is actually editing, not to whatever D1 reports at the
 * instant they press Commit. Pinning to the latter overwrites a revision
 * committed out of band with text that never saw it.
 *
 * All three grounding handshakes come from the client and all three are safe
 * for the same reason: the authority is a single writer and decides. `seed` is
 * idempotent — two clients racing produce one base, not two — `canonical`
 * adopts only an unedited or byte-identical room unless the user explicitly
 * forces a replacement, and expresses the adoption as one server-authored row
 * rather than a base swap, so every replica converges through the ordinary
 * path; and `ground` is a claim the authority checks against its own stream
 * before it moves anything, so a client can state which position its commit
 * came from without being able to state anything false about it.
 *
 * Hibernation. Uses the WebSocket hibernation API (`state.acceptWebSocket` plus
 * the `webSocketMessage`/`webSocketClose`/`webSocketError` handlers) so idle
 * rooms cost nothing, and everything a wake needs is durable: the authority
 * rehydrates the stream from DO storage on first use, and each socket's peer id
 * and verified identity ride in its serialized attachment. Two properties
 * follow, and the first is why this room needs no alarm at all:
 *   - No in-memory timer and no alarm. There is nothing to debounce: the
 *     authority enqueues each accepted row inside its synchronous span, and the
 *     DO's output gate holds the broadcast until that write commits, so
 *     durability is per-row and immediate. A snapshot debounce would need an
 *     alarm to survive hibernation; there is no snapshot.
 *   - The roster is memory-only and self-healing. Presence is rebuilt from the
 *     clients' periodic re-broadcasts after a wake.
 *
 * Typed structurally against the Durable Object surface it uses (the app's
 * tsconfig ships DOM+ESNext libs, not workers-types), mirroring how
 * `worker.ts` stays testable without Workers-only globals.
 */
import { OtAuthority, type OtAuthorityStorage } from "./ot/authority";
import type { CodeChangeRow } from "./ot/wire";
import {
	type CollabServerFrame,
	contentToFiles,
	encodeFrame,
	isOversizedMessage,
	parseClientFrame,
} from "./protocol";
import {
	COLLAB_PRESENCE_HEADER,
	type CollabVerifiedIdentity,
	parseCollabPresenceHeader,
	parseCollabVerifiedIdentity,
	sanitizeCollabPresenceState,
} from "./presence";

export interface CollabSocket {
	send(data: ArrayBuffer | Uint8Array | string): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
}

/** The DO storage surface the room needs: exactly what `OtAuthority` uses. */
export type CollabStorage = OtAuthorityStorage;

export interface CollabRoomState {
	readonly storage: CollabStorage;
	acceptWebSocket(ws: CollabSocket): void;
	getWebSockets(): CollabSocket[];
}

interface AcceptableSocket extends CollabSocket {
	accept(): void;
}

type WebSocketPairCtor = new () => { 0: AcceptableSocket; 1: AcceptableSocket };

/**
 * What survives hibernation per socket: the peer id its presence is filed
 * under, and the Worker-verified identity every frame from it is attributed to.
 * The identity must be durable — a wake must not have to re-derive a principal
 * it can no longer authenticate, and it is what `sanitizeCollabPresenceState`
 * overwrites `user` with on every presence frame.
 */
interface SocketAttachment {
	peerId: number;
	identity: CollabVerifiedIdentity | null;
}

const MAX_SOCKETS = 32;
/** 1013 = "try again later": the room is over its concurrency cap. */
const CLOSE_ROOM_FULL = 1013;

function readAttachment(ws: CollabSocket): SocketAttachment {
	try {
		const value = ws.deserializeAttachment();
		if (typeof value === "object" && value !== null) {
			const attachment = value as Record<string, unknown>;
			return {
				peerId:
					Number.isSafeInteger(attachment.peerId) &&
					(attachment.peerId as number) >= 0
						? (attachment.peerId as number)
						: 0,
				identity: parseCollabVerifiedIdentity(attachment.identity),
			};
		}
	} catch {
		// A socket without an attachment yet; fall through to the empty shape.
	}
	return { peerId: 0, identity: null };
}

export class CollabRoom {
	readonly #authority: OtAuthority;

	/**
	 * The live roster: peer id -> sanitized presence state. Memory-only on
	 * purpose. Presence describes who is connected right now, so persisting it
	 * would mean persisting a claim that a wake cannot verify and a crash cannot
	 * retract; clients re-broadcast on an interval, so an emptied roster refills
	 * itself within one period.
	 */
	readonly #presence = new Map<number, Record<string, unknown>>();

	constructor(private readonly state: CollabRoomState) {
		this.#authority = new OtAuthority({
			storage: state.storage,
			broadcast: (row) => this.#broadcastRow(row),
			now: () => Date.now(),
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade.\n", {
				status: 426,
				headers: { Upgrade: "websocket" },
			});
		}
		const identity = parseCollabPresenceHeader(
			request.headers.get(COLLAB_PRESENCE_HEADER),
		);
		if (!identity) {
			return new Response("Verified collaboration identity required.\n", {
				status: 403,
			});
		}
		const Pair = (globalThis as { WebSocketPair?: WebSocketPairCtor })
			.WebSocketPair;
		if (!Pair) {
			return new Response("WebSockets are unavailable on this runtime.\n", {
				status: 500,
			});
		}
		const { 0: client, 1: server } = new Pair();

		if (this.state.getWebSockets().length >= MAX_SOCKETS) {
			// Accept outside the hibernation set purely to deliver the close code.
			server.accept();
			server.close(CLOSE_ROOM_FULL, "Room is at capacity; try again later.");
			return new Response(null, {
				status: 101,
				webSocket: client,
			} as ResponseInit);
		}

		const peerId = this.#nextPeerId();
		this.state.acceptWebSocket(server);
		server.serializeAttachment({
			peerId,
			identity,
		} satisfies SocketAttachment);
		this.#send(server, { t: "hello", peerId });
		if (this.#presence.size > 0) {
			this.#send(server, { t: "presence", peers: [...this.#presence] });
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
		} as ResponseInit);
	}

	/**
	 * A peer id names one socket for the life of that socket, and nothing else:
	 * it is not an identity (`author.key` is), it is not durable across a
	 * reconnect, and a client may not choose it. Drawn at random and re-drawn on
	 * a collision with a live socket, so two peers can never share a roster row.
	 */
	#nextPeerId(): number {
		const taken = new Set(
			this.state.getWebSockets().map((ws) => readAttachment(ws).peerId),
		);
		for (;;) {
			const candidate = Math.floor(Math.random() * 2 ** 31) + 1;
			if (!taken.has(candidate)) return candidate;
		}
	}

	async webSocketMessage(
		ws: CollabSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		// The protocol is JSON text frames; drop binary and oversized payloads.
		if (typeof message !== "string") return;
		if (isOversizedMessage(message.length)) return;
		const frame = parseClientFrame(message);
		if (!frame) return;
		const { peerId, identity } = readAttachment(ws);
		if (!identity) return;

		if (frame.t === "presence") {
			this.#presence.set(
				peerId,
				sanitizeCollabPresenceState(frame.state, identity),
			);
			this.#broadcastPresence();
			return;
		}
		if (frame.t === "base") {
			try {
				if (frame.seed) {
					await this.#authority.seed(new Map(frame.seed.files), {
						revision: frame.seed.revision,
						revisionId: frame.seed.revisionId,
					});
				}
				// One snapshot, not three reads. `head()`, `content()` and `canonical()`
				// each resolve separately -- `content()` on a storage read -- so an
				// answer assembled from all three can describe three different
				// instants and hand a joining client a base whose stamp does not name
				// its bytes. `snapshot()` takes the position, the content and the
				// grounding in one synchronous continuation.
				const snapshot = await this.#authority.snapshot();
				this.#send(ws, {
					t: "base",
					id: frame.id,
					generation: snapshot.position.generation,
					revision: snapshot.position.revision,
					files: contentToFiles(snapshot.content),
					canonical: snapshot.canonical,
				});
			} catch (error) {
				this.#send(ws, {
					t: "error",
					id: frame.id,
					message: (error as Error).message,
				});
			}
			return;
		}
		if (frame.t === "canonical") {
			// The authority owns the decision — unedited rooms carry forward, edited
			// ones are refused until the user forces it — and expresses an adoption
			// as one server-authored row, which reaches every socket through the
			// ordinary `#broadcastRow` path.
			const result = await this.#authority.adoptCanonical({
				canonical: {
					revision: frame.offer.revision,
					revisionId: frame.offer.revisionId,
				},
				files: new Map(frame.offer.files),
				author: identity,
				force: frame.force === true,
			});
			this.#send(ws, {
				t: "canonicalResult",
				id: frame.id,
				outcome: result.ok ? result.effect : result.code,
				canonical: result.canonical,
			});
			// Every socket learns a moved grounding, or a peer keeps pinning its
			// commits to a canonical revision this room has left behind.
			if (result.ok && result.effect !== "current") {
				this.#broadcast({ t: "canonical", canonical: result.canonical });
			}
			return;
		}
		if (frame.t === "ground") {
			// A claim about a commit this client just made: "the room's content at
			// this stream position became canonical revision N". The authority
			// verifies it against its own stream and refuses anything else, so a peer
			// cannot use it to relabel a colleague's unsaved edits as committed. See
			// `OtAuthority.groundCanonical`.
			const result = await this.#authority.groundCanonical({
				canonical: {
					revision: frame.offer.revision,
					revisionId: frame.offer.revisionId,
				},
				files: new Map(frame.offer.files),
				at: frame.at,
			});
			this.#send(ws, {
				t: "canonicalResult",
				id: frame.id,
				outcome: result.ok ? result.effect : result.code,
				canonical: result.canonical,
			});
			// The same broadcast an adoption sends, for the same reason: a grounding
			// that moved the stamp must reach every socket, or a peer keeps pinning
			// its commits to a canonical revision this room has left behind.
			if (result.ok && result.effect !== "current") {
				this.#broadcast({ t: "canonical", canonical: result.canonical });
			}
			return;
		}
		// A submission. The authority owns validation, ordering, and the
		// broadcast; the room only supplies the transport-verified author, which
		// is never anything the client asserted.
		const result = await this.#authority.submit(frame.submission, identity);
		this.#send(ws, { t: "result", id: frame.id, result });
	}

	async webSocketClose(ws: CollabSocket): Promise<void> {
		this.#forget(ws);
	}

	async webSocketError(ws: CollabSocket): Promise<void> {
		this.#forget(ws);
	}

	#forget(ws: CollabSocket): void {
		const { peerId } = readAttachment(ws);
		if (this.#presence.delete(peerId)) this.#broadcastPresence(ws);
	}

	#broadcastRow(row: CodeChangeRow): void {
		// Every socket, the submitter's included: a client recognizes its own row
		// by the `submission` echo and retires the matching pending edit on it.
		// See the own-echo path in `./ot/client`.
		this.#broadcast({ t: "row", row });
	}

	#broadcastPresence(exclude?: CollabSocket): void {
		this.#broadcast({ t: "presence", peers: [...this.#presence] }, exclude);
	}

	#broadcast(frame: CollabServerFrame, exclude?: CollabSocket): void {
		const payload = encodeFrame(frame);
		for (const ws of this.state.getWebSockets()) {
			if (ws === exclude) continue;
			try {
				ws.send(payload);
			} catch {
				// A socket torn down mid-broadcast; its close handler cleans up.
			}
		}
	}

	#send(ws: CollabSocket, frame: CollabServerFrame): void {
		try {
			ws.send(encodeFrame(frame));
		} catch {
			// Same: a dying socket is the close handler's problem, not this path's.
		}
	}
}
