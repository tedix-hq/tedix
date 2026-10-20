#!/usr/bin/env bun
/** Reject known private identities in sample text without publishing the names. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import denylist from "./demo-identity-hashes.json";

type IdentityHash = { words: number; sha256: string };

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
	const findings = paths
		.filter(isDemoIdentityPath)
		.filter((path) => existsSync(join(root, path)))
		.flatMap((path) => {
			const bytes = readFileSync(join(root, path));
			if (bytes.includes(0)) return [];
			return demoIdentityFindings(path, bytes.toString("utf8"));
		});
	for (const finding of findings) console.error(finding);
	console.log(`Demo identities: ${findings.length} findings`);
	if (findings.length) process.exitCode = 1;
}
