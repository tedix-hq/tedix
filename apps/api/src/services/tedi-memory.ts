/**
 * A tedi's core memory: a few short sections the tedi keeps up to date
 * itself and that sit in its prompt on every trusted turn. Every change is a
 * new version, so a person can read what changed and bring a version back.
 */

import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";
import {
	TEDI_CORE_MEMORY_LIMIT,
	TEDI_CORE_MEMORY_SECTIONS,
	TEDI_CORE_MEMORY_VERSIONS_KEPT,
	TEDI_MEMORY_NOTE_COUNT_LIMIT,
	TEDI_MEMORY_NOTE_VERSIONS_KEPT,
	type TediMemoryNote,
	type WriteTediMemoryNoteOutput,
	type EditTediCoreMemoryOutput,
	type TediCoreMemory,
	type TediCoreMemorySectionKey,
} from "@tedix/api-contract/schemas/tedi-memory";
import { storeTediMemoryRevision } from "./tedi-memory-binding";
import { scrubText } from "@tedix/context-core/trace-safety";
import {
	getCurrentTediMemoryDocument,
	getTediMemoryDocumentVersion,
	listCurrentTediMemoryNotes,
	TEDI_CORE_MEMORY_NAME,
} from "@tedix/db/queries/tedi-memory";
import type { DbQueryClient } from "@tedix/db/query-client";
import type {
	TediMemoryAuthorType,
	TediMemoryDocumentRow,
} from "@tedix/db/schema/tedi-memory";

export interface TediMemoryScope {
	organizationId: string;
	tediId: string;
}

export interface TediMemoryAuthor {
	type: TediMemoryAuthorType;
	id: string;
}

type Sections = Record<TediCoreMemorySectionKey, string>;

const coreDocument = (scope: TediMemoryScope) => ({
	...scope,
	kind: "core" as const,
	name: TEDI_CORE_MEMORY_NAME,
});

function sectionsOf(row: TediMemoryDocumentRow | null): Sections {
	const stored = row?.sections ?? {};
	const sections = {} as Sections;
	for (const { key } of TEDI_CORE_MEMORY_SECTIONS)
		sections[key] = typeof stored[key] === "string" ? stored[key] : "";
	return sections;
}

const usedChars = (sections: Sections) =>
	Object.values(sections).reduce((sum, text) => sum + text.length, 0);

export function coreMemoryView(
	tediId: string,
	row: TediMemoryDocumentRow | null,
): TediCoreMemory {
	const sections = sectionsOf(row);
	return {
		tediId,
		version: row?.version ?? 0,
		sections: TEDI_CORE_MEMORY_SECTIONS.map(({ key, title }) => ({
			key,
			title,
			text: sections[key],
		})),
		usedChars: usedChars(sections),
		limitChars: TEDI_CORE_MEMORY_LIMIT,
		updatedAt: row?.createdAt ?? null,
	};
}

/**
 * Why a text may not be stored in a tedi's memory, or null when it may.
 * Memory holds what the tedi concluded in its own words. A credential, a
 * block of pasted output or a file's contents is refused whole, never
 * trimmed, so nothing of it is kept.
 */
