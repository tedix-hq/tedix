/**
 * Save part of a file as its next revision. One routine serves a signed-in
 * member and a share-link visitor allowed to edit: the caller says who is
 * saving and which stored revisions that person may read, and this applies
 * the patch, merges it with anything saved meanwhile, and writes it behind a
 * compare-and-swap on the revision it was built on.
 */
import { ORPCError } from "@orpc/server";
import type { OsOutputContentPatch } from "@tedix/api-contract/schemas/os-output-patch";
import type {
	OsCreatedByKind,
	OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	blocksFromRichText,
	normalizeDocumentContent,
} from "@tedix/api-contract/utils/os-document";
import { continuesOutputAutosaveBurst } from "@tedix/api-contract/utils/os-output-autosave";
import { OS_OUTPUT_AUTOSAVE_NOTE } from "@tedix/api-contract/utils/os-output-limits";
import { mergeOutputContent } from "@tedix/api-contract/utils/output-merge";
import {
	applyOutputPatch,
	diffOutputContent,
	OutputPatchError,
} from "@tedix/api-contract/utils/output-patch";
import { projectPresentationDeck } from "@tedix/api-contract/utils/presentation-patch";
import type { DbQueryClient } from "@tedix/db/query-client";
import type {
	OsOutputRevisionRow,
	OsOutputRow,
} from "@tedix/db/schema/os-workspaces";
import { createError, ErrorCodes } from "../rpc/orpc";
import { mapOsOutputRow } from "./os-output-library";
import {
	createOsOutputRevision,
	getOsOutputRevisionByNumber,
} from "./os-workspace-outputs";
import { getOsOutput } from "./workspace-output-storage";

/** The access record of a file that carries no data from connected accounts. */
export const EMPTY_OUTPUT_ACCESS_ENVELOPE = JSON.stringify({
	version: 1,
	sources: [],
});

/** How the plain copies next to a rich body are rebuilt after a patch or merge. */
export const OUTPUT_PROJECTIONS = {
	documentBlocks: blocksFromRichText,
	presentationSlides: projectPresentationDeck,
};

/**
 * Stored content as the editors hold it. A document written before the rich
 * editor carries only blocks; its rich body is derived here exactly as the
 * editor's host derives it, so a patch made in the editor fits.
 */
export function editableStoredContent(
	row: OsOutputRevisionRow,
): OsOutputContent {
	const content = OsOutputContentSchema.parse(JSON.parse(row.content));
	return content.kind === "document" && !content.file && content.blocks.length
		? normalizeDocumentContent(content)
		: content;
}

/** Saves that lost the write to a concurrent save are applied again this often. */
const PATCH_WRITE_ATTEMPTS = 3;

export interface OsOutputPatchSave {
	/** The file as the caller's own access check loaded it. */
	output: OsOutputRow;
	/** Load the file again, behind the same access check, after a lost write. */
	reloadOutput: () => Promise<OsOutputRow>;
	/** The file's current revision, or a refusal when this caller may not read it. */
	currentRevision: (output: OsOutputRow) => Promise<OsOutputRevisionRow>;
	/** Whether this caller may read an earlier revision a merge would build on. */
	canReadRevision: (revision: OsOutputRevisionRow) => Promise<boolean>;
	baseRevision: number;
	patch: OsOutputContentPatch;
	autosave?: boolean;
	note?: string | null;
	expectedWorkspaceId?: string;
	creator: { kind: OsCreatedByKind; id: string };
	producer: { skillRunId: string | null; skillId: string | null };
	accessEnvelope: string | null;
}

