#!/usr/bin/env bun
/**
 * Move every workspace's data out of the shared database into its own
 * workspace object, and prove the copy. See README.md for the runbook link.
 *
 *   bun scripts/migrate-workspaces/cli.ts export    --snapshot main.sql --logs logs-1.sql ... [--assignments assignments.json] --bundles <dir|r2://bucket/prefix> [--scope org/ws,...]
 *   bun scripts/migrate-workspaces/cli.ts import    --bundles <dir|r2://...> (--objects <dir> | --remote <url> --snapshot main.sql --logs ...) [--scope org/ws,...] [--merge-object-owned org/ws,... [--plan-only]]
 *   bun scripts/migrate-workspaces/cli.ts reconcile --bundles <dir|r2://...> (--objects <dir> | --remote <url>) [--snapshot main.sql --logs ...] [--scope org/ws,...] [--approved decisions.json [--merge-object-owned org/ws,...]] [--report report.json]
 *   bun scripts/migrate-workspaces/cli.ts rehearse  --snapshot main.sql [--logs ...] --assignments assignments.json [--work-dir <dir>] [--report report.json]
 *   bun scripts/migrate-workspaces/cli.ts schema-check --snapshot main.sql [--logs ...]
 *   bun scripts/migrate-workspaces/cli.ts assignments  --snapshot main.sql --out assignments.json
 *
 * `--remote` reads MIGRATE_WORKSPACES_TOKEN from the environment, or with
 * `--auth tedix [--workspace <cli workspace>]` signs in as the Tedix platform
 * administrator stored by `tedix login` and goes through the MCP gateway's
 * /admin/migration door instead.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { capture, type CaptureConfig } from "./capture";
import { proposeAssignments } from "./assignments";
import { openBundleStore, R2BundleStore } from "./bundle";
import { exportAll } from "./export";
import { importAll } from "./import";
import {
	reconcileAll,
	renderReport,
	type ApprovedAccounting,
} from "./reconcile";
import { rehearse, renderRehearsal } from "./rehearse";
import { refKey, Scope } from "./scope";
import { checkSchema, renderSchemaCheck } from "./schema-check";
import { Snapshot, type WorkspaceRef } from "./source";
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

function readScope(flags: ParsedArgs["flags"]): Scope | undefined {
	const value = text(flags, "scope");
	return value ? Scope.parse(value) : undefined;
}

function readMergeScope(flags: ParsedArgs["flags"]): Scope | undefined {
	const value = text(flags, "merge-object-owned");
	if (flags["merge-object-owned"] === true)
		throw new Error("--merge-object-owned names the workspaces to merge");
	return value ? Scope.parse(value) : undefined;
}

/**
 * The owner's decision file for `reconcile --approved <file>`:
 * `{ "evidenceRef": "...", "workspaces": { "<org>/<ws>": { "objectNativeOutputIds": ["..."] } } }`.
 * Workspaces named by `--merge-object-owned` use the same reference.
 */
function readApprovedAccounting(
	flags: ParsedArgs["flags"],
): ((ref: WorkspaceRef) => ApprovedAccounting | undefined) | undefined {
	const merge = readMergeScope(flags);
	const path = text(flags, "approved");
	if (!path) {
		if (merge)
			throw new Error("--merge-object-owned needs --approved <decision file>");
		return undefined;
	}
	const file = JSON.parse(readFileSync(path, "utf8")) as {
		evidenceRef?: string;
		workspaces?: Record<string, { objectNativeOutputIds?: string[] }>;
	};
	if (!file.evidenceRef?.trim())
		throw new Error("The decision file needs an evidenceRef");
	const evidenceRef = file.evidenceRef;
	return (ref) => {
		const key = refKey(ref);
		const entry = file.workspaces?.[key];
		const mergeObjectOwned = merge?.keys.has(key) === true;
		if (!entry && !mergeObjectOwned) return undefined;
		return {
			evidenceRef,
			mergeObjectOwned,
			objectNativeOutputIds: entry?.objectNativeOutputIds ?? [],
		};
	};
}

function readAssignments(flags: ParsedArgs["flags"]): WorkspaceAssignments {
	const path = text(flags, "assignments");
	const snapshotPath = text(flags, "snapshot");
	if (!path && snapshotPath?.endsWith(".json"))
		return (
			JSON.parse(
				readFileSync(snapshotPath, "utf8"),
			) as import("./capture-manifest").CaptureManifest
		).assignments;
	return path
		? (JSON.parse(readFileSync(path, "utf8")) as WorkspaceAssignments)
		: {};
}