export function memoryTextRefusal(text: string): string | null {
	if (containsCardSecret(text) || scrubText(text) !== text)
		return "This looks like it holds a secret or credential. Memory never stores those; write the lesson without it.";
	if (/```|~~~/.test(text))
		return "Memory does not store command output, code or file contents. Write what you learned in your own words.";
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
		return "Memory stores plain text only.";
	return null;
}

const tidy = (text: string) =>
	text
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

export async function readTediCoreMemory(
	db: DbQueryClient,
	scope: TediMemoryScope,
): Promise<TediCoreMemory> {
	const [core, notes] = await Promise.all([
		getCurrentTediMemoryDocument(db, coreDocument(scope)),
		listCurrentTediMemoryNotes(db, scope),
	]);
	return {
		...coreMemoryView(scope.tediId, core),
		notes: notes.map(({ name, description }) => ({ name, description })),
	};
}

/** One note as it is now, or null when there is none under that name. */
export async function readTediMemoryNote(
	db: DbQueryClient,
	scope: TediMemoryScope,
	name: string,
): Promise<TediMemoryNote | null> {
	const row = await getCurrentTediMemoryDocument(db, {
		...scope,
		kind: "note",
		name,
	});
	if (!row || row.removed) return null;
	return {
		name,
		description: row.description ?? "",
		content: row.content ?? "",
		version: row.version,
		updatedAt: row.createdAt,
	};
}

/** Writes a note's whole text as its next version; empty text removes it. */
export async function writeTediMemoryNote(
	db: DbQueryClient,
	scope: TediMemoryScope,
	author: TediMemoryAuthor,
	note: { name: string; description: string; content: string },
): Promise<WriteTediMemoryNoteOutput> {
	const content = tidy(note.content);
	const description = note.description.replace(/\s+/g, " ").trim();
	const refused = memoryTextRefusal(content) ?? memoryTextRefusal(description);
	if (refused) return { status: "refused", reason: refused };
	const document = { ...scope, kind: "note" as const, name: note.name };
	const [current, notes] = await Promise.all([
		getCurrentTediMemoryDocument(db, document),
		listCurrentTediMemoryNotes(db, scope),
	]);
	const exists = Boolean(current && !current.removed);
	if (!content && !exists)
		return { status: "refused", reason: "There is no note under that name." };
	if (content && !exists && notes.length >= TEDI_MEMORY_NOTE_COUNT_LIMIT)
		return {
			status: "refused",
			reason: `You already keep ${TEDI_MEMORY_NOTE_COUNT_LIMIT} notes, the most allowed. Remove or merge one first.`,
		};
	const stored = await storeTediMemoryRevision(db, {
		...document,
		id: crypto.randomUUID(),
		baseVersion: current?.version ?? 0,
		description: content ? description : null,
		content: content || null,
		removed: !content,
		charCount: content.length,
		authorType: author.type,
		authorId: author.id,
		changeSummary: content
			? exists
				? "Rewrote the note"
				: "Wrote the note"
			: "Removed the note",
		createdAt: new Date().toISOString(),
		keepVersions: TEDI_MEMORY_NOTE_VERSIONS_KEPT,
	});
	if (!stored)
		return {
			status: "refused",
			reason: "The note was being changed at the same time. Try again.",
		};
	return { status: content ? "saved" : "removed" };
}

const SECTION_TITLE = Object.fromEntries(
	TEDI_CORE_MEMORY_SECTIONS.map(({ key, title }) => [key, title]),
) as Record<TediCoreMemorySectionKey, string>;

async function storeCoreVersion(
	db: DbQueryClient,
	scope: TediMemoryScope,
	author: TediMemoryAuthor,
	change: (
		current: TediMemoryDocumentRow | null,
	) =>
		| { sections: Sections; summary: string }
		| { refused: string }
		| { unchanged: true },
): Promise<EditTediCoreMemoryOutput> {
	// A second pass covers one other change stored from the same version.
	for (let pass = 0; pass < 3; pass++) {
		const current = await getCurrentTediMemoryDocument(db, coreDocument(scope));
		const next = change(current);
		const memory = coreMemoryView(scope.tediId, current);
		if ("unchanged" in next) return { status: "unchanged", memory };
		if ("refused" in next)
			return { status: "refused", reason: next.refused, memory };
		const total = usedChars(next.sections);
		if (total > TEDI_CORE_MEMORY_LIMIT)
			return {
				status: "refused",
				reason: `Core memory holds at most ${TEDI_CORE_MEMORY_LIMIT} characters across all sections and this edit would make it ${total}. Nothing was changed. Shorten or replace a section first, or move detail into a note.`,
				memory,
			};
		const stored = await storeTediMemoryRevision(db, {
			...coreDocument(scope),
			id: crypto.randomUUID(),
			baseVersion: current?.version ?? 0,
			sections: next.sections,
			charCount: total,
			authorType: author.type,
			authorId: author.id,
			changeSummary: next.summary,
			createdAt: new Date().toISOString(),
			keepVersions: TEDI_CORE_MEMORY_VERSIONS_KEPT,
		});
		if (stored)
			return {
				status: "saved",
				memory: await readTediCoreMemory(db, scope),
			};
	}
	return {
		status: "refused",
		reason:
			"Core memory was being changed at the same time. Read it and try again.",
		memory: await readTediCoreMemory(db, scope),
	};
}

export function editTediCoreMemory(
	db: DbQueryClient,
	scope: TediMemoryScope,
	author: TediMemoryAuthor,
	edit: {
		section: TediCoreMemorySectionKey;
		mode: "replace" | "append";
		text: string;
	},
): Promise<EditTediCoreMemoryOutput> {
	const text = tidy(edit.text);
	return storeCoreVersion(db, scope, author, (current) => {
		const refused = memoryTextRefusal(text);
		if (refused) return { refused };
		if (edit.mode === "append" && !text)
			return { refused: "There is nothing to add." };
		const sections = sectionsOf(current);
		const before = sections[edit.section];
		sections[edit.section] =
			edit.mode === "append" ? [before, text].filter(Boolean).join("\n") : text;
		if (sections[edit.section] === before) return { unchanged: true };
		return {
			sections,
			summary: `${edit.mode === "append" ? "Added to" : "Replaced"} "${SECTION_TITLE[edit.section]}"`,
		};
	});
}

/** Brings an earlier version back as the newest one; null when it is not kept. */
export async function restoreTediCoreMemoryVersion(
	db: DbQueryClient,
	scope: TediMemoryScope,
	author: TediMemoryAuthor,
	version: number,
): Promise<EditTediCoreMemoryOutput | null> {
	const earlier = await getTediMemoryDocumentVersion(db, {
		...coreDocument(scope),
		version,
	});
	if (!earlier) return null;
	const restored = sectionsOf(earlier);
	return storeCoreVersion(db, scope, author, (current) =>
		current?.version === version ||
		JSON.stringify(sectionsOf(current)) === JSON.stringify(restored)
			? { unchanged: true }
			: { sections: restored, summary: `Restored version ${version}` },
	);
}