export async function saveOsOutputPatch(
	db: DbQueryClient,
	input: OsOutputPatchSave,
) {
	let output = input.output;
	const { creator, producer, accessEnvelope } = input;
	const conflict = (currentRevision: number | null, parts?: string[]) =>
		new ORPCError("CONFLICT", {
			message: parts?.length
				? "Someone else changed the same part of this file"
				: "Output revision compare-and-swap lost against a concurrent revision write",
			data: {
				expectedRevision: input.baseRevision,
				currentRevision,
				...(parts?.length ? { parts } : {}),
			},
		});
	let latest: number | null = null;
	for (let attempt = 0; attempt < PATCH_WRITE_ATTEMPTS; attempt++) {
		const current = await input.currentRevision(output);
		latest = current.revision;
		if (input.baseRevision > current.revision) throw conflict(current.revision);
		const theirs = editableStoredContent(current);
		let base = theirs;
		if (input.baseRevision < current.revision) {
			// A merge never moves content out from behind a stricter access
			// check, and never builds on a revision this caller cannot read.
			if (current.accessEnvelope !== accessEnvelope)
				throw conflict(current.revision);
			const started = await getOsOutputRevisionByNumber(db, {
				organizationId: output.organizationId,
				outputId: output.id,
				revision: input.baseRevision,
			});
			if (!started || !(await input.canReadRevision(started)))
				throw conflict(current.revision);
			base = editableStoredContent(started);
		}
		let mine: OsOutputContent;
		try {
			mine = applyOutputPatch(base, input.patch, OUTPUT_PROJECTIONS);
		} catch (error) {
			if (!(error instanceof OutputPatchError)) throw error;
			throw createError(ErrorCodes.BAD_REQUEST, error.message);
		}
		let next = mine;
		if (base !== theirs) {
			const merged = mergeOutputContent(base, mine, theirs, OUTPUT_PROJECTIONS);
			if (!merged.ok) throw conflict(current.revision, merged.conflicts);
			next = merged.content;
		}
		const checked = OsOutputContentSchema.safeParse(next);
		if (!checked.success) {
			const issue = checked.error.issues[0];
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`The change does not fit this file: ${issue?.path.join("/") ?? ""} ${issue?.message ?? "invalid"}`.trim(),
			);
		}
		// An editor's own save a moment after an edit. It continues a burst
		// when the revision it builds on is the same person's auto-save from
		// a few minutes ago at most; anything else starts a new entry.
		const autosave = input.autosave === true;
		const note = autosave ? OS_OUTPUT_AUTOSAVE_NOTE : (input.note ?? null);
		const continuesBurst =
			autosave &&
			continuesOutputAutosaveBurst(current, {
				note,
				createdByKind: creator.kind,
				createdById: creator.id,
				skillRunId: producer.skillRunId ?? null,
				createdAt: new Date().toISOString(),
			});
		const result = await createOsOutputRevision(
			db,
			{
				id: crypto.randomUUID(),
				organizationId: output.organizationId,
				outputId: output.id,
				expectedWorkspaceId: input.expectedWorkspaceId,
				content: JSON.stringify(checked.data),
				note:
					base === theirs
						? note
						: `${note ?? "Saved"} · merged with revision ${current.revision}`,
				createdByKind: creator.kind,
				createdById: creator.id,
				...producer,
				accessEnvelope,
				expectedRevision: current.revision,
			},
			undefined,
			{ continuesBurst },
		);
		if (result.ok) {
			const advanced = await getOsOutput(db, {
				organizationId: output.organizationId,
				outputId: output.id,
			});
			// What is stored beyond what the caller sent: someone else's merged
			// changes, schema defaults, images moved out of the content.
			const stored = OsOutputContentSchema.parse(
				JSON.parse(result.revision.content),
			);
			return {
				output: mapOsOutputRow(advanced ?? output),
				revision: {
					id: result.revision.id,
					revision: result.revision.revision,
					createdAt: result.revision.createdAt,
				},
				mergedWith: base === theirs ? null : current.revision,
				continuesBurst,
				catchUp: diffOutputContent(mine, stored),
			};
		}
		if (result.reason === "output_not_found")
			throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		// Someone saved between the read and the write: apply the patch again
		// on top of their revision.
		output = await input.reloadOutput();
	}
	throw conflict(latest);
}

/**
 * What changed in a file since a revision the caller holds: a patch when the
 * caller may read that revision, the whole current content otherwise.
 */
export async function osOutputChangesSince(
	db: DbQueryClient,
	input: {
		output: OsOutputRow;
		current: OsOutputRevisionRow;
		sinceRevision: number;
		canReadRevision: (revision: OsOutputRevisionRow) => Promise<boolean>;
	},
) {
	const { output, current } = input;
	const answer = {
		output: mapOsOutputRow(output),
		revision: {
			id: current.id,
			revision: current.revision,
			createdAt: current.createdAt,
			createdByKind: current.createdByKind,
		},
	};
	if (input.sinceRevision >= current.revision)
		return { ...answer, patch: null };
	const content = editableStoredContent(current);
	const started = await getOsOutputRevisionByNumber(db, {
		organizationId: output.organizationId,
		outputId: output.id,
		revision: input.sinceRevision,
	});
	if (!started || !(await input.canReadRevision(started)))
		return { ...answer, patch: null, content };
	const since = editableStoredContent(started);
	if (since.kind !== content.kind || content.kind === "video")
		return { ...answer, patch: null, content };
	return { ...answer, patch: diffOutputContent(since, content) };
}
