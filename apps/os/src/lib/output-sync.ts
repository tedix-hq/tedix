import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import type { OutputMergeOptions } from "@tedix/api-contract/utils/output-merge";
import {
	applyOutputPatch,
	diffOutputContent,
	projectOutputContent,
	type OutputPatch,
} from "@tedix/api-contract/utils/output-patch";

/**
 * How a file editor talks to its saved file without sending or fetching the
 * whole file each time.
 *
 * The editor reads the file in full once, when it opens. From then on this
 * keeps the saved copy the editor last knew: a save sends only the parts
 * that differ from that copy (`outputs.patch`), and catching up with someone
 * else's save fetches only what changed since it (`outputs.changes`). Both
 * hand the editor a complete saved copy, rebuilt here, so the rest of the
 * editor works as it did when the whole file travelled.
 */

export interface OutputSyncBridge {
	call<T = unknown>(method: string, args?: unknown): Promise<T>;
}

/** A saved copy as the editors hold it: the file and one revision of it. */
export interface SyncedOutput<Content extends OsOutputContent> {
	output: { id: string };
	revision: { revision: number; content: Content };
}

type Projections = Pick<
	OutputMergeOptions,
	"documentBlocks" | "presentationSlides"
>;

type PatchAnswer = {
	output: { id: string };
	revision: { revision: number };
	catchUp: OutputPatch | null;
};
type ChangesAnswer<Content> = {
	output: { id: string };
	revision: { revision: number };
	patch: OutputPatch | null;
	content?: Content;
};

/** A host that cannot answer a call; the editor then reads the whole file. */
const unsupported = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	["host_unavailable", "unknown_method"].includes(
		String((error as { code?: unknown }).code),
	);

export function createOutputSync<
	Content extends OsOutputContent,
	Saved extends SyncedOutput<Content>,
>(bridge: OutputSyncBridge, slot: string, projections: Projections = {}) {
	// The saved copy this editor last knew, exactly as the server stores it.
	// Editors must treat what they are handed as read-only.
	let known: Saved | undefined;
	const remember = (saved: Saved) => (known = saved);
	const withRevision = (
		answer: { output: { id: string }; revision: { revision: number } },
		content: Content,
	) =>
		({
			...known!,
			output: { ...known!.output, ...answer.output },
			revision: { ...known!.revision, ...answer.revision, content },
		}) as Saved;

	return {
		/** Keep a copy that was read in full. */
		remember,
		/** Forget the copy, so the next read fetches the whole file. */
		forget() {
			known = undefined;
		},
		/**
		 * The latest saved copy. Fetches only what changed since the known
		 * copy; `readFull` is used for the first read and by hosts that cannot
		 * report changes.
		 */
		async latest(readFull: () => Promise<Saved>): Promise<Saved> {
			const from = known;
			if (!from) return remember(await readFull());
			let answer: ChangesAnswer<Content>;
			try {
				answer = await bridge.call<ChangesAnswer<Content>>("outputs.changes", {
					slot,
					sinceRevision: from.revision.revision,
				});
			} catch (error) {
				if (!unsupported(error)) throw error;
				return remember(await readFull());
			}
			// A save or another read finished meanwhile: this answer is for an
			// older copy than the one now known.
			if (known !== from) return known ?? remember(await readFull());
			if (answer.output.id !== from.output.id)
				return remember(await readFull());
			if (answer.revision.revision === from.revision.revision) return from;
			const content =
				answer.content ??
				(answer.patch
					? applyOutputPatch(from.revision.content, answer.patch, projections)
					: from.revision.content);
			return remember(withRevision(answer, content));
		},
		/**
		 * Save `content`, which was edited from revision `basis`, by sending
		 * only what differs from that revision. Returns the saved copy as it is
		 * now stored, which also holds anyone else's changes the server merged
		 * in. When nothing differs, nothing is sent.
		 */
		async save(
			content: Content,
			basis: number,
			readFull: () => Promise<Saved>,
		): Promise<Saved> {
			if (!known) remember(await readFull());
			// Unsaved changes restored from an earlier visit were made against
			// an older revision: compare with that one, and let the server merge.
			const base =
				known!.revision.revision === basis
					? known!.revision.content
					: (
							await bridge.call<Saved>("outputs.readRevision", {
								slot,
								revision: basis,
							})
						).revision.content;
			const patch = diffOutputContent(base, content);
			if (!patch) {
				if (known!.revision.revision === basis) return known!;
				return this.latest(readFull);
			}
			const answer = await bridge.call<PatchAnswer>("outputs.patch", {
				slot,
				baseRevision: basis,
				patch,
			});
			const stored = answer.catchUp
				? applyOutputPatch(content, answer.catchUp, projections)
				: projectOutputContent(content, projections);
			return remember(withRevision(answer, stored));
		},
	};
}
