#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCloudflareCliToken } from "./cli-auth";
import { parseInstallationManifest } from "./schema";
import { developerInstallationManifest } from "./developer-example";
import {
	provisionCloudflareResources,
	renderProvisionReport,
} from "./provision";

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
		if (argument === "--json" || argument === "--apply") continue;
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
			"Usage: provision --manifest <path> [--apply] [--json] [--api-base <url>]\nPlans by default; --apply provisions resources, not a complete deployed installation. Uses CLOUDFLARE_API_TOKEN when set; otherwise your bunx wrangler login. Interactive OS apply reads OS_URL, DESCOPE_PROJECT_ID and optional DESCOPE_BASE_URL from the manifest OS worker vars; supply only DESCOPE_MANAGEMENT_KEY through the environment.",
		);
		return;
	}
	validateArguments(args);
	const manifest = parseInstallationManifest(
		readManifest(option(args, "--manifest")),
	);
	const apiToken = await resolveCloudflareCliToken();
	const report = await provisionCloudflareResources({
		manifest,
		apiToken,
		mode: args.includes("--apply") ? "apply" : "plan",
		apiBaseUrl: option(args, "--api-base"),
		...(args.includes("--apply") && process.env.DESCOPE_MANAGEMENT_KEY
			? {
					identity: {
						managementKey: process.env.DESCOPE_MANAGEMENT_KEY,
					},
				}
			: {}),
	});
	process.stdout.write(
		args.includes("--json")
			? `${JSON.stringify(report, null, "\t")}\n`
			: renderProvisionReport(report),
	);
	if (!report.ok) process.exitCode = 1;
}

await run();
