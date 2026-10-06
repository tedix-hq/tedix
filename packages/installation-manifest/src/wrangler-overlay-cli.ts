#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { developerInstallationManifest } from "./developer-example";
import type { InstallationManifest } from "./schema";
import { readWorkerSourceConfig } from "./worker-source-config";
import {
	createWranglerOverlay,
	renderWranglerSecretNames,
	type WranglerOverlayMode,
} from "./wrangler-overlay";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}

function requiredOption(args: string[], name: string): string {
	const value = option(args, name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function validateArguments(args: string[]): void {
	const valueOptions = new Set([
		"--manifest",
		"--mode",
		"--out",
		"--secrets-out",
		"--worker",
	]);
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--check") continue;
		if (!argument || !valueOptions.has(argument)) {
			throw new Error(`unknown option: ${argument}`);
		}
		index++;
	}
}

function readManifest(path: string | undefined): unknown {
	return path
		? JSON.parse(readFileSync(resolve(path), "utf8"))
		: developerInstallationManifest;
}

function workerSourcePath(manifest: unknown, workerId: string): string {
	const worker = (manifest as Partial<InstallationManifest>).workers?.find(
		(candidate) => candidate.id === workerId,
	);
	if (!worker) throw new Error(`worker ${workerId} is not declared`);
	return worker.sourceConfig;
}

function checkFile(path: string, expected: string): void {
	let actual: string;
	try {
		actual = readFileSync(resolve(path), "utf8");
	} catch {
		throw new Error(
			`${path} is missing; regenerate Wrangler overlay artifacts`,
		);
	}
	if (actual !== expected) {
		throw new Error(
			`${path} has drifted; regenerate Wrangler overlay artifacts`,
		);
	}
}

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	validateArguments(args);
	const workerId = requiredOption(args, "--worker");
	const output = requiredOption(args, "--out");
	const secretsOutput = requiredOption(args, "--secrets-out");
	const modeValue = option(args, "--mode") ?? "preview";
	if (modeValue !== "preview" && modeValue !== "deploy") {
		throw new Error(`invalid --mode: ${modeValue}`);
	}
	const manifest = readManifest(option(args, "--manifest"));
	const sourcePath = workerSourcePath(manifest, workerId);
	const result = createWranglerOverlay({
		manifest,
		mode: modeValue as WranglerOverlayMode,
		sourceConfig: await readWorkerSourceConfig(resolve(sourcePath)),
		workerId,
	});
	const secrets = renderWranglerSecretNames(workerId, result.requiredSecrets);
	if (args.includes("--check")) {
		checkFile(output, result.text);
		checkFile(secretsOutput, secrets);
		process.stdout.write(`${output} and ${secretsOutput} are current\n`);
		return;
	}
	writeFileSync(resolve(output), result.text);
	writeFileSync(resolve(secretsOutput), secrets);
	process.stdout.write(`${output}\n${secretsOutput}\n`);
}

await run();
