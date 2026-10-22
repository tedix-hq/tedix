#!/usr/bin/env bun
/**
 * Reject known private identities in sample text without publishing the names.
 *
 * The scan covers ~400 MB (mostly immutable migration snapshots) and took about
 * a minute of every local push. A local cache in the git common dir remembers
 * the SHA-256 of file contents already found clean, keyed by this script and
 * the denylist, so only new or changed contents are tokenized. A clone without
 * the cache, such as CI, scans everything. Within a scan, repeated normalized
 * blocks and their incoming token context share verdicts across snapshots.
 */
import { execFileSync } from "node:child_process";
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
	Bun.CryptoHasher.hash("sha256", data, "hex");

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
	const scan = createDemoIdentityScanner(hashes);
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
			const found = scan(path, bytes.toString("utf8"));
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
	return createDemoIdentityScanner(hashes)(path, source);
}

/** Reuse phrase verdicts across snapshots, including when the content cache is cold. */
export function createDemoIdentityScanner(
	hashes: readonly IdentityHash[] = denylist,
	digest: (phrase: string) => string = sha256,
): (path: string, source: string) => string[] {
	const byLength = new Map<number, Set<string>>();
	for (const { words, sha256 } of hashes) {
		if (!byLength.has(words)) byLength.set(words, new Set());
		byLength.get(words)!.add(sha256);
	}
	const carryLength = Math.max(1, ...byLength.keys()) - 1;
	// Long windows are mostly unique; hashing costs less than caching their strings.
	const phraseCaches = new Map(
		[...byLength.keys()]
			.filter((length) => length <= 2)
			.map((length) => [length, new Map<string, boolean>()]),
	);
	const blocks = new Map<
		string,
		{
			tail: string[];
			tailKey: string;
			tailLines: number[];
			findings: number[];
		}
	>();
	let blockChars = 0;
	return (path, source) => {
		const decoded = source.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
			String.fromCharCode(parseInt(hex, 16)),
		);

		const lines = new Set<number>();
		let prefix: string[] = [];
		let prefixKey = "";
		let carryLines: number[] = [];
		let firstLine = 0;
		let blockStart = 0;
		let lineStart = 0;
		for (let line = 0; lineStart <= decoded.length; line++) {
			const newline = decoded.indexOf("\n", lineStart);
			const end = newline < 0 ? decoded.length : newline;
			const length = end - lineStart;
			lineStart = newline < 0 ? decoded.length + 1 : newline + 1;
			// Content-defined boundaries survive inserted lines in successive snapshots.
			// Every line is included; the boundary only chooses a memoization unit.
			if (length % 32 !== 0 && newline >= 0) continue;
			const blockSource = decoded.slice(blockStart, end);
			const key = prefixKey + "\0" + blockSource;
			let block = blocks.get(key);
			if (!block) {
				const tokens = [...prefix];
				// Negative offsets refer to incoming tokens; nonnegative offsets are block lines.
				const tokenLines = prefix.map((_, index) => -index - 1);
				// Newlines are normalization and case-context boundaries.
				const sourceLines = blockSource
					.normalize("NFKC")
					.toLowerCase()
					.split("\n");
				for (let row = 0; row < sourceLines.length; row++) {
					for (const match of sourceLines[row]!.matchAll(/[\p{L}\p{N}]+/gu)) {
						tokens.push(match[0]);
						tokenLines.push(row);
					}
				}
				const findings = new Set<number>();
				for (let end = prefix.length; end < tokens.length; end++) {
					for (const [length, digests] of byLength) {
						const start = end - length + 1;
						if (start < 0) continue;
						const phrase = tokens.slice(start, end + 1).join(" ");
						const verdicts = phraseCaches.get(length);
						let found = verdicts?.get(phrase);
						if (found === undefined) {
							found = digests.has(digest(phrase));
							if (verdicts) {
								if (verdicts.size >= 100_000) verdicts.clear();
								verdicts.set(phrase, found);
							}
						}
						if (found) findings.add(tokenLines[start]!);
					}
				}
				const tail = carryLength === 0 ? [] : tokens.slice(-carryLength);
				block = {
					tail,
					tailKey: tail.join(" "),
					tailLines: carryLength === 0 ? [] : tokenLines.slice(-carryLength),
					findings: [...findings],
				};
				// Eviction only repeats work; arbitrary inputs cannot grow the cache forever.
				if (key.length <= 32_000_000) {
					while (blockChars + key.length > 32_000_000) {
						const oldest = blocks.keys().next().value!;
						blocks.delete(oldest);
						blockChars -= oldest.length;
					}
					blocks.set(key, block);
					blockChars += key.length;
				}
			} else {
				blocks.delete(key);
				blocks.set(key, block);
			}
			const absoluteLine = (offset: number) =>
				offset < 0 ? carryLines[-offset - 1]! : firstLine + offset + 1;
			for (const offset of block.findings) lines.add(absoluteLine(offset));
			carryLines = block.tailLines.map(absoluteLine);
			prefix = block.tail;
			prefixKey = block.tailKey;
			firstLine = line + 1;
			blockStart = lineStart;
		}

		return [...lines]
			.sort((a, b) => a - b)
			.map((line) => `${path}:${line}: use a fictional sample identity`);
	};
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
