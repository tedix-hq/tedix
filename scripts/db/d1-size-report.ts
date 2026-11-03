#!/usr/bin/env bun

/**
 * Read-only operator report. Supply explicit installation targets from private
 * ops; this script never infers production from checked-in example configs.
 *
 * CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
 * D1_SIZE_MAIN_DATABASE_ID, D1_SIZE_LOGS_DATABASE_ID are required.
 *
 * bun scripts/db/d1-size-report.ts --sizes-only
 * bun scripts/db/d1-size-report.ts
 *
 * JSON is a working buffer: publish the baseline to the owning OS Work/Output.
 * Record --sizes-only on that Work before and after each production report.
 */

import {
	createD1StorageReader,
	readD1SizeBytes,
	readD1StorageReport,
} from "@tedix/db/queries/d1-size";
import { remoteD1QueryRest } from "../lib/remote-d1";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} from the authorized installation`);
	return value;
}

export function createSizeReportClient(options: {
	accountId: string;
	databaseId: string;
	apiToken: string;
	fetchImplementation?: Parameters<
		typeof remoteD1QueryRest
	>[0]["fetchImplementation"];
	env?: NodeJS.ProcessEnv;
}) {
	return createD1StorageReader(async (query, params) => {
		const result = await remoteD1QueryRest({
			...options,
			sql: query,
			params,
			caller: "scripts/db/d1-size-report.ts",
		});
		if (!result.ok)
			throw new Error(
				`D1 query failed (${result.status}): ${result.detail ?? "unknown"}`,
			);
		const rows = result.result as {
			success: boolean;
			results: Record<string, unknown>[];
			meta: { size_after?: number; rows_written?: number };
		}[];
		if (
			!Array.isArray(rows) ||
			rows.length !== 1 ||
			rows[0]?.success !== true ||
			!Array.isArray(rows[0].results)
		) {
			throw new Error("Invalid D1 statement envelope");
		}
		if (rows[0].meta?.rows_written)
			throw new Error("Read-only inventory unexpectedly wrote rows");
		return rows[0];
	});
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--sizes-only"))
		throw new Error("Only --sizes-only is supported");
	const accountId = required("CLOUDFLARE_ACCOUNT_ID");
	const apiToken = required("CLOUDFLARE_API_TOKEN");
	const mainId = required("D1_SIZE_MAIN_DATABASE_ID");
	const logsId = required("D1_SIZE_LOGS_DATABASE_ID");
	if (mainId === logsId)
		throw new Error("Main and LOGS_DB must be distinct explicit targets");
	const clients = {
		DB: createSizeReportClient({ accountId, databaseId: mainId, apiToken }),
		LOGS_DB: createSizeReportClient({
			accountId,
			databaseId: logsId,
			apiToken,
		}),
	};
	const reports: Record<string, unknown> = {};
	for (const [binding, db] of Object.entries(clients)) {
		reports[binding] = args.includes("--sizes-only")
			? { bytes: await readD1SizeBytes(db) }
			: await readD1StorageReport(db);
	}
	console.log(
		JSON.stringify({ at: new Date().toISOString(), ...reports }, null, 2),
	);
}

if (import.meta.main) await main();
