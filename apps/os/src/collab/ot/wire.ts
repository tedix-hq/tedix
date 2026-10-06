/**
 * The OT protocol's wire types and their structural decoders.
 *
 * Two messages cross the wire: a client's `CodeChangeSubmission` (an edit expressed against the
 * revision the client last saw) and the server's `CodeChangeRow` echo (one accepted, server-ordered
 * change). Both are plain JSON, so they travel unchanged over the room's WebSocket, over Cap'n Web,
 * or through DO storage — rows are persisted in exactly the shape they are broadcast in.
 *
 * This module owns the *structural* half of the trust boundary and nothing else. `./code-change`'s
 * header states its precondition explicitly: `validateCodeChangeSchema` and
 * `validateCodeChangeContent` take a value whose declared TypeScript shape is already established,
 * "by the room's frame decoder at the transport edge". These decoders are that frame decoder. They
 * establish shape — arrays are arrays, strings are strings, numbers are safe integers — and check
 * nothing else; every semantic invariant (path rules, size caps, section legality, the one-variant
 * rule) belongs to the validators, and duplicating one here would put a rule in two places.
 *
 * One decoding rule is load-bearing and must not be "simplified": `parseFileChange` returns the
 * INPUT OBJECT, not a rebuilt one, and it does not stop at the first matching variant. A decoder
 * that rebuilt `{edit}` from an object carrying `{edit, remove}` would launder a two-variant
 * FileChange into a one-variant one and hide it from `validateCodeChangeSchema`, which is the only
 * thing that rejects it — and which must reject it, because `applyCodeChange` and
 * `transformCodeChange` read a two-variant change differently and would diverge two replicas.
 *
 * Conventions follow `../presence.ts`: a `parse*` function returns `null` on any malformed input
 * and never throws, so a bad frame is dropped rather than killing the room. That is a guarantee
 * about EVERY value a caller can pass, not only about well-formed JSON — `./authority`'s `submit`
 * is reachable from in-process producers too — so each exported `parse*` enforces it structurally
 * (`neverThrows`) rather than by inspection of every property read.
 */

import type { CodeChange, FileChange, TextChange } from "./code-change";
import {
	type CollabVerifiedIdentity,
	parseCollabVerifiedIdentity,
} from "../presence";

// =======================================================================================
// Wire types

/**
 * The shape a submission's `clientId` must take. Deliberately strict: the token is client-minted
 * (a UUID satisfies it), becomes part of a DO storage key, and needs no other structure.
 */
export const CODE_CHANGE_CLIENT_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * One client's submission of one change.
 *
 * `generation` + `revision` name the stream position the change was made against; the server
 * transforms it over everything accepted since. `clientId` + `seq` identify the submission itself:
 * `clientId` is one client editing session, `seq` counts that session's submissions from 1, and the
 * pair is what makes a retry recognizable (see `./authority`). `seq` is not a stream position and
 * has nothing to do with `revision`.
 *
 * Note `clientId` is NOT an authorization claim. It rides the public broadcast echo, so any
 * collaborator can see (and forge) another's — dedupe is scoped to the authenticated user, and the
 * server takes that identity from the transport, never from this envelope.
 */
export interface CodeChangeSubmission {
	/** The change stream generation the change was made against. Single-generation today: always 0. */
	generation: number;

	/** The revision within `generation` the change was made against; 0 is the seeded base. */
	revision: number;

	/** The client editing session's token; matches `CODE_CHANGE_CLIENT_ID_PATTERN`. */
	clientId: string;

	/** 1-based counter of this session's submissions. Contiguous; see the seq rule in `./authority`. */
	seq: number;

	change: CodeChange;
}

/**
 * One accepted row of the room's change stream: the server-ordered, already-transformed change,
 * numbered by the per-generation revision counter. This is both the persisted record and the
 * broadcast payload — a subscriber that has applied rows through revision N applies each later row
 * in order to stay in sync, and a reconnecting client asks for the rows after the last revision it
 * applied.
 *
 * `author` is the server's verified identity for the submitter (see `../presence`), never anything
 * the client asserted. `submission` echoes the accepted `(clientId, seq)` so the submitting client
 * can recognize its own change arriving back and retire the matching pending edit; it is absent for
 * server-authored rows.
 */
export interface CodeChangeRow {
	generation: number;

	/** 1-based within `generation`; rows are contiguous by construction. */
	revision: number;

