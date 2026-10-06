import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Interactive-composer helpers for the tedix REPL: file mentions and richer
 * completion within the `node:readline` ceiling and without extra dependencies.
 * All filesystem access is injected so the logic is unit-testable without
 * touching disk.
 */

export interface FsCompleteDeps {
	readdir: (dir: string) => { name: string; isDir: boolean }[];
}

const defaultCompleteDeps: FsCompleteDeps = {
	readdir(dir) {
		try {
			return readdirSync(dir || ".", { withFileTypes: true }).map((e) => ({
				name: e.name,
				isDir: e.isDirectory(),
			}));
		} catch {
			return [];
		}
	},
};

/**
 * A conservative fallback for file completion. Prefix matches remain exact and
 * take precedence; only when none exist do we accept the typed characters as
 * an ordered subsequence (for example `cmp` → `composer.ts`). That keeps the
 * common case predictable without making users remember every filename vowel.
 */
function isOrderedSubsequence(query: string, candidate: string): boolean {
	let cursor = 0;
	for (const char of candidate.toLowerCase()) {
		if (char === query[cursor]) cursor++;
		if (cursor === query.length) return true;
	}
	return query.length === 0;
}

/** Expand a leading `~/` to the user's home directory. */
function expandHome(p: string): string {
	if (p === "~" || p.startsWith("~/")) {
		return homedir() + p.slice(1);
	}
	return p;
}

/**
 * Complete a partial file path (the text AFTER an `@`). Resolves the directory
 * portion, lists it, and filters by the trailing base name. Directories get a
 * trailing `/` so the next Tab descends. Hidden entries and entries with
 * whitespace in their name are excluded (whitespace-named entries can never
 * round-trip through the space-delimited @-mention syntax).
 */
export function completeFilePath(
	partial: string,
	deps: FsCompleteDeps = defaultCompleteDeps,
): string[] {
	const expanded = expandHome(partial);
	const slash = expanded.lastIndexOf("/");
	const dir = slash >= 0 ? expanded.slice(0, slash + 1) : "";
	const base = slash >= 0 ? expanded.slice(slash + 1) : expanded;
	// Reconstruct the user-visible prefix from `partial` (not expanded) so that
	// completions display the original `~/…` form when the user typed that.
	const displayDir =
		slash >= 0 ? partial.slice(0, partial.lastIndexOf("/") + 1) : "";
	const entries = deps
		.readdir(dir || ".")
		.filter(
			(e) =>
				e.name.startsWith(base) &&
				!e.name.startsWith(".") &&
				!/\s/.test(e.name),
		)
		.map((e) => `${displayDir}${e.name}${e.isDir ? "/" : ""}`);
	if (entries.length > 0 || base.length < 2) return entries.sort();

	const normalizedBase = base.toLowerCase();
	return deps
		.readdir(dir || ".")
		.filter(
			(e) =>
				!e.name.startsWith(".") &&
				!/\s/.test(e.name) &&
				isOrderedSubsequence(normalizedBase, e.name.toLowerCase()),
		)
		.map((e) => `${displayDir}${e.name}${e.isDir ? "/" : ""}`)
		.sort();
}

/**
 * `node:readline` completer: an `@<path>` token at the cursor completes file
 * paths; a `/<cmd>` line completes slash commands; anything else completes
 * nothing. Returns `[completions, substringReplaced]` per the readline contract.
 */
export function completeInput(
	line: string,
	commandNames: string[],
	deps: FsCompleteDeps = defaultCompleteDeps,
): [string[], string] {
	const at = line.match(/(?:^|\s)@([^\s]*)$/);
	if (at) {
		const partial = at[1] ?? "";
		return [completeFilePath(partial, deps).map((p) => `@${p}`), `@${partial}`];
	}
	if (line.startsWith("/")) {
		const hits = commandNames.filter((n) => n.startsWith(line));
		return [hits.length > 0 ? hits : commandNames, line];
	}
	return [[], line];
}

