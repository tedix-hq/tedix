#!/usr/bin/env bun

import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { workspaceInstallationManifest } from "./workspace-example";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--check")) {
	throw new Error("Only --check is supported when generating tracked examples");
}
for (const worker of workspaceInstallationManifest.workers) {
	const directory = worker.sourceConfig.slice(
		0,
		worker.sourceConfig.lastIndexOf("/"),
	);
	const result = spawnSync(
		process.execPath,
		[
			resolve(import.meta.dirname, "wrangler-overlay-cli.ts"),
			"--worker",
			worker.id,
			"--out",
			`${directory}/wrangler.oss-example.json`,
			"--secrets-out",
			`${directory}/wrangler.oss-example.secrets.json`,
			...args,
		],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
