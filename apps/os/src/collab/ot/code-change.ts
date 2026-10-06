/**
 * The operational-transform representation of uncommitted collaborative edits.
 * Adapted and modified from Cloudflare OS under Apache-2.0; see
 * `THIRD_PARTY_NOTICES.md`.
 *
 * A collab room's uncommitted state is a sequence of `CodeChange`s applied on top of the canonical
 * revision the room was seeded from: every producer -- human
 * keystrokes, a tedi's tool edits, adopting a newer canonical revision -- expresses its change
 * against the room content as of some revision, and the room serializes them into one revisioned
 * stream. A change carries no base content, only "a change relative to revision N", which is what
 * lets it compose with revision-backed storage (the base is always some committed revision plus
 * earlier changes).
 *
 * This module is the single owner of the code-change invariants: the wire types, application,
 * composition, transformation, diffing, the ingestion validation, and the priority convention all
 * live here and nowhere else. The text-OT core is `@codemirror/state`'s ChangeSet (the substrate
 * of @codemirror/collab), and change generation uses `fast-diff`; both are private to this module
 * -- not because they might be swapped out, but so the invariants stay in one place. The wire
 * carries our own plain-JSON types (structurally ChangeSet's compact JSON form), keeping the RPC
 * contract self-describing.
 *
 * Priority convention (fixed here, used identically on both sides of the wire): for two changes
 * made concurrently against the same revision, *the change the server ordered earlier comes
 * first* -- its inserts precede the later change's at equal positions. This is exactly ChangeSet's
 * documented transform law: `A.compose(B.map(A))` and `B.compose(A.map(B, true))` produce the same
 * document. `transformCodeChange(a, b)` bakes the pairing in; nothing else may call the underlying
 * `map`.
 *
 * Trust boundary: changes from clients are validated in two stages, and the stages must stay in
 * this order. `validateCodeChangeSchema` runs *before* any transform -- transformation is
 * structural and must only ever see well-formed changes -- while `validateCodeChangeContent` runs
 * *after* transforming the change to the server's current revision, because lengths and boundaries
 * are only meaningful against the content the change will actually apply to.
 *
 * Both stages take a `CodeChange`, and that parameter type is a precondition rather than a hope:
 * the declared shape is established before they run, by the room's frame decoder at the transport
 * edge and by the compiler for in-process producers (whose changes this module itself builds). So
 * neither stage re-checks that a value is an array, a pair, or a string; they check the invariants
 * a TypeScript type cannot express -- path rules, size caps, integer section lengths, and the one
 * variant rule a first-match union misses (see validateFileChangeSchema).
 *
 * Validation's resource-exhaustion goal is deliberately modest: reject anything the caps rule out
 * in at most one linear pass over input the transport layer already parsed (with cheap early exits
 * where they fall out naturally), and no more. Change producers hold edit rights, and a user who
 * can edit the document can do far worse than burn the room's CPU; the isolate memory limit bounds
 * the blast radius. The size caps exist first for correctness -- composed changes get stored and
 * travel in RPC/WebSocket messages, both of which have hard size limits of their own -- not as a
 * DoS defense, so don't grow this file chasing sub-linear rejection of every hostile shape.
 *
 * Tedix scopes a change to exactly one document:
 * `CollabRoom` *is* the document (see `../room.ts`), rooms have independent revision streams, and
 * there is no atomic cross-document commit to represent. So the outer keyed level is dropped and a
 * `CodeChange` is one document's entry list directly. Two consequences worth naming: the outer
 * prototype-shadowing hazards stay out of the wire shape (only paths remain, and
 * they were already list values, never keys), and a change can no longer span documents -- if
 * cross-document atomicity is ever needed, it must be reintroduced as an outer level here rather
 * than by composing two rooms' streams. Multi-file capability *inside* a document is preserved
 * even though today's rooms sync a single file under `COLLAB_DOC_PATH`.
 */

import { ChangeSet, Text } from "@codemirror/state";
import fastDiff from "fast-diff";

// =======================================================================================
// Wire types

/**
 * A text edit: ChangeSet's compact JSON form. A `TextChange` is a sequence of sections covering
 * the *entire* original text -- a bare number retains that many UTF-16 code units, and
 * `[deletedLength, ...insertedLines]` replaces `deletedLength` units with the given lines (joined
 * by "\n"; a one-element array is a pure deletion). Because sections tile the whole text, the
 * change carries its exact before- and after-lengths by construction.
 *
 * Example: `[2, [2, "😀"], 3]` keeps 2 units, replaces the next 2 with "😀", and keeps the final
 * 3 -- valid only against a text of exactly 7 UTF-16 code units.
 */