/**
 * Replace the active `@mention` token with a selected completion. The
 * completion includes its own `@` prefix so callers can use it directly in
 * both readline and Ink menus. An accidental completion keypress is harmless
 * when no mention is active.
 */
export function replaceMentionCompletion(
	line: string,
	completion: string,
): string {
	return line.replace(/(^|\s)@[^\s]*$/, (_match, prefix: string) => {
		return `${prefix}${completion}`;
	});
}

/**
 * Result from `readFile` injected dep.
 * - `string`: the file's UTF-8 content.
 * - `null`: file is absent or unreadable (binary, too large, permission error).
 * - `"is-directory"`: the path exists but is a directory, not a regular file.
 */
export type FileReadResult = string | null | "is-directory";

export interface FileReadDeps {
	readFile: (rel: string) => FileReadResult;
	/** Optional nonce generator — defaults to crypto.randomUUID(). Injected for tests. */
	generateNonce?: () => string;
}

/** Files larger than this are skipped (not silently truncated mid-attach). */
export const MAX_MENTION_BYTES = 64 * 1024;

const defaultReadDeps: FileReadDeps = {
	readFile(rel) {
		try {
			const path = resolve(process.cwd(), rel);
			const st = statSync(path);
			if (!st.isFile()) {
				// Distinguish directory from other non-file entries so callers can
				// report "exists but is a directory" rather than silently dropping.
				return st.isDirectory() ? "is-directory" : null;
			}
			if (st.size > MAX_MENTION_BYTES) return null;
			const buf = readFileSync(path);
			// Reject binary files: a NUL byte in the first 8 KB is a strong binary
			// signal — attaching 26 KB of mojibake to the prompt helps no one.
			if (buf.subarray(0, 8192).includes(0)) return null;
			return buf.toString("utf8");
		} catch {
			return null;
		}
	},
};

/** A token is "path-like" (worth reporting as a failed attach) if it has a slash or a file extension. */
function looksLikePath(token: string): boolean {
	return token.includes("/") || /\.[a-z0-9]+$/i.test(token);
}

/** Escape XML/HTML attribute-unsafe chars in a file path so a hostile filename can't break out of `path="..."`. */
function escapeAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Trailing punctuation that can accidentally attach to a path token. */
const TRAILING_PUNCT_RE = /[.,;:!?)]+$/;

/**
 * Expand `@path` file mentions in a composed message. Each token that resolves
 * to a readable file (≤64 KB) is appended as a fenced `<file>` block so the
 * remote kernel sees the content (the CLI is a thin client — the kernel can't
 * read the operator's local disk otherwise). Non-file tokens are left untouched.
 *
 * Security hardening applied here:
 * - **Injection-safe boundaries.** Each file block uses a per-attachment random
 *   nonce so a file whose content contains `</file>` cannot forge the closing
 *   fence: `<file path=... boundary=NONCE>...</file:NONCE>`.
 * - **Attribute-escaped paths.** The path attribute value is entity-escaped so a
 *   hostile filename (containing `"` or `>`) cannot break out of the attribute.
 *
 * Returns the augmented text, the de-duped list of attached paths, and `skipped`
 * — `@tokens` that looked like a file (or resolved to a directory or an
 * existing fs entry) but didn't attach — so the caller can warn instead of
 * silently dropping them. When nothing attaches, `text` is returned unchanged.
 */
