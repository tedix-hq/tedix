#!/usr/bin/env bun

import {
	preflightDescopeIdentity,
	renderIdentityReadinessReport,
} from "./identity-readiness";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function validateArguments(args: string[]): void {
	const valueOptions = new Set([
		"--base-url",
		"--flow-id",
		"--os-url",
		"--management-api-base",
		"--project-id",
	]);
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--json") continue;
		if (!argument || !valueOptions.has(argument)) {
			throw new Error(`unknown option: ${argument}`);
		}
		index++;
	}
}

function required(value: string | undefined, message: string): string {
	if (!value?.trim()) throw new Error(message);
	return value.trim();
}

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	validateArguments(args);
	const report = await preflightDescopeIdentity({
		projectId: required(
			option(args, "--project-id") ?? process.env.DESCOPE_PROJECT_ID,
			"DESCOPE_PROJECT_ID or --project-id is required",
		),
		managementKey: required(
			process.env.DESCOPE_MANAGEMENT_KEY,
			"DESCOPE_MANAGEMENT_KEY is required; the value is never printed",
		),
		osUrl: required(
			option(args, "--os-url") ?? process.env.TEDIX_OS_URL,
			"TEDIX_OS_URL or --os-url is required",
		),
		baseUrl: option(args, "--base-url") ?? process.env.DESCOPE_BASE_URL,
		managementApiBaseUrl: option(args, "--management-api-base"),
		flowId: option(args, "--flow-id"),
	});
	process.stdout.write(
		args.includes("--json")
			? `${JSON.stringify(report, null, "\t")}\n`
			: renderIdentityReadinessReport(report),
	);
	if (!report.ok) process.exitCode = 1;
}

await run();
