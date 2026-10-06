/**
 * The seam between the OT loop and the editor that renders it.
 *
 * `./client` runs the two-buffer Jupiter replica; `@/components/canvas-editor` runs CodeMirror.
 * Neither imports the other: the editor consumes exactly this interface, the sync layer implements
 * it over an `OtClient`, and this module owns nothing but the shape they agree on. That is what
 * keeps the editor testable against a hand-written session with no socket, and the client testable
 * with no DOM.
 *
 * A session addresses files by `path` because a `CodeChange` is a document's whole file map (see
 * `./code-change`); today's rooms sync a single file, but the seam must not narrow that away.
 *
 * Nothing here is stateful and nothing here is async. `applyLocal` is fire-and-forget — the client
 * owns submission, retry, and rebasing, and reports the one condition the user must act on through
 * `blocked()`. An editor never waits on an ack.
 */

import type { CodeChange } from "./code-change";

/** One open document the editor edits and the sync layer owns. */
export interface OtEditSession {
	/** Current server-agreed + local text for `path`. */
	text(path: string): string;
	/** The editor calls this for every LOCAL edit. `change` is relative to the text the editor had. */
	applyLocal(change: CodeChange, path: string, newText: string): void;
	/** Subscribe to changes that did NOT originate in this editor. Returns an unsubscribe. */
	onRemote(listener: (change: CodeChange) => void): () => void;
	/** Non-null when local editing is blocked and the user must act. */
	blocked(): { code: "capacity"; message: string } | null;
}
