#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

/**
 * Drift gate: D1 `app_tools` schemas vs oRPC contract zod schemas.
 *
 * Source of truth: `packages/api-contract/src/contracts/`.
 * Target: every `app_tools` row on the tedix admin app with `transport='rpc'`.
 *
 * Input schemas are MCP JSON Schema root objects because tool calls pass named
 * argument objects. Output schemas match the shared SDK adapter: object results
 * stay direct; non-object results use its `{ data: value }` envelope.
 *
 * Modes:
 *   --apply            Repair D1 schemas directly through Wrangler D1, deleting
 *                      stale contract-backed RPC rows and updating drifted
 *                      input/output schema columns.
 *   --check            CI gate. Fails on any drift. Existing drift is not
 *                      tolerated; run ToolSchemaSyncWorkflow with
 *                      pruneStale=true for rows whose source contract was
 *                      intentionally removed.
 *   --dry-run          default — print diffs, never fail.
 *   --only=<id>[,...]  restrict to specific tool_ids (debugging).
 *
 * `--check` and `--dry-run` are read-only. Normal operator writes go through the
 * ToolSchemaSyncWorkflow exposed by Tedix admin MCP (`tool.run_tool_schema_sync`).
 * The deploy workflow runs that sync before this check and uses `--apply` as
 * the synchronous CI repair path because Cloudflare Workflow execution is
 * asynchronous.
 */

import {
	listContractEndpoints,
	resolveContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import {
	zodToStructuredOutputJsonSchema,
	zodToToolInputJsonSchema,
} from "@tedix/api-contract/utils/tool-json-schema";

const TEDIX_ADMIN_APP_SLUG = "tedix";
const TEDIX_APP_ID_SQL = `(SELECT id FROM apps WHERE slug = '${TEDIX_ADMIN_APP_SLUG}')`;
// The binding name resolves to whichever database apps/api/wrangler.jsonc binds.
const D1_DB = "DB";

const IGNORE_DRIFT: Record<string, string> = {};

const REQUIRED_PROJECTION_ENDPOINTS = [
	"workflows/listDefinitions",
	"skills/listPromotionCandidates",
	"skills/listWorkflowSchedules",
	"skills/proposeWorkflowImprovement",
	"skills/inspectWorkflowImprovement",
	"skills/activateWorkflowImprovement",
	"flywheelHealth/learningCurves",
	"flywheelHealth/getOrphanRunHealth",
	"memoryGraph/graph/path",
	"memoryGraph/graph/similar",
	"memoryGraph/graph/communities",
	"memoryGraph/graph/influence",
	"memoryGraph/graph/health",
	"memoryGraph/graph/sync",
	"memoryGraph/graph/maintenance",
	"memoryGraph/graph/maintenanceTaskStatus",
	"memoryGraph/graph/maintenanceTaskCancel",
	"memoryEntities/createEntity",
	"memoryEntities/recordMention",
	"memoryEntities/listCandidates",
	"memoryEntities/proposeResolution",
	"memoryEntities/proposeResolutionRollback",
	"memoryEntities/reviewResolution",
	"memoryEntities/getMentionResolution",
	"graphRetrievalBenchmarks/createSuite",
	"graphRetrievalBenchmarks/addCase",
	"graphRetrievalBenchmarks/lockSuite",
	"graphRetrievalBenchmarks/getSuite",
	"graphRetrievalBenchmarks/startPair",
	"graphRetrievalBenchmarks/recordObservation",
	"graphRetrievalBenchmarks/completeRun",
	"graphRetrievalBenchmarks/executePair",
	"graphRetrievalBenchmarks/evaluatePair",
	"graphRetrievalBenchmarks/getRun",
	"graphRetrievalBenchmarks/getGate",
] as const;

const argv = process.argv.slice(2);
const mode: "apply" | "check" | "dry-run" = argv.includes("--apply")
	? "apply"
	: argv.includes("--check")
		? "check"
		: "dry-run";
const onlyArg = argv.find((arg) => arg.startsWith("--only="));
const onlyFilter = onlyArg
	? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean))
	: null;

interface D1Row {
	id: string;
	tool_id: string;
	tool_type_id: string | null;
	schema_dialect: string | null;
	input_schema: string | null;
	output_schema: string | null;
	endpoint: string | null;
}

interface D1ToolState {
	id: string;
	toolId: string;
	toolTypeId: string | null;
	schemaDialect: string | null;
	inputSchema: unknown;
	outputSchema: unknown;
	endpoint: string | null;
}

async function fetchD1Rows(): Promise<D1ToolState[]> {
	const sql = `SELECT id, tool_id, tool_type_id, schema_dialect, json(input_schema) AS input_schema, json(output_schema) AS output_schema, json_extract(config, '$.endpoint') AS endpoint FROM app_tools WHERE app_id = ${TEDIX_APP_ID_SQL} AND json_extract(config, '$.transport') = 'rpc'`;
	const parsed = await executeD1(sql);
	return (parsed[0]?.results ?? []).map((row) => ({
		id: row.id,
		toolId: row.tool_id,
		toolTypeId: row.tool_type_id,
		schemaDialect: row.schema_dialect,
		inputSchema: row.input_schema ? JSON.parse(row.input_schema) : null,
		outputSchema: row.output_schema ? JSON.parse(row.output_schema) : null,
		endpoint: row.endpoint,
	}));
}