export function expandFileMentions(
	text: string,
	deps: FileReadDeps = defaultReadDeps,
): { text: string; attached: string[]; skipped: string[] } {
	const getNonce =
		deps.generateNonce ??
		(() => crypto.randomUUID().replace(/-/g, "").slice(0, 16));

	const rawTokens = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)]
		.map((m) => m[1])
		.filter((t): t is string => Boolean(t));

	const seen = new Set<string>();
	const blocks: string[] = [];
	const attached: string[] = [];
	const skipped: string[] = [];

	for (const rawToken of rawTokens) {
		// Resolve the canonical path to use: first try the token verbatim, then
		// strip trailing punctuation and retry once. This way @file.txt. (with an
		// errant trailing period) attaches the real file rather than silently
		// dropping it.
		let rel = rawToken;
		let content = deps.readFile(rel);
		if (content === null) {
			const stripped = rawToken.replace(TRAILING_PUNCT_RE, "");
			if (stripped !== rawToken && stripped.length > 0) {
				const strippedContent = deps.readFile(stripped);
				if (strippedContent !== null) {
					// Stripped form resolves — use it.
					rel = stripped;
					content = strippedContent;
				}
			}
		}

		if (seen.has(rel)) continue;
		seen.add(rel);

		if (content === "is-directory") {
			// A token that resolved to an existing directory is always skipped and
			// reported, regardless of looksLikePath (the path exists on disk).
			skipped.push(rel);
			continue;
		}
		if (content == null) {
			// Only flag tokens that genuinely look like a file path — leave casual
			// `@name` mentions (no slash, no extension) untouched and unreported.
			if (looksLikePath(rel)) skipped.push(rel);
			continue;
		}

		// Render a nonce-boundary block so embedded `</file>` in the content
		// cannot forge the closing fence.
		const nonce = getNonce();
		const escapedPath = escapeAttr(rel);
		blocks.push(
			`<file path="${escapedPath}" boundary="${nonce}">\n${content}\n</file:${nonce}>`,
		);
		attached.push(rel);
	}
	const out = blocks.length === 0 ? text : `${text}\n\n${blocks.join("\n\n")}`;
	return { text: out, attached, skipped };
}

/**
 * Session-scoped "always approve" key for an approval card. Approving-always one
 * write capability or delegation target then auto-approves future MATCHING cards
 * for the rest of the REPL session (in-memory only — never persisted, never
 * cross-session). Mirrors a common session approval cache pattern, scoped to the
 * card's route so "always approve gmail drafts" never leaks to a different write.
 */
export function approvalScopeKey(summary: {
	kernelRoute?: Record<string, unknown>;
	targetTediId?: string;
	targetTediLabel?: string;
}): string {
	const route =
		summary.kernelRoute && typeof summary.kernelRoute === "object"
			? (summary.kernelRoute as Record<string, unknown>)
			: {};
	const routeKind =
		typeof route.routeKind === "string" ? route.routeKind : "approval";
	const intent =
		route.toolIntent && typeof route.toolIntent === "object"
			? (route.toolIntent as Record<string, unknown>)
			: {};
	if (routeKind === "propose_tool_write") {
		const app = typeof intent.appSlug === "string" ? intent.appSlug : "?";
		const cap = typeof intent.capability === "string" ? intent.capability : "?";
		return `write:${app}.${cap}`;
	}
	if (routeKind === "delegate_tedi" || routeKind === "suggest_handoff") {
		return `delegate:${summary.targetTediId ?? summary.targetTediLabel ?? "?"}`;
	}
	return routeKind;
}

/**
 * Read one logical input line with `\`-continuation multiline. `ask` reads a raw
 * line (resolving `undefined` at EOF). When `multiline` is true and a line ends
 * in a single backslash, further lines are read and joined with newlines (the
 * trailing backslash dropped) until a line doesn't end in `\` or EOF is reached.
 *
 * NULL-SAFE: an `undefined` continuation read (real EOF, or a non-TTY pipe that
 * won't deliver the next line to a second `question`) ends composition and
 * returns what was gathered — it must never throw (a TypeError there gets
 * swallowed as "readline closed" and silently drops the whole turn). With
 * `multiline` false (non-TTY stdin) the first line is returned verbatim, so a
 * trailing backslash is treated literally instead of hanging on a continuation.
 */
export async function composeMultiline(
	ask: (prompt: string) => Promise<string | undefined>,
	prompt: string,
	multiline: boolean,
): Promise<string> {
	const first = await ask(prompt);
	if (first == null) return "";
	if (!multiline || !first.endsWith("\\")) return first;
	const parts: string[] = [];
	let line: string | undefined = first;
	while (line?.endsWith("\\")) {
		parts.push(line.slice(0, -1));
		line = await ask("  … ");
	}
	if (line != null) parts.push(line);
	return parts.join("\n");
}