export type TextChange = (number | [number, ...string[]])[];

/**
 * One file's part of a `CodeChange`. A file's state is a string or absent, and exactly one of the
 * three variants applies:
 * - `{edit}`: transform the existing text (invalid if the file is absent, or if its length doesn't
 *   match the change's before-length);
 * - `{set}`: create the file or wholesale-replace its content -- valid against any state,
 *   including absent;
 * - `{remove}`: delete the file. Valid against any state (deleting an absent file is a no-op),
 *   which keeps `remove` composable and transformable without knowing the base.
 */
export type FileChange =
	| { edit: TextChange }
	| { set: string }
	| { remove: true };

/**
 * One code change against one document: a list of `[path, FileChange]` entries. An empty list is
 * the identity change, and a non-empty list must have no duplicate paths.
 *
 * Plain JSON, treated as immutable everywhere -- functions in this module share subtrees between
 * inputs and outputs rather than copying. Changes produced by this module list entries in sorted
 * path order, but consumers must not require that of received changes (entry order has no meaning;
 * only duplicates are illegal).
 *
 * The entries are deliberately a list rather than a path-keyed object: paths may be any non-empty
 * string, including names that collide with `Object.prototype` members (document content can
 * legitimately contain a file named `__proto__` or `constructor`), and such names must never be
 * object keys on the wire -- Cap'n Web deletes prototype-shadowing keys (and `toJSON`) from every
 * object it deserializes, so a path-keyed map would silently lose those files in RPC transit.
 */
export type CodeChange = [path: string, change: FileChange][];

// =======================================================================================
// Content model

/**
 * One document's file contents: `path -> text`. Functions in this module treat content maps as
 * immutable: `applyCodeChange` returns a new map rather than mutating its input, so callers must
 * never mutate one they passed in.
 */
export type CodeContent = Map<string, string>;

// =======================================================================================
// Size caps

/**
 * Maximum length, in UTF-16 code units, of a single file's text that a change may produce (a
 * `set`'s content or an `edit`'s after-length). Backstop, not a product limit: collaborative
 * documents are source code and structured text, and each revision body must fit in a storage
 * record; 512K code units stays well under that even for incompressible worst-case UTF-8.
 */
export const MAX_FILE_TEXT_LENGTH = 512 * 1024;

/**
 * Maximum length, in UTF-16 code units, of a single file path within a change. Enforced only on
 * submitted changes (`validateCodeChangeSchema`), so pre-existing or imported content with a
 * longer path is not itself invalidated -- it just can't be targeted by a new change until this
 * constant is raised. Far above any real document file path.
 */
export const MAX_FILE_PATH_LENGTH = 1024;

/**
 * Maximum total size of one `CodeChange`, measured as a proxy for its serialized size: each file
 * entry costs a fixed overhead plus its path length plus its payload -- a `set`'s content length,
 * or an `edit`'s weighted section count plus its inserted-text length (`remove` costs nothing
 * beyond the overhead). Counting entries and sections, not just inserted text, bounds storage,
 * socket frames, and transform work even for changes made of many payload-free parts (mass
 * removes). Enforced by `validateCodeChangeSchema`.
 */
export const MAX_CODE_CHANGE_SIZE = 2 * 1024 * 1024;

// The two module-private weights behind MAX_CODE_CHANGE_SIZE (callers only need the cap itself):
// the fixed per-file-entry share, and each edit section's share -- a section serializes to a few
// bytes of digits and brackets even when it inserts nothing, so it must weigh more than nothing
// but needn't be exact.
const FILE_ENTRY_SIZE_OVERHEAD = 16;
const EDIT_SECTION_SIZE_WEIGHT = 4;

// =======================================================================================
// Internal helpers

// Parses a (schema-valid) TextChange into a ChangeSet. fromJSON also throws on malformed input,
// making every consumer of an unvalidated change fail closed.
function toChangeSet(change: TextChange): ChangeSet {
	return ChangeSet.fromJSON(change);
}

// Text round-trips all line-separator exotica losslessly: only "\n" is treated as a line boundary,
// so "\r", "\r\n", U+2028, U+2029, and NUL stay inside their lines.
function applyTextChange(text: string, change: TextChange): string {
	return toChangeSet(change)
		.apply(Text.of(text.split("\n")))
		.toString();
}

