#!/usr/bin/env bun
/** Keep local session ingestion and Attention independent of installation identities. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE =
	/(?:^|\/)(?:__tests__|__fixtures__|fixtures|test|eval|review)(?:\/|$)|\.(?:test|spec)\.[^/]+$|(?:precision|submission|validation|cases).*\.json$/;
const SESSION_PATH =
	/(?:agent-session|agent-status|request-ledger|work-attention|work-shell|work-needs-you|work-project-contributors|work-portfolio-page|session-activity|living-status-board|\/lane\.|\/hooks\/)/;
const IDENTITY =
	/\b(?:Lead|Aaron)\b|ff227ab0|\borg_tedix\b|[Nn]ight [Ss]hift|\bBerlin\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

// Existing platform views are a bounded migration inventory. New views are apps.
const PLATFORM_WORK_ROUTES = new Set([
	"",
	"attention",
	"needs-you",
	"portfolio",
	"queue",
	"agents",
	"office",
	"attempts",
	"approvals",
	"interactions",
	"cases",
	"graph",
	"clusters",
	"admission",
	"capacity",
	"recovery",
	"control",
	"executions/$runId",
	"items/$workItemId",
	"projects/$projectId",
	"interactions/$requestId",
	"runs/$runId",
	"cases/$caseId",
]);
const PLATFORM_BOARD_SECTIONS = new Set([
	"projects",
	"queue",
	"agents",
	"office",
]);

export function boardGenericityFindings(
	path: string,
	source: string,
): string[] {
	if (FIXTURE.test(path) || !path.startsWith("apps/os/src/")) return [];
	const findings: string[] = [];
	for (const match of source.matchAll(
		/createFileRoute\(\s*["']\/_session\/_tenant\/work\/([^"']*)["']/g,
	)) {
		if (!PLATFORM_WORK_ROUTES.has(match[1]!))
			findings.push(
				`${path}: fixed Work route ${match[1]}; configure a workspace app instead`,
			);
	}
	if (path.endsWith("/work-shell.tsx")) {
		const board =
			/id:\s*["']board["'][\s\S]*?sections:\s*\[([\s\S]*?)\]/.exec(
				source,
			)?.[1] ?? "";
		for (const match of board.matchAll(/id:\s*["']([^"']+)["']/g))
			if (!PLATFORM_BOARD_SECTIONS.has(match[1]!))
				findings.push(
					`${path}: fixed Board view ${match[1]}; use the configured app renderer`,
				);
	}
	return findings;
}

export function sessionGenericityFindings(
	path: string,
	source: string,
): string[] {
	if (FIXTURE.test(path)) return [];
	if (path.startsWith("packages/db/drizzle/")) return [];
	if (!/^(?:apps|packages|plugins)\//.test(path)) return [];
	const board = boardGenericityFindings(path, source);
	// Public founder/legal pages and unrelated product concepts have their own vocabulary.
	if (
		!SESSION_PATH.test(path) &&
		!(path.startsWith("plugins/tedix/") && path.endsWith(".md"))
	)
		return board;
	return [
		...board,
		...source.split("\n").flatMap((line, index) => {
			const match = IDENTITY.exec(line);
			if (!match) return [];
			return [
				`${path}:${index + 1}: installation-specific identifier ${match[0]}`,
			];
		}),
	];
}

if (import.meta.main) {
	const paths = execFileSync(
		"git",
		[
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"-z",
			"apps",
			"packages",
			"plugins",
		],
		{ cwd: ROOT, encoding: "utf8" },
	)
		.split("\0")
		.filter(Boolean);
	const findings = paths
		.filter(
			(path) =>
				/\.(?:[cm]?[jt]sx?|md|json)$/.test(path) &&
				existsSync(join(ROOT, path)),
		)
		.flatMap((path) =>
			sessionGenericityFindings(path, readFileSync(join(ROOT, path), "utf8")),
		);
	if (findings.length) {
		console.error(findings.join("\n"));
		process.exit(1);
	}
	console.log(
		"Session genericity OK: no installation identities in session features.",
	);
}