	/** Wall-clock time the row was accepted, from the authority's injected clock. */
	timestampMs: number;

	author: CollabVerifiedIdentity;

	change: CodeChange;

	/** The submission echo for client rows; absent for server-authored ones. */
	submission?: { clientId: string; seq: number };
}

/** A stream position: what a subscriber has applied, or where a submission landed. */
export interface StreamPosition {
	generation: number;
	revision: number;
}

// =======================================================================================
// Structural decoders

/**
 * The module's never-throws contract, made structural instead of assumed.
 *
 * The decoders are written not to throw — in particular `parseFileChange` refuses an accessor
 * variant key instead of invoking it — but they walk an arbitrary caller-supplied value, and a
 * value can be hostile in ways structure alone cannot anticipate (a throwing `Symbol.iterator`, a
 * `Proxy` trap). The contract this module states, and that its callers rely on — a bad frame is
 * dropped, never propagated as an exception that would tear down the room — is therefore enforced
 * at each exported entry point rather than left to the reader's audit of every property read.
 * This is a boundary, not a habit: nothing inside the module may rely on it to skip a check.
 */
function neverThrows<T>(decode: () => T | null): T | null {
	try {
		return decode();
	} catch {
		return null;
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function counter(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

// A TextChange's sections: a bare number, or `[deletedLength, ...insertedLines]`. Section values
// are only checked for *type* here (`validateCodeChangeSchema` owns integrality, sign, do-nothing
// padding, and embedded newlines) -- but a non-number/non-array section is not a TextChange at all.
function parseTextChange(value: unknown): TextChange | null {
	if (!Array.isArray(value)) return null;
	for (const section of value) {
		if (typeof section === "number") continue;
		if (!Array.isArray(section) || section.length === 0) return null;
		if (typeof section[0] !== "number") return null;
		for (let index = 1; index < section.length; index += 1) {
			if (typeof section[index] !== "string") return null;
		}
	}
	return value as TextChange;
}

const VARIANT_KEYS = ["edit", "set", "remove"] as const;

/**
 * The variant keys `input` carries as plain own DATA properties — or `null` when the object cannot
 * be described that way at all, in which case it is not a FileChange this module will hand on.
 *
 * KEY MODEL. `validateCodeChangeSchema` counts variants with `Object.keys` (own-only) while
 * `applyCodeChange` and `transformCodeChange` DISPATCH with `in` (prototype-aware). The decoder
 * must therefore agree with the own-key model *and* refuse anything on which the two models
 * disagree: an object with an own `set` and an inherited `edit` satisfies the one-variant rule
 * under `Object.keys`, and is then read as a `set` by `applyCodeChange` and as an `edit` by
 * `transformCodeChange` — precisely the two-replica divergence that rule exists to prevent. A
 * prototype-carried variant key is refused here rather than counted, because "count it" would make
 * the decoder disagree with the validator in the other direction.
 *
 * ACCESSORS. A variant key that is a getter is refused without ever being read. Reading it can
 * throw (this module promises never to) and, worse, can return a different value on each read — so
 * `validateCodeChangeSchema` would be validating something other than what `applyCodeChange`
 * applies. Only a data property can be validated once and applied later.
 *
 * `JSON.parse` produces neither shape, so neither is reachable over the wire; `submit` is also
 * reachable from in-process producers (see `./authority`), whose values the compiler typed but
 * never inspected.
 */
function ownVariantKeys(input: Record<string, unknown>): Set<string> | null {
	const own = new Set<string>();
	for (const key of VARIANT_KEYS) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor === undefined) {
			if (key in input) return null; // inherited: the two key models disagree
			continue;
		}
		if (!Object.hasOwn(descriptor, "value")) return null; // accessor
		own.add(key);
	}
	return own;
}

// Decodes one FileChange, returning the INPUT object so that extra or conflicting variant keys
// survive to validateCodeChangeSchema. See the module header: rebuilding here would hide a
// two-variant change from the only check that rejects it.
function parseFileChange(value: unknown): FileChange | null {
	const input = record(value);
	if (!input) return null;
	const variants = ownVariantKeys(input);
	if (variants === null) return null;
	if (variants.has("edit") && parseTextChange(input.edit) === null) return null;
	if (variants.has("set") && typeof input.set !== "string") return null;
	if (variants.has("remove") && input.remove !== true) return null;
	// Zero variants is not a FileChange under any reading. Two or more IS structurally a
	// FileChange (each key is well-typed); it is semantically illegal, and rejecting it is
	// validateCodeChangeSchema's job, so it passes through here intact.
	return variants.size === 0 ? null : (input as FileChange);
}

function decodeCodeChange(value: unknown): CodeChange | null {
	if (!Array.isArray(value)) return null;
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2) return null;
		if (typeof entry[0] !== "string") return null;
		if (parseFileChange(entry[1]) === null) return null;
	}
	return value as CodeChange;
}