// Builds a CodeChange with deterministic entry order (by path). Determinism matters because
// changes are stored and compared.
function makeCodeChange(files: Map<string, FileChange>): CodeChange {
	return [...files.keys()].sort().map((path) => [path, files.get(path)!]);
}

// Pairs up two CodeChanges' file entries: yields (path, a's FileChange | undefined, b's FileChange
// | undefined) over the union of paths.
function* pairedFileChanges(
	a: CodeChange,
	b: CodeChange,
): Generator<[string, FileChange | undefined, FileChange | undefined]> {
	const aFiles = new Map(a);
	const bFiles = new Map(b);
	for (const path of new Set([...aFiles.keys(), ...bFiles.keys()])) {
		yield [path, aFiles.get(path), bFiles.get(path)];
	}
}

// =======================================================================================
// Application

/**
 * Applies `change` to `content`, returning the resulting content. The input is not modified (treat
 * both as immutable). Throws if the change doesn't fit the content (an `edit` of an absent file or
 * of a file whose length doesn't match) -- ingestion paths must have validated the change first,
 * so a throw here indicates a bug.
 */
export function applyCodeChange(
	content: CodeContent,
	change: CodeChange,
): CodeContent {
	const result = new Map(content);
	for (const [path, fileChange] of change) {
		if ("set" in fileChange) {
			result.set(path, fileChange.set);
		} else if ("remove" in fileChange) {
			result.delete(path);
		} else {
			const existing = result.get(path);
			if (existing === undefined) {
				throw new Error(`edit of absent file: ${path}`);
			}
			result.set(path, applyTextChange(existing, fileChange.edit));
		}
	}
	return result;
}

// =======================================================================================
// Composition

/**
 * Composes two sequential changes into one with the same effect: `b` must apply to the content
 * produced by `a`, and `applyCodeChange(c, composeCodeChange(a, b))` equals
 * `applyCodeChange(applyCodeChange(c, a), b)`. Throws on changes that cannot be sequential (an
 * `edit` after a `remove`, or edits whose lengths don't chain) -- like `applyCodeChange`, a throw
 * indicates a bug in the caller, not bad client input.
 *
 * One exception to that throw, verified rather than assumed: a pure-retain edit encodes as an
 * EMPTY ChangeSet, and `@codemirror/state` short-circuits compose/map on an empty operand without
 * checking length. So a wrong-length *identity* edit passes silently here instead of throwing.
 * That is harmless -- an identity edit is a no-op on every replica, so it cannot diverge them --
 * and `validateCodeChangeContent` still rejects it at ingestion, which is the boundary that
 * matters. Do not "fix" this by pre-checking lengths: the throw exists to catch caller bugs, and
 * ingestion is what defends against a peer.
 */
export function composeCodeChange(a: CodeChange, b: CodeChange): CodeChange {
	const files = new Map<string, FileChange>();
	for (const [path, aChange, bChange] of pairedFileChanges(a, b)) {
		files.set(path, composeFileChange(path, aChange, bChange));
	}
	return makeCodeChange(files);
}

function composeFileChange(
	path: string,
	a: FileChange | undefined,
	b: FileChange | undefined,
): FileChange {
	if (a === undefined) return b!;
	if (b === undefined) return a;
	// b is later: its `set` or `remove` wholesale-supersedes whatever a did.
	if ("set" in b || "remove" in b) return b;
	// b is an edit of a's result.
	if ("set" in a) return { set: applyTextChange(a.set, b.edit) };
	if ("remove" in a) {
		throw new Error(`cannot compose edit after remove: ${path}`);
	}
	return { edit: toChangeSet(a.edit).compose(toChangeSet(b.edit)).toJSON() };
}

// =======================================================================================
// Transformation

/**
 * The result of `transformCodeChange(a, b)`: each input change rebased to apply after the other,
 * under the fixed priority pairing. `a` is the original `a` transformed to apply after the
 * original `b`; `b` is the original `b` transformed to apply after the original `a`. Applying
 * either pairing to the same base -- original `a` then this `b`, or original `b` then this `a` --
 * produces identical content.
 */
export interface TransformedCodeChanges {
	/** The earlier change, rebased to apply after the original `b`. Retains its priority. */
	a: CodeChange;

	/** The later change, rebased to apply after the original `a`. */
	b: CodeChange;
}

