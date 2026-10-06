/**
 * The collaboration socket's frame envelope: what a browser and a `CollabRoom`
 * say to each other, and the decoders that establish it.
 *
 * The protocol carries four things and nothing else — the base handshake, the
 * canonical-grounding handshake, OT submissions in with their accepted rows
 * out, and presence. Everything is plain JSON text frames: `./ot/wire`'s `CodeChangeSubmission` and
 * `CodeChangeRow` are already JSON by construction (rows are persisted in
 * exactly the shape they are broadcast in), so there is no binary codec here
 * and nothing to keep byte-compatible with a third-party client.
 *
 * Nothing outside this repository speaks the OT protocol, so the frame is a
 * discriminated union and `JSON.parse` is the codec — there is no third-party
 * client to stay byte-compatible with.
 *
 * TRUST BOUNDARY, and the same division of labour `./ot/wire` states in its own
 * header: this module owns the ENVELOPE's structure and delegates the payloads
 * to the decoders that own them — `parseCodeChangeSubmission` for a submission,
 * `parseCollabVerifiedIdentity` (via `parseCodeChangeRow`) for a row's author.
 * It checks nothing semantic; every content invariant belongs to
 * `./ot/code-change`'s validators, which the authority runs on ingestion.
 *
 * Like `./ot/wire` and `./presence`, every `parse*` here returns `null` on any
 * malformed input and never throws: a bad frame is dropped, never propagated as
 * an exception that would tear the room down.
 */

import type { CodeContent } from "./ot/code-change";
import {
	type CodeChangeRow,
	type CodeChangeSubmission,
	parseCodeChangeRow,
	parseCodeChangeSubmission,
	type StreamPosition,
} from "./ot/wire";
import type {
	CanonicalAdoptResult,
	CodeChangeSubmitResult,
} from "./ot/authority";

/**
 * The single file path a Canvas room's document lives under.
 *
 * `CodeChange` is multi-file by construction (see `./ot/code-change`) and the
 * room imposes no limit of its own; today's surfaces — a gadget manifest, an
 * output body — are one document each, and this is that document's path.
 */
export const COLLAB_DOC_PATH = "document";

/**
 * Hard cap on a single frame. One MiB is the Workers WebSocket message limit,
 * so it is the transport's own ceiling rather than a policy of ours; a change
 * large enough to exceed it cannot cross the socket at all, whatever
 * `MAX_CODE_CHANGE_SIZE` in `./ot/code-change` permits on the far side.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export function isOversizedMessage(byteLength: number): boolean {
	return byteLength > MAX_MESSAGE_BYTES;
}

// =======================================================================================
// Frames

/**
 * One canonical revision as the room refers to it: the number a commit's
 * compare-and-swap is pinned to, plus the immutable revision id it names.
 */
export interface CollabCanonicalStamp {
	revision: number;
	/** `null` for a document with no committed revision yet. */
	revisionId: string | null;
}

/**
 * A canonical revision offered to the room: the stamp plus that revision's
 * content, read from the canonical store by the client making the offer.
 *
 * The same shape seeds an ungrounded room and carries a grounded one forward,
 * because they are the same statement — "this is canonical revision N, and this
 * is what it says". The server decides which of the two it is.
 */
export interface CollabCanonicalOffer extends CollabCanonicalStamp {
	files: [string, string][];
}

/**
 * What the room did with an offer: `OtAuthority`'s effect, or its refusal code.
 * Derived from the authority's own result so the wire cannot drift from it.
 */
export type CollabCanonicalOutcome =
	| Extract<CanonicalAdoptResult, { ok: true }>["effect"]
	| Extract<CanonicalAdoptResult, { ok: false }>["code"];

/**
 * Client to server.
 *
 * - `base` asks for the room's content, stream position, and canonical
 *   grounding, optionally offering a `seed` for a room that has none yet.
 *   Seeding from the client is safe: `OtAuthority.seed` is single-writer and
 *   idempotent, so a later offer is ignored rather than merged, and two clients
 *   racing produce one base instead of two concatenated histories.
 * - `canonical` offers a NEWER canonical revision to an already-grounded room.
 *   The server owns the decision (`OtAuthority.adoptCanonical`); `force` is the
 *   user's explicit choice to replace an edited room's content and is never
 *   sent on its own initiative by a client.
 * - `ground` says "I committed the room's content AT THIS STREAM POSITION and
 *   it became canonical revision N". It is a CLAIM, not an instruction: the
 *   server folds its own stream to `at` and refuses unless the content there is
 *   byte-for-byte `offer.files` (`OtAuthority.groundCanonical`). It exists
 *   because a room that keeps typing through its own commit is neither unedited
 *   nor byte-identical by the time the surface learns N, so offering N as an
 *   ordinary `canonical` would be refused and would wedge the document.
 * - `submit` offers one change against the revision the client last saw.
 * - `presence` publishes this client's own live cursor/location state.
 */
