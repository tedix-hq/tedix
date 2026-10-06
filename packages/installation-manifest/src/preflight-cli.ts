#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCloudflareCliToken } from "./cli-auth";
import { parseInstallationManifest } from "./schema";
import { developerInstallationManifest } from "./developer-example";
import { preflightCloudflareAccount, renderPreflightReport } from "./preflight";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}

function validateArguments(args: string[]): void {
	const valueOptions = new Set(["--api-base", "--manifest"]);
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument && seen.has(argument))
			throw new Error(`duplicate option: ${argument}`);
		if (argument) seen.add(argument);
		if (argument === "--json") continue;
		if (!argument || !valueOptions.has(argument)) {
			throw new Error(`unknown option: ${argument}`);
		}
		option(args, argument);
		index++;
	}
}

function readManifest(path: string | undefined): unknown {
	return path
		? JSON.parse(readFileSync(resolve(path), "utf8"))
		: developerInstallationManifest;
}

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(
			"Usage: preflight --manifest <path> [--json] [--api-base <url>]\nRead-only account checks. Uses CLOUDFLARE_API_TOKEN when set; otherwise your bunx wrangler login. No Tedix account is required.",
		);
		return;
	}
	validateArguments(args);
	const manifest = parseInstallationManifest(
		readManifest(option(args, "--manifest")),
	);
	const apiToken = await resolveCloudflareCliToken();
	const report = await preflightCloudflareAccount({
		manifest,
		apiToken,
		apiBaseUrl: option(args, "--api-base"),
	});
	process.stdout.write(
		args.includes("--json")
			? `${JSON.stringify(report, null, "\t")}\n`
			: renderPreflightReport(report),
	);
	if (!report.ok) process.exitCode = 1;
}

await run();
