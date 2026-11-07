#!/usr/bin/env bun
/**
 * Move every workspace's data out of the shared database into its own
 * workspace object, and prove the copy. See README.md for the runbook link.
 *
 *   bun scripts/migrate-workspaces/cli.ts export    --snapshot main.sql [--logs logs-1.sql ...] --assignments assignments.json --bundles <dir|r2://bucket/prefix>
 *   bun scripts/migrate-workspaces/cli.ts import    --bundles <dir|r2://...> (--objects <dir> | --remote <url>)
 *   bun scripts/migrate-workspaces/cli.ts reconcile --bundles <dir|r2://...> (--objects <dir> | --remote <url>) [--snapshot main.sql --logs ...] [--report report.json]
 *   bun scripts/migrate-workspaces/cli.ts rehearse  --snapshot main.sql [--logs ...] --assignments assignments.json [--work-dir <dir>] [--report report.json]
 *   bun scripts/migrate-workspaces/cli.ts schema-check --snapshot main.sql [--logs ...]
 *   bun scripts/migrate-workspaces/cli.ts assignments  --snapshot main.sql --out assignments.json
 *
 * `--remote` reads MIGRATE_WORKSPACES_TOKEN from the environment.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { proposeAssignments } from "./assignments";
import { openBundleStore, R2BundleStore } from "./bundle";
import { exportAll } from "./export";
import { importAll } from "./import";
import { reconcileAll, renderReport } from "./reconcile";
import { rehearse, renderRehearsal } from "./rehearse";
import { checkSchema, renderSchemaCheck } from "./schema-check";
import { Snapshot } from "./source";
import type { WorkspaceAssignments } from "./tables";
import {
	localStoreFactory,
	remoteStoreFactory,
	type WorkspaceStoreFactory,
} from "./target";

export interface ParsedArgs {
	command: string;
	flags: Record<string, string | string[] | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const [command = "", ...rest] = argv;
	const flags: ParsedArgs["flags"] = {};
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i]!;
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
		const name = arg.slice(2);
		const next = rest[i + 1];
		if (next === undefined || next.startsWith("--")) {
			flags[name] = true;
			continue;
		}
		if (name === "logs") {
			const values: string[] = [];
			while (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--"))
				values.push(rest[++i]!);
			flags[name] = [
				...((flags[name] as string[] | undefined) ?? []),
				...values,
			];
			continue;
		}
		flags[name] = next;
		i += 1;
	}
	return { command, flags };
}

function text(flags: ParsedArgs["flags"], name: string): string | undefined {
	const value = flags[name];
	return typeof value === "string" ? value : undefined;
}

function required(flags: ParsedArgs["flags"], name: string): string {
	const value = text(flags, name);
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

function openSnapshot(flags: ParsedArgs["flags"]): Snapshot | undefined {
	const main = text(flags, "snapshot");
	if (!main) return undefined;
	const logs = flags.logs;
	return Snapshot.open({ main, logs: Array.isArray(logs) ? logs : [] });
}

function readAssignments(flags: ParsedArgs["flags"]): WorkspaceAssignments {
	const path = text(flags, "assignments");
	return path
		? (JSON.parse(readFileSync(path, "utf8")) as WorkspaceAssignments)
		: {};
}

function openStores(
	flags: ParsedArgs["flags"],
	env: NodeJS.ProcessEnv,
): WorkspaceStoreFactory {
	const remote = text(flags, "remote");
	if (remote) {
		const token = env.MIGRATE_WORKSPACES_TOKEN;
		if (!token) throw new Error("Set MIGRATE_WORKSPACES_TOKEN for --remote");
		return remoteStoreFactory(remote, token);
	}
	return localStoreFactory(required(flags, "objects"));
}

export async function main(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	out: (line: string) => void = console.log,
): Promise<number> {
	const { command, flags } = parseArgs(argv);
	const reportPath = text(flags, "report");
	switch (command) {
		case "export": {
			const snapshot = openSnapshot(flags);
			if (!snapshot) throw new Error("--snapshot is required");
			const bundles = openBundleStore(required(flags, "bundles"));
			try {
				const results = await exportAll(
					snapshot,
					bundles,
					readAssignments(flags),
					(r) =>
						out(
							`exported ${r.organizationId}/${r.workspaceId} rows=${Object.values(r.manifest.tables).reduce((n, t) => n + t.count, 0)} ${r.ms.toFixed(0)}ms`,
						),
				);
				if (bundles instanceof R2BundleStore)
					await bundles.writeIndex(
						results.map(({ organizationId, workspaceId }) => ({
							organizationId,
							workspaceId,
						})),
					);
				out(`exported ${results.length} workspaces`);
			} finally {
				snapshot.close();
			}
			return 0;
		}
		case "import": {
			const results = await importAll(
				openBundleStore(required(flags, "bundles")),
				openStores(flags, env),
				(r) =>
					out(
						`imported ${r.organizationId}/${r.workspaceId} rows=${r.imported} skipped=${r.duplicates} ${r.ms.toFixed(0)}ms`,
					),
			);
			out(`imported ${results.length} workspaces`);
			return 0;
		}
		case "reconcile": {
			const snapshot = openSnapshot(flags);
			try {
				const report = await reconcileAll(
					openBundleStore(required(flags, "bundles")),
					openStores(flags, env),
					{
						snapshot,
						requiredJurisdiction:
							flags["allow-any-jurisdiction"] === true ? null : undefined,
					},
				);
				out(renderReport(report));
				if (reportPath)
					writeFileSync(reportPath, JSON.stringify(report, null, "\t"));
				return report.ok ? 0 : 1;
			} finally {
				snapshot?.close();
			}
		}
		case "rehearse": {
			const snapshot = openSnapshot(flags);
			if (!snapshot) throw new Error("--snapshot is required");
			try {
				const report = await rehearse(snapshot, readAssignments(flags), {
					workDir: text(flags, "work-dir"),
					keep: flags.keep === true,
					log: out,
				});
				out(renderRehearsal(report));
				if (reportPath)
					writeFileSync(reportPath, JSON.stringify(report, null, "\t"));
				return report.ok ? 0 : 1;
			} finally {
				snapshot.close();
			}
		}
		case "schema-check": {
			const snapshot = openSnapshot(flags);
			if (!snapshot) throw new Error("--snapshot is required");
			try {
				const report = checkSchema(snapshot);
				out(renderSchemaCheck(report));
				if (reportPath)
					writeFileSync(reportPath, JSON.stringify(report, null, "\t"));
				return report.ok ? 0 : 1;
			} finally {
				snapshot.close();
			}
		}
		case "assignments": {
			const snapshot = openSnapshot(flags);
			if (!snapshot) throw new Error("--snapshot is required");
			try {
				const proposal = proposeAssignments(snapshot);
				writeFileSync(
					required(flags, "out"),
					JSON.stringify(proposal.assignments, null, "\t"),
				);
				out(
					`proposed homes for ${Object.keys(proposal.assignments).length} organizations`,
				);
				for (const org of proposal.withoutWorkspace)
					out(`no workspace to place rows of organization ${org}`);
				return proposal.withoutWorkspace.length ? 1 : 0;
			} finally {
				snapshot.close();
			}
		}
		default:
			out(
				"usage: cli.ts export|import|reconcile|rehearse|schema-check|assignments [flags]; see the file header",
			);
			return 2;
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}