/**
 * Transforms two concurrent changes (both made against the same content) across each other. `a` is
 * the side the server ordered *earlier*, which fixes the priority convention: at equal positions,
 * `a`'s inserts precede `b`'s.
 *
 * Both sides of the wire use this one function. The room rebases an incoming change over the
 * changes already accepted since the change's claimed revision (each accepted change is `a`, the
 * incoming change is `b`); a client holding unacknowledged local edits rebases them over each
 * incoming broadcast change (the broadcast change is `a` -- the server accepted it first -- and
 * the client updates its display with the transformed `a` while keeping the transformed `b` as its
 * new pending change).
 *
 * Per-path rules (`set` and `remove` behave alike, so these also cover delete-vs-edit and
 * create-vs-create):
 * - edit vs edit: delegated to the text OT core under the documented pairing;
 * - `set`/`remove` vs an opposing `edit`: the `set`/`remove` survives unchanged and the `edit` is
 *   dropped, regardless of order -- its base was wholesale-replaced, so there is nothing
 *   meaningful to rebase it onto;
 * - `set`/`remove` vs `set`/`remove`: last-writer-wins by server order -- `b` survives, `a` is
 *   dropped from the rebased result (it must not clobber `b` when applied after it).
 */
export function transformCodeChange(
	a: CodeChange,
	b: CodeChange,
): TransformedCodeChanges {
	const aFiles = new Map<string, FileChange>();
	const bFiles = new Map<string, FileChange>();
	for (const [path, aChange, bChange] of pairedFileChanges(a, b)) {
		if (aChange === undefined) {
			bFiles.set(path, bChange!);
		} else if (bChange === undefined) {
			aFiles.set(path, aChange);
		} else if ("edit" in aChange && "edit" in bChange) {
			const aSet = toChangeSet(aChange.edit);
			const bSet = toChangeSet(bChange.edit);
			aFiles.set(path, { edit: aSet.map(bSet, true).toJSON() });
			bFiles.set(path, { edit: bSet.map(aSet).toJSON() });
		} else if ("edit" in aChange) {
			// b's set/remove supersedes a's edit.
			bFiles.set(path, bChange);
		} else if ("edit" in bChange) {
			// a's set/remove wholesale-replaced b's base; b's edit is dropped.
			aFiles.set(path, aChange);
		} else {
			// Both set/remove: last-writer-wins by server order.
			bFiles.set(path, bChange);
		}
	}
	return { a: makeCodeChange(aFiles), b: makeCodeChange(bFiles) };
}

// =======================================================================================
// Diffing

/**
 * Computes the change that turns `before` into `after`:
 * `applyCodeChange(before, diffFiles(before, after))` equals `after`. Unchanged files contribute
 * nothing; added files become `set`, removed files `remove`, and changed files a minimal
 * character-level `edit` whose boundaries never split a UTF-16 surrogate pair. The result is
 * deterministic (same inputs, same change, same entry order).
 */
export function diffFiles(before: CodeContent, after: CodeContent): CodeChange {
	const files = new Map<string, FileChange>();
	for (const path of new Set([...before.keys(), ...after.keys()])) {
		const beforeText = before.get(path);
		const afterText = after.get(path);
		if (beforeText === afterText) continue;
		if (afterText === undefined) {
			files.set(path, { remove: true });
		} else if (beforeText === undefined) {
			files.set(path, { set: afterText });
		} else {
			files.set(path, { edit: diffTextChange(beforeText, afterText) });
		}
	}
	return makeCodeChange(files);
}

// Folds fast-diff's edit script ([kind, text] runs over the whole strings) into ChangeSet change
// specs in original coordinates, merging each adjacent delete/insert run into a single
// replacement. fast-diff never splits surrogate pairs (verified by fuzz tests), so the resulting
// boundaries always pass validateCodeChangeContent.
function diffTextChange(before: string, after: string): TextChange {
	const specs: { from: number; to: number; insert?: string }[] = [];
	const diffs = fastDiff(before, after);
	let pos = 0;
	for (let i = 0; i < diffs.length; i++) {
		const [kind, text] = diffs[i]!;
		if (kind === fastDiff.EQUAL) {
			pos += text.length;
			continue;
		}
		// Pair a delete with an immediately following insert (or vice versa) as one replacement.
		let deleted = kind === fastDiff.DELETE ? text : "";
		let inserted = kind === fastDiff.INSERT ? text : "";
		const next = diffs[i + 1];
		if (next !== undefined && next[0] !== fastDiff.EQUAL && next[0] !== kind) {
			if (next[0] === fastDiff.DELETE) deleted = next[1];
			else inserted = next[1];
			i++;
		}
		specs.push({ from: pos, to: pos + deleted.length, insert: inserted });
		pos += deleted.length;
	}
	// The explicit "\n" line separator matters: ChangeSet.of's default splits inserted strings on
	// /\r\n?|\n/ and Text rejoins lines with "\n", which would corrupt content containing bare
	// "\r" -- and the room stores text exactly, so a normalized separator desynchronizes every
	// replica's offsets from the stored bytes.
	return ChangeSet.of(specs, before.length, "\n").toJSON();
}

