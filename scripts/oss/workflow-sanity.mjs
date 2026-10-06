#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflowDirectory = ".github/workflows";
const errors = [];

for (const name of readdirSync(workflowDirectory).sort()) {
	if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
	const path = join(workflowDirectory, name);
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line.includes("\t")) errors.push(`${path}:${index + 1}: tab character`);
		if (/^(<{7}|={7}|>{7})/.test(line)) {
			errors.push(`${path}:${index + 1}: merge conflict marker`);
		}
	}
	if (
		text.includes("pull_request_target") &&
		/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(?:ref|sha)\s*\}\}/.test(
			text,
		)
	) {
		errors.push(
			`${path}: pull_request_target must not check out pull request head code`,
		);
	}
	const jobsAt = text.indexOf("\njobs:\n");
	if (jobsAt === -1) continue;
	const jobHeads = [...text.matchAll(/^ {2}([a-z][a-zA-Z0-9_-]*):$/gm)].filter(
		(match) => (match.index ?? 0) > jobsAt,
	);
	for (const [index, head] of jobHeads.entries()) {
		const start = head.index ?? 0;
		const end = jobHeads[index + 1]?.index ?? text.length;
		const body = text.slice(start, end);
		if (/^\s+uses: \.\/\.github\/workflows\//m.test(body)) continue;
		if (!/^\s+timeout-minutes:/m.test(body)) {
			errors.push(`${path}: job ${head[1]} has no timeout-minutes`);
		}
	}
}

if (errors.length > 0) {
	console.error("Workflow sanity checks failed:");
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log("Workflow sanity checks passed.");