/** Decodes a client submission envelope. Returns `null` on any malformed frame. */
export function parseCodeChangeSubmission(
	value: unknown,
): CodeChangeSubmission | null {
	return neverThrows(() => decodeCodeChangeSubmission(value));
}

function decodeCodeChangeSubmission(
	value: unknown,
): CodeChangeSubmission | null {
	const input = record(value);
	if (!input) return null;
	const change = decodeCodeChange(input.change);
	if (
		change === null ||
		!counter(input.generation) ||
		!counter(input.revision) ||
		typeof input.clientId !== "string" ||
		!CODE_CHANGE_CLIENT_ID_PATTERN.test(input.clientId) ||
		!Number.isSafeInteger(input.seq) ||
		(input.seq as number) < 1
	) {
		return null;
	}
	return {
		generation: input.generation,
		revision: input.revision,
		clientId: input.clientId,
		seq: input.seq as number,
		change,
	};
}

/**
 * Decodes a broadcast/persisted row. Used on the client for received rows and by the authority when
 * rehydrating rows from DO storage after a hibernation wake — a row that fails to decode is a
 * corrupt record, which the authority treats as a stream gap rather than mistransforming across it.
 */
export function parseCodeChangeRow(value: unknown): CodeChangeRow | null {
	return neverThrows(() => decodeCodeChangeRow(value));
}

function decodeCodeChangeRow(value: unknown): CodeChangeRow | null {
	const input = record(value);
	if (!input) return null;
	const change = decodeCodeChange(input.change);
	// Identity decoding is presence's, not this module's.
	const author = parseCollabVerifiedIdentity(input.author);
	if (
		change === null ||
		author === null ||
		!counter(input.generation) ||
		!Number.isSafeInteger(input.revision) ||
		(input.revision as number) < 1 ||
		!Number.isSafeInteger(input.timestampMs) ||
		(input.timestampMs as number) < 0
	) {
		return null;
	}
	const submission = parseSubmissionEcho(input.submission);
	if (submission === undefined && input.submission !== undefined) return null;
	return {
		generation: input.generation,
		revision: input.revision as number,
		timestampMs: input.timestampMs as number,
		author,
		change,
		...(submission !== undefined ? { submission } : {}),
	};
}

function parseSubmissionEcho(
	value: unknown,
): { clientId: string; seq: number } | undefined {
	const input = record(value);
	if (!input) return undefined;
	if (
		typeof input.clientId !== "string" ||
		!CODE_CHANGE_CLIENT_ID_PATTERN.test(input.clientId) ||
		!Number.isSafeInteger(input.seq) ||
		(input.seq as number) < 1
	) {
		return undefined;
	}
	return { clientId: input.clientId, seq: input.seq as number };
}

// =======================================================================================
// Subscriber-side row selection

/**
 * The rows a subscriber at `applied` still has to apply, given rows it just received.
 *
 * Reconnect replay and live broadcast deliver the same rows: a client that reconnects asks for
 * everything after the last revision it applied, and a row already applied can arrive again (an
 * in-flight broadcast racing the replay). OT does not tolerate double application, so the
 * subscriber deduplicates by `(generation, revision)` — the row's own identity, which is stable
 * regardless of how it was delivered.
 *
 * Returns `null` when the rows cannot be applied at all: a different generation (this stream is
 * gone; rebuild from a fresh seed), or a gap between `applied` and the first new row (a row was
 * missed, and applying the rest would mistransform every later position).
 */
export function selectUnappliedRows(
	applied: StreamPosition,
	rows: readonly CodeChangeRow[],
): CodeChangeRow[] | null {
	const pending: CodeChangeRow[] = [];
	let expected = applied.revision + 1;
	for (const row of rows) {
		if (row.generation !== applied.generation) return null;
		if (row.revision < expected) continue; // already applied; deduplicated
		if (row.revision !== expected) return null; // gap: refuse rather than mistransform
		pending.push(row);
		expected += 1;
	}
	return pending;
}
