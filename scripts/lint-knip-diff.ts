#!/usr/bin/env bun
/**
 * `lint:knip:diff` rejects new dead code against knip-baseline.json. Findings
 * use path, symbol and type so moving lines does not create debt. Run
 * `lint:knip:baseline` after fixing findings to shrink the baseline; it refuses
 * additions once a baseline exists. Config handles runtime/CSS/tooling entries.
 * This expensive check belongs in lint:deep, not the pre-push gate. Tests run
 * with `bun run test:run` (the root scripts suite).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Finding = { path: string; symbol: string; type: string };

function key(finding: Finding): string {
	return JSON.stringify([finding.path, finding.symbol, finding.type]);
}

function sorted(findings: Finding[]): Finding[] {
	return [
		...new Map(findings.map((finding) => [key(finding), finding])).values(),
	].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function normalizeReport(report: unknown): Finding[] {
	if (
		!report ||
		typeof report !== "object" ||
		!("issues" in report) ||
		!Array.isArray(report.issues)
	) {
		throw new Error("Invalid Knip JSON: expected issues array");
	}
	const findings: Finding[] = [];
	for (const row of report.issues) {
		if (!row || typeof row !== "object" || typeof row.file !== "string") {
			throw new Error("Invalid Knip issue file");
		}
		for (const [type, values] of Object.entries(row)) {
			if (type === "file" || type === "owners") continue;
			if (!Array.isArray(values))
				throw new Error(`Invalid Knip issue type: ${type}`);
			for (const value of values.flat()) {
				if (
					!value ||
					typeof value.name !== "string" ||
					(value.namespace !== undefined && typeof value.namespace !== "string")
				) {
					throw new Error(`Invalid Knip symbol: ${type}`);
				}
				findings.push({
					path: row.file.replaceAll("\\", "/").replace(/^\.\//, ""),
					symbol: value.namespace
						? `${value.namespace}.${value.name}`
						: value.name,
					type,
				});
			}
		}
	}
	return sorted(findings);
}

export function readBaseline(value: unknown): Finding[] {
	if (
		!Array.isArray(value) ||
		!value.every(
			(finding) =>
				finding &&
				typeof finding.path === "string" &&
				typeof finding.symbol === "string" &&
				typeof finding.type === "string" &&
				Object.keys(finding).length === 3,
		)
	) {
		throw new Error(
			"Invalid knip-baseline.json: expected path, symbol, type entries",
		);
	}
	return sorted(value);
}

export function diffFindings(current: Finding[], baseline: Finding[]) {
	const currentKeys = new Set(current.map(key));
	const baselineKeys = new Set(baseline.map(key));
	return {
		added: sorted(current.filter((finding) => !baselineKeys.has(key(finding)))),
		removed: sorted(
			baseline.filter((finding) => !currentKeys.has(key(finding))),
		),
	};
}

export function parseKnipResult(stdout: string, exitCode: number): Finding[] {
	if (exitCode !== 0 && exitCode !== 1)
		throw new Error(`Knip failed with exit ${exitCode}`);
	const findings = normalizeReport(JSON.parse(stdout));
	if ((exitCode === 1) !== findings.length > 0) {
		throw new Error(`Knip exit ${exitCode} disagrees with its JSON findings`);
	}
	return findings;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--baseline")) {
		throw new Error("Usage: bun scripts/lint-knip-diff.ts [--baseline]");
	}
	const root = fileURLToPath(new URL("../", import.meta.url));
	const baselineFile = Bun.file(`${root}knip-baseline.json`);
	const update = args[0] === "--baseline";
	const baseline = existsSync(baselineFile.name!)
		? readBaseline(await baselineFile.json())
		: undefined;
	if (!baseline && !update)
		throw new Error(
			"Missing knip-baseline.json; restore the committed baseline",
		);
	const child = Bun.spawn(
		[
			process.execPath,
			"run",
			"lint:knip",
			"--reporter",
			"json",
			"--no-progress",
		],
		{
			cwd: root,
			stdout: "pipe",
			stderr: "inherit",
		},
	);
	const [stdout, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	const current = parseKnipResult(stdout, exitCode);
	const { added, removed } = diffFindings(current, baseline ?? current);
	for (const finding of added)
		console.error(`NEW ${finding.type}: ${finding.path} ${finding.symbol}`);
	for (const finding of removed)
		console.log(
			`Removed ${finding.type}: ${finding.path} ${finding.symbol}; you may shrink the baseline`,
		);
	if (added.length) {
		console.error(
			`${added.length} new Knip findings; fix code or configuration before updating the baseline.`,
		);
		return 1;
	}
	if (update) {
		await Bun.write(baselineFile, `${JSON.stringify(current, null, "\t")}\n`);
		console.log(`Wrote ${current.length} findings to knip-baseline.json`);
	} else {
		console.log(
			`Knip differential check passed: ${current.length} existing findings, ${removed.length} removed.`,
		);
	}
	return 0;
}

if (import.meta.main) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