export type CollabClientFrame =
	| { t: "base"; id: number; seed?: CollabCanonicalOffer }
	| { t: "canonical"; id: number; offer: CollabCanonicalOffer; force?: boolean }
	| {
			t: "ground";
			id: number;
			offer: CollabCanonicalOffer;
			/** The stream position the caller committed `offer.files` from. Server-validated. */
			at: StreamPosition;
	  }
	| { t: "submit"; id: number; submission: CodeChangeSubmission }
	| { t: "presence"; state: unknown };

/**
 * Server to client.
 *
 * - `hello` names the peer id this socket was assigned, so a client can exclude
 *   itself from the roster.
 * - `base` answers a `base` request; `result` answers a `submit`.
 * - `row` is the broadcast echo of one accepted change, delivered to EVERY
 *   socket including the submitter's — a client recognizes its own row by the
 *   `submission` echo and retires the matching pending edit.
 * - `presence` is a full roster snapshot, not a delta. Snapshots make a
 *   hibernation wake self-healing (the room rebuilds its memory-only roster
 *   from the clients' periodic re-broadcasts) and cost nothing at a 32-socket
 *   cap.
 * - `canonicalResult` answers a `canonical` offer; `canonical` is the broadcast
 *   that tells EVERY socket the room's grounding moved, so no peer keeps
 *   pinning its commits to a revision the room has left behind.
 * - `error` reports a request that could not be served at all.
 */
export type CollabServerFrame =
	| { t: "hello"; peerId: number }
	| {
			t: "base";
			id: number;
			generation: number;
			revision: number;
			files: [string, string][];
			/** WHICH canonical revision this content represents. See `CollabCanonicalStamp`. */
			canonical: CollabCanonicalStamp;
	  }
	| {
			t: "canonicalResult";
			id: number;
			outcome: CollabCanonicalOutcome;
			canonical: CollabCanonicalStamp;
	  }
	| { t: "canonical"; canonical: CollabCanonicalStamp }
	| { t: "result"; id: number; result: CodeChangeSubmitResult }
	| { t: "row"; row: CodeChangeRow }
	| { t: "presence"; peers: [number, unknown][] }
	| { t: "error"; id: number | null; message: string };

export function encodeFrame(
	frame: CollabClientFrame | CollabServerFrame,
): string {
	return JSON.stringify(frame);
}

export function contentToFiles(content: CodeContent): [string, string][] {
	return [...content];
}

// =======================================================================================
// Decoders

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function requestId(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0
		? (value as number)
		: null;
}

function parseFiles(value: unknown): [string, string][] | null {
	if (!Array.isArray(value)) return null;
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2) return null;
		if (typeof entry[0] !== "string" || typeof entry[1] !== "string") {
			return null;
		}
	}
	return value as [string, string][];
}

/** A canonical stamp: a revision counter plus an optional immutable revision id. */
function parseCanonicalStamp(value: unknown): CollabCanonicalStamp | null {
	const input = record(value);
	if (!input) return null;
	const revision = requestId(input.revision);
	if (revision === null) return null;
	if (input.revisionId !== null && typeof input.revisionId !== "string") {
		return null;
	}
	return { revision, revisionId: input.revisionId as string | null };
}

/** A stream position a client claims to have committed from. Structure only; the room validates it. */
function parseStreamPosition(value: unknown): StreamPosition | null {
	const input = record(value);
	if (!input) return null;
	const generation = requestId(input.generation);
	const revision = requestId(input.revision);
	return generation === null || revision === null
		? null
		: { generation, revision };
}

/** A stamp plus that revision's content. */
function parseCanonicalOffer(value: unknown): CollabCanonicalOffer | null {
	const stamp = parseCanonicalStamp(value);
	if (!stamp) return null;
	const files = parseFiles((value as Record<string, unknown>).files);
	return files === null ? null : { ...stamp, files };
}

function parseJson(data: string): unknown {
	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
}