// =======================================================================================
// Inspection

/** The file paths a change touches, in sorted order. Empty for the identity change. */
export function changedPaths(change: CodeChange): string[] {
	return change.map(([path]) => path).sort();
}

// =======================================================================================
// Validation (the trust boundary)

/**
 * Stage 1 of ingestion validation: the invariants a `CodeChange`'s type cannot express, checked
 * *before* any transform (transformation must only ever see schema-valid changes). The declared
 * shape is a precondition -- see the trust boundary note at the top of this module -- so this
 * verifies non-empty, duplicate-free paths; exactly one variant per `FileChange`; that every
 * `edit` parses as a ChangeSet whose sections are non-negative integers that each retain, delete,
 * or insert something (do-nothing padding is rejected) and whose inserted line strings contain no
 * "\n"; and the size caps: `MAX_FILE_TEXT_LENGTH` per produced file, `MAX_FILE_PATH_LENGTH` per
 * path, and `MAX_CODE_CHANGE_SIZE` for the change overall. Throws on the first violation.
 * Content-dependent checks (lengths, boundaries) are stage 2: `validateCodeChangeContent`.
 */
export function validateCodeChangeSchema(change: CodeChange): void {
	// The size cap is enforced as a running budget, not an after-the-fact sum: an edit's section
	// count is pre-checked in O(1) and the budget re-checked as each section's cost accrues, so a
	// hostile change is rejected before its sections are walked -- and in particular before
	// `ChangeSet.fromJSON` materializes a second copy of an oversized edit.
	let remaining = MAX_CODE_CHANGE_SIZE;
	const seen = new Set<string>();
	for (const [path, fileChange] of change) {
		if (path === "") throw new Error("code change file path is empty");
		if (path.length > MAX_FILE_PATH_LENGTH) {
			throw new Error("code change file path is too long");
		}
		if (seen.has(path)) {
			throw new Error(`code change has a duplicate file entry: ${path}`);
		}
		seen.add(path);
		remaining -= FILE_ENTRY_SIZE_OVERHEAD + path.length;
		if (remaining < 0) throw new Error("code change is too large");
		remaining -= validateFileChangeSchema(path, fileChange, remaining);
	}
}

// Validates one FileChange's schema, returning its payload's share of the change size (see
// MAX_CODE_CHANGE_SIZE; always <= budget). Throws "code change is too large" as soon as the
// running cost exceeds `budget`, so an oversized payload is rejected without being fully walked.
function validateFileChangeSchema(
	where: string,
	fileChange: FileChange,
	budget: number,
): number {
	// Exactly one variant. This one is not the transport decoder's to make: a first-match union
	// that tolerates extra properties lets `{set, remove}` reach us. It must not survive --
	// `applyCodeChange` tests `set` before `edit` while `transformCodeChange` tests `edit` first,
	// so a two-variant FileChange would be read differently by two replicas and diverge them.
	const keys = Object.keys(fileChange);
	if (keys.length !== 1 || !["edit", "set", "remove"].includes(keys[0]!)) {
		throw new Error(
			`file change must have exactly one of edit/set/remove: ${where}`,
		);
	}
	if ("set" in fileChange) {
		if (fileChange.set.length > MAX_FILE_TEXT_LENGTH) {
			throw new Error(`file is too large: ${where}`);
		}
		if (fileChange.set.length > budget) {
			throw new Error("code change is too large");
		}
		return fileChange.set.length;
	}
	if ("remove" in fileChange) return 0;
	// ChangeSet.fromJSON is not strict enough on its own -- it accepts negative and non-integer
	// section lengths, sections that neither retain, delete, nor insert (free padding that would
	// evade the size caps), and inserted "line" strings containing "\n" (which desynchronize the
	// resulting document's line metadata from its text) -- so check sections ourselves first;
	// fromJSON then rejects the remaining malformed shapes, on input the budget has bounded.
	// O(1) budget pre-check on the section count alone, before any section is even looked at.
	let cost = fileChange.edit.length * EDIT_SECTION_SIZE_WEIGHT;
	if (cost > budget) throw new Error("code change is too large");
	for (const section of fileChange.edit) {
		if (Array.isArray(section)) {
			const deleted = section[0];
			if (!Number.isSafeInteger(deleted) || deleted < 0) {
				throw new Error(
					`file change edit has an invalid section length: ${where}`,
				);
			}
			// The inserted text's length: the lines' lengths plus the "\n" joining them. The
			// separator count is known before the lines are walked, so a section padded with empty
			// lines is rejected here in O(1) rather than after the walk.
			let insertedHere = section.length >= 2 ? section.length - 2 : 0;
			if (cost + insertedHere > budget) {
				throw new Error("code change is too large");
			}
			for (let i = 1; i < section.length; i++) {
				// A numeric index into `[number, ...string[]]` types as `string | number` because it
				// spans every element; every element past the first is a line.
				const line = section[i] as string;
				if (line.includes("\n")) {
					throw new Error(
						`file change edit inserted line contains a newline: ${where}`,
					);
				}
				insertedHere += line.length;
			}
			if (deleted === 0 && insertedHere === 0) {
				throw new Error(`file change edit has a do-nothing section: ${where}`);
			}
			cost += insertedHere;
			if (cost > budget) throw new Error("code change is too large");
		} else {
			if (!Number.isSafeInteger(section) || section < 0) {
				throw new Error(
					`file change edit has an invalid section length: ${where}`,
				);
			}
			if (section === 0) {
				throw new Error(`file change edit has a do-nothing section: ${where}`);
			}
		}
	}
	let changes: ChangeSet;
	try {
		changes = toChangeSet(fileChange.edit);
	} catch (error) {
		throw new Error(`file change edit is malformed: ${where}: ${error}`, {
			cause: error,
		});
	}
	if (changes.newLength > MAX_FILE_TEXT_LENGTH) {
		throw new Error(`file is too large: ${where}`);
	}
	return cost;
}