async function executeD1(sql: string): Promise<Array<{ results?: D1Row[] }>> {
	const proc = Bun.spawn(
		[
			"bunx",
			"wrangler",
			"d1",
			"execute",
			D1_DB,
			"--remote",
			"--config",
			fileURLToPath(new URL("../../apps/api/wrangler.jsonc", import.meta.url)),
			"--json",
			"--command",
			sql,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`wrangler d1 execute failed (${code}):\n${err}\n${out}`);
	}
	return JSON.parse(out) as Array<{ results?: D1Row[] }>;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}

function diff(
	toolId: string,
	column: "inputSchema" | "outputSchema",
	expected: unknown,
	actual: unknown,
): string {
	return [
		`--- D1 ${column} (${toolId}) ----------------------------------------`,
		JSON.stringify(actual, null, 2),
		`+++ contract ${column} (${toolId}) ----------------------------------`,
		JSON.stringify(expected, null, 2),
	].join("\n");
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sqlJson(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	return sqlString(JSON.stringify(value));
}

async function deleteStaleRow(row: D1ToolState): Promise<void> {
	await executeD1(
		`DELETE FROM app_tools WHERE id = ${sqlString(row.id)} AND app_id = ${TEDIX_APP_ID_SQL}`,
	);
}

async function updateSchemaRow(
	row: D1ToolState,
	patch: {
		inputSchema?: unknown;
		outputSchema?: unknown;
		toolTypeId?: "rpc";
		schemaDialect?: "json-schema-2020-12";
	},
): Promise<void> {
	const assignments: string[] = [];
	if (patch.inputSchema !== undefined) {
		assignments.push(`input_schema = ${sqlJson(patch.inputSchema)}`);
	}
	if (patch.outputSchema !== undefined) {
		assignments.push(`output_schema = ${sqlJson(patch.outputSchema)}`);
	}
	if (patch.toolTypeId) {
		assignments.push(`tool_type_id = ${sqlString(patch.toolTypeId)}`);
	}
	if (patch.schemaDialect) {
		assignments.push(`schema_dialect = ${sqlString(patch.schemaDialect)}`);
	}
	assignments.push(`schema_source = 'orpc'`);
	if (row.endpoint) {
		assignments.push(`schema_source_ref = ${sqlString(row.endpoint)}`);
	}
	const now = new Date().toISOString();
	assignments.push(`schema_synced_at = ${sqlString(now)}`);
	assignments.push(`updated_at = ${sqlString(now)}`);

	await executeD1(
		`UPDATE app_tools SET ${assignments.join(", ")} WHERE id = ${sqlString(row.id)} AND app_id = ${TEDIX_APP_ID_SQL}`,
	);
}

async function main() {
	console.log(
		`# Sync tool schemas — mode: ${mode}${onlyFilter ? ` (filter: ${[...onlyFilter].join(",")})` : ""}\n`,
	);
	const rows = await fetchD1Rows();
	const filtered = onlyFilter
		? rows.filter((row) => onlyFilter.has(row.toolId))
		: rows;

	const buckets = {
		inSync: [] as string[],
		missingSchema: [] as string[],
		realMismatch: [] as string[],
		converterUnsupported: [] as string[],
		noContract: [] as string[],
		missingProjection: [] as string[],
		typeDrift: [] as string[],
		ignored: [] as string[],
		applied: [] as string[],
	};

	if (!onlyFilter) {
		const rowEndpoints = new Set(
			rows
				.map((row) => row.endpoint)
				.filter((endpoint): endpoint is string => !!endpoint),
		);
		const contractEndpoints = new Set(
			listContractEndpoints({ includeInternal: true }).map(
				(endpoint) => `${endpoint.router}/${endpoint.procPath}`,
			),
		);
		for (const endpoint of REQUIRED_PROJECTION_ENDPOINTS) {
			if (!contractEndpoints.has(endpoint)) {
				buckets.noContract.push(
					`required projection endpoint "${endpoint}" is not in the contract router`,
				);
			} else if (!rowEndpoints.has(endpoint)) {
				buckets.missingProjection.push(
					`required projection endpoint "${endpoint}" has no tedix admin app_tools row`,
				);
			}
		}
	}

	filtered.sort((a, b) => a.toolId.localeCompare(b.toolId));

	for (const row of filtered) {
		if (!row.endpoint) {
			buckets.noContract.push(`${row.toolId}: config.endpoint is missing`);
			if (mode === "apply") {
				await deleteStaleRow(row);
				buckets.applied.push(`${row.toolId}: deleted missing-endpoint rpc row`);
			}
			continue;
		}
		const lookup = resolveContractEndpoint(row.endpoint);
		if (!lookup) {
			buckets.noContract.push(
				`${row.toolId}: no contract proc at "${row.endpoint}"`,
			);
			if (mode === "apply") {
				await deleteStaleRow(row);
				buckets.applied.push(`${row.toolId}: deleted stale rpc row`);
			}
			continue;
		}
		const patch: Parameters<typeof updateSchemaRow>[1] = {};
		if (row.toolTypeId !== "rpc") {
			buckets.typeDrift.push(
				`${row.toolId}: tool_type_id=${row.toolTypeId ?? "NULL"} (expected rpc)`,
			);
			patch.toolTypeId = "rpc";
		}
		if (row.schemaDialect !== "json-schema-2020-12") {
			buckets.typeDrift.push(
				`${row.toolId}: schema_dialect=${row.schemaDialect ?? "NULL"} (expected json-schema-2020-12)`,
			);
			patch.schemaDialect = "json-schema-2020-12";
		}
		if (IGNORE_DRIFT[row.toolId]) {
			buckets.ignored.push(
				`${row.toolId}: ignored — ${IGNORE_DRIFT[row.toolId]}`,
			);
			continue;
		}

		let expectedInput: unknown;
		let expectedOutput: unknown;
		try {
			expectedInput = zodToToolInputJsonSchema(lookup.inputSchema);
			expectedOutput = zodToStructuredOutputJsonSchema(lookup.outputSchema);
		} catch (error) {
			buckets.converterUnsupported.push(
				`${row.toolId}: ${(error as Error).message} at "${row.endpoint}"`,
			);
			continue;
		}

		let toolInSync = true;
		if (row.inputSchema === null) {
			buckets.missingSchema.push(`${row.toolId}: inputSchema`);
			patch.inputSchema = expectedInput;
			toolInSync = false;
		} else if (
			stableStringify(expectedInput) !== stableStringify(row.inputSchema)
		) {
			console.log(
				diff(row.toolId, "inputSchema", expectedInput, row.inputSchema),
			);
			console.log("");
			buckets.realMismatch.push(`${row.toolId}: inputSchema`);
			patch.inputSchema = expectedInput;
			toolInSync = false;
		}

		if (expectedOutput !== null) {
			if (row.outputSchema === null) {
				buckets.missingSchema.push(`${row.toolId}: outputSchema`);
				patch.outputSchema = expectedOutput;
				toolInSync = false;
			} else if (
				stableStringify(expectedOutput) !== stableStringify(row.outputSchema)
			) {
				console.log(
					diff(row.toolId, "outputSchema", expectedOutput, row.outputSchema),
				);
				console.log("");
				buckets.realMismatch.push(`${row.toolId}: outputSchema`);
				patch.outputSchema = expectedOutput;
				toolInSync = false;
			}
		}

		if (mode === "apply" && Object.keys(patch).length > 0) {
			await updateSchemaRow(row, patch);
			buckets.applied.push(
				`${row.toolId}: updated ${Object.keys(patch).join(", ")}`,
			);
		}

		if (toolInSync) buckets.inSync.push(row.toolId);
	}

	const printBucket = (label: string, items: string[]) => {
		if (!items.length) return;
		console.log(`\n# ${label} (${items.length})`);
		for (const item of items) console.log(`  ${item}`);
	};

	printBucket("missingSchema", buckets.missingSchema);
	printBucket("realMismatch", buckets.realMismatch);
	printBucket("converterUnsupported", buckets.converterUnsupported);
	printBucket("noContract", buckets.noContract);
	printBucket("missingProjection", buckets.missingProjection);
	printBucket("typeDrift", buckets.typeDrift);
	printBucket("ignored", buckets.ignored);
	printBucket("applied", buckets.applied);

	console.log(
		`\nSummary: ${buckets.inSync.length} in sync | ${buckets.missingSchema.length} missingSchema | ${buckets.realMismatch.length} realMismatch | ${buckets.converterUnsupported.length} converterUnsupported | ${buckets.noContract.length} noContract | ${buckets.missingProjection.length} missingProjection | ${buckets.typeDrift.length} typeDrift | ${buckets.ignored.length} ignored — over ${filtered.length} rpc-transport tools on tedix admin app`,
	);

	if (mode === "apply") {
		const unrepairable =
			buckets.converterUnsupported.length + buckets.missingProjection.length;
		if (unrepairable > 0) {
			console.error(
				`\nApply finished with ${unrepairable} unrepairable schema issue(s).`,
			);
			process.exit(1);
		}
		console.log("\nApply complete. Rerun --check to verify D1 state.");
		return;
	}

	if (mode !== "check") return;

	const failing =
		buckets.missingSchema.length +
		buckets.realMismatch.length +
		buckets.converterUnsupported.length +
		buckets.noContract.length +
		buckets.missingProjection.length +
		buckets.typeDrift.length;
	if (failing > 0) {
		console.error(
			`\nDrift detected. Fix through the ToolSchemaSyncWorkflow exposed by Tedix admin MCP (tool.run_tool_schema_sync). For intentionally removed oRPC endpoints, run schema sync with pruneStale=true.`,
		);
		process.exit(1);
	}

	console.log("\nCheck passed: no tool schema drift.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
