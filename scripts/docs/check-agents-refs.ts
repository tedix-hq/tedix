// AGENTS.md reference discipline. A backticked `path:line` anchor rots the
// moment code moves, so guides must cite `path` + `symbol` instead. Every
// backticked path-shaped token must also resolve to a real file or
// directory. Exported functions carry the analysis; the runner at the
// bottom owns I/O and the exit code.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AgentsRefFinding {
	readonly file: string;
	readonly token: string;
	readonly message: string;
}

// The root guide's source-path table uses workspace-relative shorthand
// (`src/do.ts` in the apps/tedi-runtime row); docs/public/AGENTS.md is its
// synced copy. The line-anchor rule still applies to both.
const existenceCheckExempt = new Set(["AGENTS.md", "docs/public/AGENTS.md"]);

// A reference that names a path which must stay absent cannot satisfy the
// existence check. Keep the reason beside each exemption.
const allowedMissingReferences: Record<string, readonly string[]> = {
	"packages/db/AGENTS.md": [
		// The no-barrel rule names a file that must never be created.
		"queries/index.ts",
	],
};

function markdownBody(text: string): string {
	// Fenced blocks can hold backtick pairs that are not references.
	return text.replace(/```[\s\S]*?```/g, "");
}

function backtickedTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const match of markdownBody(text).matchAll(/`([^`\n]+)`/g)) {
		if (match[1] !== undefined) tokens.push(match[1]);
	}
	return tokens;
}

// A token reads as a repository path when it is slash-separated words ending
// in a directory marker or a file extension. Placeholders, globs, commands,
// package specifiers and bare filenames are not verifiable references.
export function isPathReference(token: string): boolean {
	if (token.startsWith("/")) return false;
	if (!/^[\w./-]+$/.test(token)) return false;
	if (!token.includes("/")) return false;
	return token.endsWith("/") || /\.[A-Za-z0-9]+$/.test(token);
}

// A backticked file:line anchor, such as `src/handler.ts:300`.
export function isLineAnchor(token: string): boolean {
	return /\.[A-Za-z0-9]+:\d+/.test(token);
}

// A scoped guide resolves a reference against its own directory first, then
// under its `src/` (guides drop the segment for brevity, e.g. `rpc/orpc.ts`),
// then the repository root (`apps/api/...`, `scripts/...`).
export function referenceCandidates(file: string, token: string): string[] {
	const dir = dirname(file);
	const candidates =
		dir === "."
			? [token]
			: [join(dir, token), join(dir, "src", token), token.replace(/\/$/, "")];
	return [...new Set(candidates)];
}

export function findLineAnchors(
	file: string,
	text: string,
): AgentsRefFinding[] {
	const findings: AgentsRefFinding[] = [];
	for (const token of backtickedTokens(text)) {
		if (isLineAnchor(token)) {
			findings.push({
				file,
				token,
				message: `${file}: \`${token}\` anchors a line number; use a symbol reference`,
			});
		}
	}
	return findings;
}

export function findMissingReferences(
	file: string,
	text: string,
	exists: (repoRelativePath: string) => boolean,
): AgentsRefFinding[] {
	const findings: AgentsRefFinding[] = [];
	if (existenceCheckExempt.has(file)) return findings;
	const allowed = new Set(allowedMissingReferences[file] ?? []);
	for (const token of backtickedTokens(text)) {
		if (!isPathReference(token) || allowed.has(token)) continue;
		if (!referenceCandidates(file, token).some(exists)) {
			findings.push({
				file,
				token,
				message: `${file}: backticked path does not exist: \`${token}\``,
			});
		}
	}
	return findings;
}

if (import.meta.main) {
	const repoRoot = join(import.meta.dir, "../..");
	const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot })
		.stdout.toString("utf8")
		.split("\0")
		.filter((file) => file === "AGENTS.md" || file.endsWith("/AGENTS.md"));
	const findings: AgentsRefFinding[] = [];
	for (const file of tracked) {
		const text = await readFile(join(repoRoot, file), "utf8");
		findings.push(...findLineAnchors(file, text));
		findings.push(
			...findMissingReferences(file, text, (candidate) =>
				existsSync(join(repoRoot, candidate)),
			),
		);
	}
	for (const finding of findings) console.error(finding.message);
	if (findings.length > 0) {
		throw new Error(`${findings.length} stale AGENTS.md reference(s)`);
	}
	console.log(`AGENTS.md references ok: ${tracked.length} guides checked`);
}
