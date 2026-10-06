/**
 * Live collaboration presence: who is in a room, where they are, and what they
 * have selected.
 *
 * Presence is CLIENT-AUTHORED LIVE STATE, never authorization. The Worker
 * verifies a principal once per socket and hands the room an opaque projection
 * (`CollabVerifiedIdentity`); the room overwrites `user` with it and allowlists
 * the only two client-authored fields that may be broadcast. That allowlist is
 * the trust boundary — email, raw principal IDs, tokens, and arbitrary
 * extension fields never reach a peer.
 *
 * POSITIONS ARE PLAIN OFFSETS, mapped through the change stream. A position is
 * a UTF-16 offset into one file, and it
 * stays correct the way every other position in this stack does: each replica
 * maps its stored peer positions across each `CodeChange` as it is applied
 * (`mapSelectionThroughChange`). No shared history is required, only the
 * ordered change stream every replica already receives.
 */
import type { CodeChange, TextChange } from "./ot/code-change";

export const COLLAB_PRESENCE_HEADER = "X-Tedix-Collab-Presence";

export type CollabParticipantKind = "external_agent" | "human" | "tedi";
export type CollabParticipantRole =
	| "admin"
	| "member"
	| "operator"
	| "owner"
	| "viewer";

export interface CollabVerifiedIdentity {
	/** Opaque, tenant-bound key. Raw user, tedi, and Agent-Session IDs never leave the Worker. */
	key: string;
	displayName: string;
	kind: CollabParticipantKind;
	role: CollabParticipantRole;
	verified: true;
}

export interface CollabLocation {
	surface: "canvas";
	artifactKind?: "gadget" | "output";
	artifactLabel?: string;
	selectionLabel?: string;
}

/**
 * One peer's selection, as UTF-16 offsets into one file of the document.
 *
 * `anchor` is where the selection started and `head` is where the caret is, so
 * a collapsed caret has `anchor === head` and a backwards selection has
 * `head < anchor`. Both are offsets into the CURRENT text of `path` as the
 * publishing replica saw it; a receiving replica maps them forward through
 * every change it applies afterwards.
 */
export interface CollabSelection {
	path: string;
	anchor: number;
	head: number;
}

export interface CollabParticipant extends CollabVerifiedIdentity {
	clientIds: number[];
	location: CollabLocation | null;
	selection: CollabSelection | null;
	sessions: number;
}

const KINDS = new Set<CollabParticipantKind>([
	"external_agent",
	"human",
	"tedi",
]);
const ROLES = new Set<CollabParticipantRole>([
	"admin",
	"member",
	"operator",
	"owner",
	"viewer",
]);

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function shortString(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized !== "" && normalized.length <= max ? normalized : null;
}

export function parseCollabVerifiedIdentity(
	value: unknown,
): CollabVerifiedIdentity | null {
	const input = record(value);
	if (!input || input.verified !== true) return null;
	const key = shortString(input.key, 80);
	const displayName = shortString(input.displayName, 100);
	const kind = input.kind;
	const role = input.role;
	if (
		!key ||
		!displayName ||
		typeof kind !== "string" ||
		!KINDS.has(kind as CollabParticipantKind) ||
		typeof role !== "string" ||
		!ROLES.has(role as CollabParticipantRole)
	) {
		return null;
	}
	return {
		key,
		displayName,
		kind: kind as CollabParticipantKind,
		role: role as CollabParticipantRole,
		verified: true,
	};
}

export function parseCollabPresenceHeader(
	value: string | null,
): CollabVerifiedIdentity | null {
	if (!value || value.length > 1_000) return null;
	try {
		return parseCollabVerifiedIdentity(JSON.parse(value));
	} catch {
		return null;
	}
}

function sanitizeLocation(value: unknown): CollabLocation | null {
	const input = record(value);
	if (!input || input.surface !== "canvas") return null;
	const artifactKind =
		input.artifactKind === "gadget" || input.artifactKind === "output"
			? input.artifactKind
			: undefined;
	const artifactLabel = shortString(input.artifactLabel, 120) ?? undefined;
	const selectionLabel = shortString(input.selectionLabel, 120) ?? undefined;
	return {
		surface: "canvas",
		...(artifactKind ? { artifactKind } : {}),
		...(artifactLabel ? { artifactLabel } : {}),
		...(selectionLabel ? { selectionLabel } : {}),
	};
}

