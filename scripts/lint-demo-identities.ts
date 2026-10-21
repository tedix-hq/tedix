#!/usr/bin/env bun
/**
 * Reject known private identities in sample text without publishing the names.
 *
 * The scan covers ~400 MB (mostly immutable migration snapshots) and took about
 * a minute of every local push. A local cache in the git common dir remembers
 * the SHA-256 of file contents already found clean, keyed by this script and
 * the denylist, so only new or changed contents are tokenized. A clone without
 * the cache, such as CI, scans everything.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import denylist from "./demo-identity-hashes.json";

type IdentityHash = { words: number; sha256: string };

const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

/**
 * Scans `paths` under `root`, skipping contents whose digest is in `clean`.
 * Returns the findings and the digests of every scanned-clean content seen,
 * which is the next cache (stale entries drop out).
 */
export function scanDemoIdentities(
	root: string,
	paths: string[],
	clean: ReadonlySet<string> = new Set(),
	hashes: readonly IdentityHash[] = denylist,
): { findings: string[]; clean: Set<string> } {
	const seen = new Set<string>();
	const findings = paths
		.filter(isDemoIdentityPath)
		.filter((path) => existsSync(join(root, path)))
		.flatMap((path) => {
			const bytes = readFileSync(join(root, path));
			if (bytes.includes(0)) return [];
			const digest = sha256(bytes);
			if (clean.has(digest)) {
				seen.add(digest);
				return [];
			}
			const found = demoIdentityFindings(path, bytes.toString("utf8"), hashes);
			if (!found.length) seen.add(digest);
			return found;
		});
	return { findings, clean: seen };
}

/** Cache file for this exact scanner and denylist, or null outside a git checkout. */
export function demoIdentityCacheFile(root: string): string | null {
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const key = sha256(
			readFileSync(fileURLToPath(import.meta.url), "utf8") +
				JSON.stringify(denylist),
		).slice(0, 16);
		return join(
			isAbsolute(common) ? common : join(root, common),
			"lint-cache",
			`demo-identities-${key}.txt`,
		);
	} catch {
		return null;
	}
}

function readCache(file: string | null): Set<string> {
	if (!file) return new Set();
	try {
		return new Set(
			readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => /^[a-f0-9]{64}$/.test(line)),
		);
	} catch {
		return new Set();
	}
}

function writeCache(file: string | null, clean: Set<string>) {
	if (!file) return;
	try {
		mkdirSync(join(file, ".."), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, [...clean].join("\n") + "\n");
		renameSync(tmp, file);
	} catch {
		// The cache only saves time; a read-only common dir scans in full.
	}
}

export function isDemoIdentityPath(path: string): boolean {
	return (
		path === "AGENT-REVIEW.md" ||
		path.startsWith("docs/public/") ||
		/(?:^|[/._-])(?:demo|sample|fixtures?|snapshots?|__fixtures__|__snapshots__|__tests__|tests?|browser-tests|examples?)(?:[/._-]|$)/i.test(
			path,
		)
	);
}

export function demoIdentityFindings(
	path: string,
	source: string,
	hashes: readonly IdentityHash[] = denylist,
): string[] {
	const decoded = source.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
		String.fromCharCode(parseInt(hex, 16)),
	);
	const normalized = decoded.normalize("NFKC").toLowerCase();
	const tokens = [...normalized.matchAll(/[\p{L}\p{N}]+/gu)];
	const byLength = new Map<number, Set<string>>();
	for (const { words, sha256 } of hashes) {
		if (!byLength.has(words)) byLength.set(words, new Set());
		byLength.get(words)!.add(sha256);
	}
	const lines = new Set<number>();
	for (let i = 0; i < tokens.length; i++) {
		for (const [length, digests] of byLength) {
			if (i + length > tokens.length) continue;
			const phrase = tokens
				.slice(i, i + length)
				.map((token) => token[0])
				.join(" ");
			if (!digests.has(createHash("sha256").update(phrase).digest("hex")))
				continue;
			lines.add(normalized.slice(0, tokens[i]!.index).split("\n").length);
		}
	}
	return [...lines].map(
		(line) => `${path}:${line}: use a fictional sample identity`,
	);
}

if (import.meta.main) {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const paths = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: root, encoding: "utf8" },
	)
		.split("\0")
		.filter(Boolean);
	const cacheFile = demoIdentityCacheFile(root);
	const previous = readCache(cacheFile);
	const { findings, clean } = scanDemoIdentities(root, paths, previous);
	// Keep other worktrees' contents too, until the cache outgrows the repo.
	writeCache(
		cacheFile,
		previous.size + clean.size <= 20_000
			? new Set([...previous, ...clean])
			: clean,
	);
	for (const finding of findings) console.error(finding);
	console.log(`Demo identities: ${findings.length} findings`);
	if (findings.length) process.exitCode = 1;
}
