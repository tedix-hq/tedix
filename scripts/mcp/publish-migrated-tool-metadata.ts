import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	parseWranglerJson,
	runWrangler,
} from "../../packages/db/scripts/wrangler-command";

const API_ROOT = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const DB_CONFIG = fileURLToPath(
	new URL("../../packages/db/wrangler.jsonc", import.meta.url),
);
const API_CONFIG = `${API_ROOT}wrangler.jsonc`;

function config(source: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value: unknown = parse(source, errors, { allowTrailingComma: true });
	if (errors.length || !isRecord(value))
		throw new Error("Invalid publication configuration");
	return value;
}

export function toolPublicationTarget(dbSource: string, apiSource: string) {
	const db = config(dbSource);
	const base = config(apiSource);
	const production =
		isRecord(base.env) && isRecord(base.env.production)
			? base.env.production
			: {};
	const api = { ...base, ...production };
	const binding = (value: unknown, name: string) =>
		Array.isArray(value)
			? value.find(
					(row): row is Record<string, unknown> =>
						isRecord(row) && row.binding === name,
				)
			: undefined;
	const database = binding(db.d1_databases, "DB");
	const apiDatabase = binding(production.d1_databases, "DB");
	const workflow = binding(production.workflows, "TOOL_SCHEMA_SYNC_WORKFLOW");
	if (
		typeof database?.database_id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			database.database_id,
		) ||
		database.database_id === "00000000-0000-0000-0000-000000000000" ||
		apiDatabase?.database_id !== database.database_id ||
		(db.account_id && api.account_id && db.account_id !== api.account_id) ||
		typeof workflow?.name !== "string" ||
		!/^[a-zA-Z0-9_-]+$/.test(workflow.name) ||
		workflow.class_name !== "ToolSchemaSyncWorkflow"
	) {
		throw new Error(
			"Publication workflow and migration DB must use the same explicit installation binding",
		);
	}
	return { workflowName: workflow.name };
}

/** Called by the ordinary migration command; there is no operator publication flag. */
export function publishMigratedToolMetadata(
	expectedName: string,
	freshMigration: boolean,
	options: {
		run?: typeof runWrangler;
		readConfig?: (path: string) => string;
		now?: () => number;
		wallNow?: () => number;
		wait?: (ms: number) => void;
		firstMigration?: string;
	} = {},
) {
	const run = options.run ?? runWrangler;
	const read =
		options.readConfig ?? ((path: string) => readFileSync(path, "utf8"));
	const now = options.now ?? (() => performance.now());
	const wallNow = options.wallNow ?? Date.now;
	const wait =
		options.wait ??
		((ms: number) =>
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
	const { workflowName } = toolPublicationTarget(
		read(DB_CONFIG),
		read(API_CONFIG),
	);
	const started = now();
	const deadline = started + 45_000;
	const remaining = () => {
		const ms = Math.floor(deadline - now());
		if (ms <= 0) throw new Error("Tool metadata publication deadline exceeded");
		return Math.min(ms, 15_000);
	};
	const firstName = (options.firstMigration ?? expectedName).replaceAll(
		"'",
		"''",
	);
	const ledger = parseWranglerJson(
		// remote-d1: runWrangler audits this bounded native-ledger read.
		run(
			[
				"d1",
				"execute",
				"DB",
				"--remote",
				"--config",
				DB_CONFIG,
				"--command",
				`SELECT id, name, (SELECT applied_at FROM tedix_drizzle_migrations WHERE name = '${firstName}') AS applied_at FROM tedix_drizzle_migrations ORDER BY id DESC LIMIT 1`,
				"--json",
			],
			{ timeoutMs: remaining() },
		),
		"Publication migration ledger",
	);
	const result =
		Array.isArray(ledger) && ledger.length === 1 ? ledger[0] : null;
	const row =
		isRecord(result) &&
		result.success === true &&
		Array.isArray(result.results) &&
		result.results.length === 1
			? result.results[0]
			: null;
	if (
		!isRecord(row) ||
		typeof row.id !== "number" ||
		!Number.isSafeInteger(row.id) ||
		row.id < 1 ||
		row.name !== expectedName
	) {
		throw new Error(
			"Publication migration revision does not match the verified ledger",
		);
	}
	const appliedAt =
		typeof row.applied_at === "string" &&
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.applied_at)
			? Date.parse(`${row.applied_at.replace(" ", "T")}Z`)
			: NaN;
	const expectedMigration = { id: row.id, name: expectedName };
	// An old worker treats this as a dry run. Its result cannot satisfy the
	// protocol check below, so preflight refuses SQL before risking stale schemas.
	const payload = {
		kind: "publish_tool_metadata",
		mode: "schema",
		apply: false,
		expectedMigration,
	};
	const invoke = (args: string[]) =>
		run(["workflows", ...args, "--config", API_CONFIG, "--env", "production"], {
			cwd: API_ROOT,
			timeoutMs: remaining(),
		});
	const triggered = invoke(["trigger", workflowName, JSON.stringify(payload)]);
	const ids = [...triggered.matchAll(/Workflow instance "([a-f0-9-]{36})"/gi)];
	const instanceId = ids[0]?.[1];
	if (ids.length !== 1 || !instanceId)
		throw new Error("Publication workflow instance was not acknowledged");
	for (;;) {
		const value = parseWranglerJson(
			invoke(["instances", "describe", workflowName, instanceId, "--json"]),
			"Publication workflow",
		);
		remaining();
		if (!isRecord(value) || value.id !== instanceId || value.error != null)
			throw new Error("Publication workflow identity or execution failed");
		if (value.status === "complete") {
			const steps = Array.isArray(value.steps)
				? value.steps.filter(
						(step) =>
							isRecord(step) &&
							step.name === "publish migrated tool metadata-1",
					)
				: [];
			const step = steps.length === 1 && isRecord(steps[0]) ? steps[0] : null;
			let proof: unknown = step?.output;
			if (typeof proof === "string")
				proof = parseWranglerJson(proof, "Publication receipt");
			if (
				value.success !== true ||
				step?.success !== true ||
				!isRecord(proof) ||
				proof.publicationProtocol !== 1 ||
				proof.schemaWrites !== 0 ||
				typeof proof.published !== "boolean" ||
				step.type !== "step" ||
				typeof proof.activationEpoch !== "string" ||
				!proof.activationEpoch ||
				!isRecord(proof.migration) ||
				proof.migration.id !== row.id ||
				proof.migration.name !== expectedName
			) {
				throw new Error(
					"Active workflow does not acknowledge publication-only protocol; install it before migrating",
				);
			}
			const age = wallNow() - appliedAt;
			const withinWindow =
				!freshMigration || (Number.isFinite(age) && age >= 0 && age < 60_000);
			console.log(
				JSON.stringify({
					event: "tool_metadata_publication_activated",
					instanceId,
					freshMigration,
					withinWindow,
					elapsedMs: now() - started,
				}),
			);
			// Still activate a late migration; report its missed bound instead of
			// leaving the gateway stale or claiming that release timing passed.
			if (!withinWindow)
				throw new Error(
					"Migration publication is outside the one-minute window",
				);
			return { instanceId, activationEpoch: proof.activationEpoch };
		}
		if (!["queued", "running", "waiting"].includes(String(value.status)))
			throw new Error("Publication workflow did not complete");
		const pause = Math.min(2_000, remaining());
		wait(pause);
	}
}