/**
 * Stage 2 of ingestion validation: the change against the content it will actually apply to,
 * checked *after* transforming it to the server's current revision (and only on schema-valid
 * changes -- run `validateCodeChangeSchema` first). Verifies each `edit` targets an existing file
 * of exactly the change's before-length, that every change boundary lands on a code-point boundary
 * of that file, and that no inserted or `set` text contains a lone UTF-16 surrogate. The surrogate
 * rules are what keep replicas byte-identical: changes travel as UTF-8 (where a lone surrogate
 * decodes as U+FFFD), so a mid-pair boundary or a lone surrogate would make remote replicas
 * disagree with the sender. Throws on the first violation.
 */
export function validateCodeChangeContent(
	change: CodeChange,
	content: CodeContent,
): void {
	for (const [path, fileChange] of change) {
		if ("set" in fileChange) {
			if (hasLoneSurrogate(fileChange.set)) {
				throw new Error(`file change set contains a lone surrogate: ${path}`);
			}
		} else if ("edit" in fileChange) {
			const text = content.get(path);
			if (text === undefined) throw new Error(`edit of absent file: ${path}`);
			const changes = toChangeSet(fileChange.edit);
			if (changes.length !== text.length) {
				throw new Error(
					`file change edit length mismatch: ${path}: ` +
						`change expects ${changes.length}, file has ${text.length}`,
				);
			}
			changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
				if (
					!isCodePointBoundary(text, fromA) ||
					!isCodePointBoundary(text, toA)
				) {
					throw new Error(`file change edit splits a surrogate pair: ${path}`);
				}
				if (hasLoneSurrogate(inserted.toString())) {
					throw new Error(`file change edit inserts a lone surrogate: ${path}`);
				}
			});
		}
		// `remove` needs no content checks: it is valid against any state.
	}
}

// Whether position `pos` in `text` is a code-point boundary, i.e. does not fall between the halves
// of a surrogate pair.
function isCodePointBoundary(text: string, pos: number): boolean {
	if (pos <= 0 || pos >= text.length) return true;
	return !(
		isHighSurrogate(text.charCodeAt(pos - 1)) &&
		isLowSurrogate(text.charCodeAt(pos))
	);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code < 0xdc00;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code < 0xe000;
}

// Whether `text` contains an unpaired UTF-16 surrogate half.
function hasLoneSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (isHighSurrogate(code)) {
			if (i + 1 >= text.length || !isLowSurrogate(text.charCodeAt(i + 1))) {
				return true;
			}
			i++; // Skip the low half of a well-formed pair.
		} else if (isLowSurrogate(code)) {
			return true;
		}
	}
	return false;
}