/** Far above any real document path; mirrors `MAX_FILE_PATH_LENGTH` in `./ot/code-change`. */
const MAX_SELECTION_PATH_LENGTH = 1024;

function offset(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0
		? (value as number)
		: null;
}

function sanitizeSelection(value: unknown): CollabSelection | null {
	const input = record(value);
	if (!input) return null;
	const path = shortString(input.path, MAX_SELECTION_PATH_LENGTH);
	const anchor = offset(input.anchor);
	const head = offset(input.head);
	return path !== null && anchor !== null && head !== null
		? { path, anchor, head }
		: null;
}

/**
 * Project one client-authored presence payload onto the only shape a peer may
 * see: the Worker-verified `user`, plus the two allowlisted client fields.
 *
 * THIS IS THE TRUST BOUNDARY, and it did not move at the OT cutover. The room
 * calls it on every presence frame before the frame reaches another socket, so
 * anything not named here is dropped rather than broadcast.
 */
export function sanitizeCollabPresenceState(
	value: unknown,
	identity: CollabVerifiedIdentity,
): Record<string, unknown> {
	const input = record(value) ?? {};
	const location = sanitizeLocation(input.location);
	const selection = sanitizeSelection(input.selection);
	return {
		user: identity,
		...(location ? { location } : {}),
		...(selection ? { selection } : {}),
	};
}

/**
 * Map one stored selection across a change that has just been applied.
 *
 * Returns `null` when the selection cannot survive the change: the file was
 * replaced wholesale (`set`) or deleted (`remove`), so no offset in the old
 * text names a position in the new one. A caller drops that peer's caret rather
 * than rendering it somewhere arbitrary.
 */
export function mapSelectionThroughChange(
	selection: CollabSelection,
	change: CodeChange,
): CollabSelection | null {
	for (const [path, fileChange] of change) {
		if (path !== selection.path) continue;
		if (!("edit" in fileChange)) return null;
		return {
			path,
			anchor: mapOffsetThroughTextChange(fileChange.edit, selection.anchor),
			head: mapOffsetThroughTextChange(fileChange.edit, selection.head),
		};
	}
	return selection;
}

/**
 * Map one UTF-16 offset across a `TextChange`.
 *
 * A `TextChange`'s sections tile the whole original text (see `./ot/code-change`),
 * so one left-to-right walk carries an offset from the before-text to the
 * after-text. An offset inside a replaced span is clamped into the replacement
 * rather than pushed past it, which keeps a caret where the user was typing
 * instead of jumping it to the end of a peer's paste.
 */
export function mapOffsetThroughTextChange(
	change: TextChange,
	position: number,
): number {
	let oldOffset = 0;
	let newOffset = 0;
	for (const section of change) {
		if (typeof section === "number") {
			if (position <= oldOffset + section) {
				return newOffset + (position - oldOffset);
			}
			oldOffset += section;
			newOffset += section;
			continue;
		}
		const [deleted, ...inserted] = section;
		const insertedLength =
			inserted.length === 0 ? 0 : inserted.join("\n").length;
		if (position <= oldOffset + deleted) {
			return newOffset + Math.min(position - oldOffset, insertedLength);
		}
		oldOffset += deleted;
		newOffset += insertedLength;
	}
	// Past the end of the text the change described: clamp to the new end.
	return newOffset;
}

/** Collapse several tabs/processes for one verified principal into one roster row. */
export function collabParticipantsFromStates(
	states: ReadonlyMap<number, unknown>,
	localClientId?: number,
): CollabParticipant[] {
	const participants = new Map<string, CollabParticipant>();
	for (const [clientId, rawState] of states) {
		if (clientId === localClientId) continue;
		const state = record(rawState);
		const identity = parseCollabVerifiedIdentity(state?.user);
		if (!identity) continue;
		const location = sanitizeLocation(state?.location);
		const selection = sanitizeSelection(state?.selection);
		const current = participants.get(identity.key);
		if (current) {
			current.sessions += 1;
			current.clientIds.push(clientId);
			if (location) current.location = location;
			if (selection) current.selection = selection;
		} else {
			participants.set(identity.key, {
				...identity,
				clientIds: [clientId],
				location,
				selection,
				sessions: 1,
			});
		}
	}
	return [...participants.values()].sort((left, right) =>
		left.displayName.localeCompare(right.displayName),
	);
}
