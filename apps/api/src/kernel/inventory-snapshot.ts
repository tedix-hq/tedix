/**
 * Per-conversation snapshot of Home's tedi/app/workflow inventory.
 *
 * The inventory sits in the stable prompt prefix, ahead of the conversation
 * history. Rebuilding it every turn means one changed status or track-record
 * figure invalidates the provider's prefix cache from that byte onward,
 * history included. Instead the first turn freezes the rendered text, later
 * turns render it byte-identically, and differences from the live inventory
 * go into a short note after the history. The live context still decides
 * which targets are valid; the note only tells the model what moved.
 *
 * Pure module: stored per conversation in KernelDO storage.
 */

/** Bumped when the snapshot shape or inventory rendering changes. */
export const INVENTORY_SNAPSHOT_VERSION = 1;

export function inventorySnapshotStorageKey(conversationId: string): string {
	return `inventory-snapshot:${conversationId}`;
}

/**
 * Once the change note grows past this many chars, the snapshot is retaken:
 * one prefix miss is cheaper than carrying a long note on every turn.
 */
export const INVENTORY_CHANGE_NOTE_MAX_CHARS = 2_000;

export interface HomeInventorySnapshot {
	version: number;
	/** SHA-256 hex of {@link text}. */
	hash: string;
	text: string;
	takenAt: string;
}

export interface ResolvedInventorySnapshot {
	snapshot: HomeInventorySnapshot;
	/** Note to render after the history; null when the snapshot is current. */
	changeNote: string | null;
	/** True when {@link snapshot} was taken this turn and should be stored. */
	taken: boolean;
}

export async function hashInventoryText(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function isUsableInventorySnapshot(
	value: unknown,
): value is HomeInventorySnapshot {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === INVENTORY_SNAPSHOT_VERSION &&
		typeof record.hash === "string" &&
		typeof record.text === "string" &&
		typeof record.takenAt === "string"
	);
}

/**
 * Keep the stored snapshot when it still describes the live inventory or the
 * difference fits in a short note; otherwise take a new one.
 */
export async function resolveInventorySnapshot(
	previous: HomeInventorySnapshot | null | undefined,
	liveText: string,
	now: () => Date = () => new Date(),
): Promise<ResolvedInventorySnapshot> {
	const hash = await hashInventoryText(liveText);
	const take = (): ResolvedInventorySnapshot => ({
		snapshot: {
			version: INVENTORY_SNAPSHOT_VERSION,
			hash,
			text: liveText,
			takenAt: now().toISOString(),
		},
		changeNote: null,
		taken: true,
	});
	if (!isUsableInventorySnapshot(previous)) return take();
	if (previous.hash === hash)
		return { snapshot: previous, changeNote: null, taken: false };
	const changeNote = renderInventoryChangeNote(previous.text, liveText);
	if (changeNote && changeNote.length > INVENTORY_CHANGE_NOTE_MAX_CHARS)
		return take();
	return { snapshot: previous, changeNote, taken: false };
}

/**
 * Line-level difference between the snapshot and live inventory, grouped by
 * section. Section headers carry only counts, so only entry lines are
 * compared. Null when no entry line differs (e.g. only a count of entries
 * past the render cap changed), which keeps the snapshot as it is.
 */
export function renderInventoryChangeNote(
	snapshotText: string,
	liveText: string,
): string | null {
	const before = entryLines(snapshotText);
	const after = entryLines(liveText);
	const beforeSet = new Set(before.map((entry) => entry.line));
	const afterSet = new Set(after.map((entry) => entry.line));
	const removed = before.filter((entry) => !afterSet.has(entry.line));
	const added = after.filter((entry) => !beforeSet.has(entry.line));
	if (removed.length === 0 && added.length === 0) return null;
	const lines = [
		"INVENTORY CHANGES SINCE THIS CONVERSATION STARTED (the current state; it overrides the inventory listed above):",
	];
	if (removed.length > 0) {
		lines.push("No longer listed as shown above:");
		for (const entry of removed) lines.push(`${entry.line} [${entry.section}]`);
	}
	if (added.length > 0) {
		lines.push("Now listed:");
		for (const entry of added) lines.push(`${entry.line} [${entry.section}]`);
	}
	return lines.join("\n");
}

function entryLines(text: string): { section: string; line: string }[] {
	const entries: { section: string; line: string }[] = [];
	let section = "inventory";
	for (const line of text.split("\n")) {
		if (line.startsWith("- ")) entries.push({ section, line });
		else if (line.trim()) section = sectionName(line);
	}
	return entries;
}

function sectionName(header: string): string {
	const match = /^AVAILABLE (\w+)/.exec(header);
	return match?.[1] ? match[1].toLowerCase() : "inventory";
}