/** The stored Tedix login's request headers, refreshed by the CLI's own code. */
export async function tedixAdminHeaders(
	workspace: string,
): Promise<() => Promise<Record<string, string>>> {
	const { resolveStoredLoginAuth } =
		await import("../../packages/cli/src/auth-resolve.ts");
	const { auth, loginError } = await resolveStoredLoginAuth(workspace);
	if (!auth) {
		throw new Error(
			loginError ??
				`No stored Tedix login for workspace "${workspace}". Run: tedix login -w ${workspace}`,
		);
	}
	return async () => {
		const headers = {
			...auth.headers,
			...(auth.credentialProvider ? await auth.credentialProvider() : {}),
		};
		const token = (await auth.oauthProvider?.tokens())?.access_token;
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	};
}

export async function openStores(
	flags: ParsedArgs["flags"],
	env: NodeJS.ProcessEnv,
): Promise<WorkspaceStoreFactory> {
	const remote = text(flags, "remote");
	if (remote) {
		const authMode = text(flags, "auth") ?? "bearer";
		if (authMode === "tedix") {
			const headers = await tedixAdminHeaders(
				text(flags, "workspace") ?? "connect",
			);
			return remoteStoreFactory(remote, { mode: "tedix", headers });
		}
		if (authMode !== "bearer")
			throw new Error(`--auth must be "bearer" or "tedix", not "${authMode}"`);
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
		case "capture": {
			const config = JSON.parse(
				readFileSync(required(flags, "config"), "utf8"),
			) as CaptureConfig;
			const apiToken = env.CLOUDFLARE_API_TOKEN;
			if (!apiToken)
				throw new Error("Set CLOUDFLARE_API_TOKEN for read-only D1 capture");
			const manifest = await capture(config, required(flags, "out"), {
				apiToken,
				pageSize: Number(text(flags, "page-size") ?? 100),
				delayMs: Number(text(flags, "delay-ms") ?? 2000),
				delayFile: text(flags, "delay-file"),
				log: out,
			});
			out(JSON.stringify(manifest, null, 2));
			return 0;
		}
		case "export": {
			const snapshot = openSnapshot(flags);
			if (!snapshot) throw new Error("--snapshot is required");
			const bundles = openBundleStore(required(flags, "bundles"));
			try {
				const results = await exportAll(
					snapshot,
					bundles,
					readAssignments(flags),
					{
						scope: readScope(flags),
						onWorkspace: (r) =>
							out(
								`exported ${r.organizationId}/${r.workspaceId} rows=${Object.values(r.manifest.tables).reduce((n, t) => n + t.count, 0)} ${r.ms.toFixed(0)}ms`,
							),
					},
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
			const snapshot = openSnapshot(flags);
			try {
				const results = await importAll(
					openBundleStore(required(flags, "bundles")),
					await openStores(flags, env),
					{
						snapshot,
						scope: readScope(flags),
						mergeObjectOwned: readMergeScope(flags),
						mergePlanOnly: flags["plan-only"] === true,
						onWorkspace: (r) => {
							out(
								`imported ${r.organizationId}/${r.workspaceId} rows=${r.imported} skipped=${r.duplicates} ${r.ms.toFixed(0)}ms`,
							);
							if (!r.merge) return;
							for (const row of r.merge.toAdd)
								out(
									`      ${r.merge.planOnly ? "WOULD ADD" : "ADDED"} ${row.table} ${row.key}`,
								);
							for (const row of r.merge.objectWins)
								out(`      OBJECT WINS ${row.table} ${row.key}`);
							for (const row of r.merge.notAdded)
								out(`      NOT ADDED ${row.table} ${row.key}: ${row.reason}`);
							out(`      object-only rows kept: ${r.merge.objectOnly.length}`);
						},
					},
				);
				out(`imported ${results.length} workspaces`);
				return 0;
			} finally {
				snapshot?.close();
			}
		}
		case "reconcile": {
			const snapshot = openSnapshot(flags);
			try {
				const report = await reconcileAll(
					openBundleStore(required(flags, "bundles")),
					await openStores(flags, env),
					{
						snapshot,
						scope: readScope(flags),
						approvedAccounting: readApprovedAccounting(flags),
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