/** Decode one client frame. `null` for anything the room should drop. */
export function parseClientFrame(data: string): CollabClientFrame | null {
	const input = record(parseJson(data));
	if (!input) return null;
	if (input.t === "base") {
		const id = requestId(input.id);
		if (id === null) return null;
		if (input.seed === undefined) return { t: "base", id };
		const seed = parseCanonicalOffer(input.seed);
		return seed === null ? null : { t: "base", id, seed };
	}
	if (input.t === "canonical") {
		const id = requestId(input.id);
		const offer = parseCanonicalOffer(input.offer);
		if (id === null || offer === null) return null;
		// `force` is a deliberate user action, so only an explicit `true` is one.
		return input.force === true
			? { t: "canonical", id, offer, force: true }
			: { t: "canonical", id, offer };
	}
	if (input.t === "ground") {
		const id = requestId(input.id);
		const offer = parseCanonicalOffer(input.offer);
		const at = parseStreamPosition(input.at);
		if (id === null || offer === null || at === null) return null;
		return { t: "ground", id, offer, at };
	}
	if (input.t === "submit") {
		const id = requestId(input.id);
		const submission = parseCodeChangeSubmission(input.submission);
		return id === null || submission === null
			? null
			: { t: "submit", id, submission };
	}
	if (input.t === "presence") {
		// The payload itself is deliberately untyped here: `sanitizeCollabPresenceState`
		// in `./presence` owns what a client may publish, and duplicating that
		// allowlist would put the trust boundary in two places.
		return { t: "presence", state: input.state };
	}
	return null;
}

/** Decode one server frame. `null` for anything the client should drop. */
export function parseServerFrame(data: string): CollabServerFrame | null {
	const input = record(parseJson(data));
	if (!input) return null;
	switch (input.t) {
		case "hello": {
			const peerId = requestId(input.peerId);
			return peerId === null ? null : { t: "hello", peerId };
		}
		case "base": {
			const id = requestId(input.id);
			const generation = requestId(input.generation);
			const revision = requestId(input.revision);
			const files = parseFiles(input.files);
			const canonical = parseCanonicalStamp(input.canonical);
			return id === null ||
				generation === null ||
				revision === null ||
				files === null ||
				canonical === null
				? null
				: { t: "base", id, generation, revision, files, canonical };
		}
		case "canonicalResult": {
			const id = requestId(input.id);
			const canonical = parseCanonicalStamp(input.canonical);
			const outcome =
				typeof input.outcome === "string" &&
				CANONICAL_OUTCOMES.has(input.outcome)
					? (input.outcome as CollabCanonicalOutcome)
					: null;
			return id === null || canonical === null || outcome === null
				? null
				: { t: "canonicalResult", id, outcome, canonical };
		}
		case "canonical": {
			const canonical = parseCanonicalStamp(input.canonical);
			return canonical === null ? null : { t: "canonical", canonical };
		}
		case "result": {
			const id = requestId(input.id);
			const result = parseSubmitResult(input.result);
			return id === null || result === null
				? null
				: { t: "result", id, result };
		}
		case "row": {
			const row = parseCodeChangeRow(input.row);
			return row === null ? null : { t: "row", row };
		}
		case "presence": {
			if (!Array.isArray(input.peers)) return null;
			const peers: [number, unknown][] = [];
			for (const entry of input.peers) {
				if (!Array.isArray(entry) || entry.length !== 2) return null;
				const peerId = requestId(entry[0]);
				if (peerId === null) return null;
				peers.push([peerId, entry[1]]);
			}
			return { t: "presence", peers };
		}
		case "error": {
			const id = input.id === null ? null : requestId(input.id);
			return typeof input.message === "string"
				? { t: "error", id, message: input.message }
				: null;
		}
		default:
			return null;
	}
}

const CANONICAL_OUTCOMES: ReadonlySet<string> = new Set<CollabCanonicalOutcome>(
	[
		"adopted",
		"repaired",
		"current",
		"edited",
		"malformed",
		"stream-gone",
		"busy",
	],
);

const REJECTION_CODES = new Set([
	"malformed",
	"sequence",
	"stream-gone",
	"capacity",
	"busy",
]);

function parseSubmitResult(value: unknown): CodeChangeSubmitResult | null {
	const input = record(value);
	if (!input) return null;
	if (input.ok === true) {
		const generation = requestId(input.generation);
		const revision = requestId(input.revision);
		if (generation === null || revision === null) return null;
		return {
			ok: true,
			duplicate: input.duplicate === true,
			generation,
			revision,
		};
	}
	if (input.ok !== false) return null;
	return typeof input.code === "string" &&
		REJECTION_CODES.has(input.code) &&
		typeof input.message === "string"
		? {
				ok: false,
				code: input.code as Exclude<
					CodeChangeSubmitResult,
					{ ok: true }
				>["code"],
				message: input.message,
			}
		: null;
}
