/**
 * Read evidence for workspace file tools — the half of the compaction contract
 * that `context-overflow.ts` does not cover.
 *
 * Tedix compacts mid-turn: proactively at 85% of the resolved input budget and
 * reactively on a provider overflow. Compaction summarizes a span of the
 * transcript away, and a `read` tool result is exactly the kind of bulk output
 * a summarizer drops first. Nothing invalidated that, so the model could write
 * a file whose contents it "knew" only from a turn that no longer exists —
 * compaction silently licensed a stale write.
 *
 * The ledger is an epoch per (scope, path): a read stamps the current
 * compaction epoch, an effective compaction bumps the epoch, and a write to a
 * path stamped at an older epoch is refused until the model reads it again.
 *
 * Scope of the guard: it invalidates evidence; it does not invent a blanket
 * read-before-write regime. A path the model never read is not gated — that is
 * the runtime's pre-existing behavior and changing it is a separate decision.
 * `exec` is likewise not gated: a shell redirect can write a file, but the
 * shell is not a tool that claims to know the file's contents.
 *
 * Why here and not in `workspace-fs.ts`: the VFS adapter is also driven by Code
 * Mode, snapshots and the R2 identity mount — callers with no transcript and
 * therefore no evidence to lose. Evidence is about what the MODEL has seen, so
 * it belongs at the model's tool surface (`createComputerEnvironmentTools`),
 * which is the one chokepoint both the durable scratch workspace and the Linux
 * computer file operations pass through.
 *
 * Why an isolate-level ledger: the parent `AgentTediDO` executes every file
 * tool, including the ones a conversation facet proxies back to it, and each
 * facet is a COLOCATED child Durable Object (`docs/tedi/agent-runtime.md`).
 * Parent and facets therefore share one isolate, so a facet compacting its own
 * session can invalidate the evidence the parent recorded for it without any
 * cross-object plumbing. The epoch is global for the same reason: a compacting
 * facet cannot know which computer scope the summarized reads belonged to, and
 * over-invalidating costs one re-read while under-invalidating costs a wrong
 * file.
 */

/** Tools whose result IS the file's contents. */
const READ_TOOLS = new Set(["read"]);
/** Tools that overwrite a file the model believes it already knows. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Bounds. An evicted entry loses its guard rather than blocking a write, so
 * both ceilings are set well above a realistic turn's file count.
 */
const MAX_PATHS_PER_SCOPE = 1_000;
const MAX_SCOPES = 64;

/** Bumped by every effective compaction; read stamps compare against it. */
let compactionEpoch = 0;
/** scope key → path → the epoch the path was last read at. */
const evidence = new Map<string, Map<string, number>>();

export const STALE_READ_EVIDENCE_DIRECTIVE =
	"This conversation was compacted since you last read this file, so the " +
	"contents you are holding are no longer in your context and may be stale. " +
	"Read the file again, then repeat this write.";

/**
 * Collapse `.`, `..`, and empty segments, and resolve a relative tool path
 * against the computer's cwd exactly as `ComputerEnvironmentController.fileIn`
 * does — so `read("a.ts")` in `/w` and `write("/w/a.ts")` are one key. With no
 * cwd (the durable scratch workspace, where the model is asked for absolute
 * paths) the path is normalized as given; a mismatch then costs a re-read.
 */
export function readEvidenceKey(cwd: string | undefined, path: string): string {
	const trimmed = path.trim();
	const joined =
		trimmed.startsWith("/") || !cwd ? trimmed : `${cwd}/${trimmed}`;
	const segments: string[] = [];
	for (const segment of joined.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return (joined.startsWith("/") ? "/" : "") + segments.join("/");
}

function pathsFor(scope: string): Map<string, number> {
	const existing = evidence.get(scope);
	if (existing) return existing;
	if (evidence.size >= MAX_SCOPES) {
		const oldest = evidence.keys().next();
		if (!oldest.done) evidence.delete(oldest.value);
	}
	const created = new Map<string, number>();
	evidence.set(scope, created);
	return created;
}

function toolPath(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" && path.trim() ? path : null;
}

/**
 * Record a successful read. A refused or failed read is not evidence, so a
 * result that explicitly reports `ok: false` is ignored.
 */
export function recordToolRead(
	scope: string,
	toolName: string,
	cwd: string | undefined,
	input: unknown,
	output: unknown,
): void {
	if (!READ_TOOLS.has(toolName)) return;
	if (
		output &&
		typeof output === "object" &&
		(output as { ok?: unknown }).ok === false
	)
		return;
	const path = toolPath(input);
	if (!path) return;
	const paths = pathsFor(scope);
	const key = readEvidenceKey(cwd, path);
	paths.delete(key);
	paths.set(key, compactionEpoch);
	while (paths.size > MAX_PATHS_PER_SCOPE) {
		const oldest = paths.keys().next();
		if (oldest.done) break;
		paths.delete(oldest.value);
	}
}

/**
 * Refuse a write whose read evidence a compaction summarized away. Returns
 * `null` when the write may proceed — including for a path the model never
 * read, which this guard deliberately does not gate.
 */
export function refuseStaleWrite(
	scope: string,
	toolName: string,
	cwd: string | undefined,
	input: unknown,
): { ok: false; error: string; path: string; operation: string } | null {
	if (!WRITE_TOOLS.has(toolName)) return null;
	const path = toolPath(input);
	if (!path) return null;
	const key = readEvidenceKey(cwd, path);
	const stampedAt = evidence.get(scope)?.get(key);
	if (stampedAt === undefined || stampedAt >= compactionEpoch) return null;
	return {
		ok: false,
		error: STALE_READ_EVIDENCE_DIRECTIVE,
		path,
		operation: toolName,
	};
}

/**
 * Invalidate every read recorded before now. Called when a compaction actually
 * summarized history away.
 */
export function invalidateReadEvidence(): void {
	compactionEpoch += 1;
}
