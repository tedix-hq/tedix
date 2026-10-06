/**
 * Post-migration verification that live production D1 matches the reviewed
 * migration chain.
 *
 * A DETECTED difference fails closed. A FAILURE TO OBTAIN A VERDICT does not,
 * and that distinction is the point of this file.
 *
 * This does not use `drizzle-kit push --explain`: drizzle-kit 1.0.0-rc.4 cannot
 * introspect an index built over an expression, aborts the whole pull, and
 * under `--output json` exits 1 with empty stdout and stderr. `tablesFilter`
 * does not help because it filters only the DB side.
 *
 * Both sides are instead read the way SQLite describes a schema —
 * `sqlite_master` + `pragma_table_info`:
 *
 *   expected: the reviewed migration chain replayed into an in-memory database
 *   actual:   live production D1 over `wrangler d1 execute --remote --json`
 *
 * This reuses the SAME Wrangler transport and the SAME credentials the
 * migration apply step already needs, so a run that can migrate can also
 * certify. Expression indexes are ordinary rows on this path.
 *
 * UNVERIFIED REMAINS A REAL OUTCOME. A remote read that fails, a chain that
 * will not replay, or a malformed envelope all produce UNVERIFIED with the
 * exact command to reproduce — never a silent pass.
 *
 * ACKNOWLEDGED IS A FOURTH OUTCOME, AND IT IS NOT "CURRENT". Six columns carry
 * a reviewed, named, direction-checked difference that cannot be reconciled
 * (see ACKNOWLEDGED_DIFFERENCES in `schema-description.ts`). They do not block,
 * but they are printed in full on every run and the verdict says the schema
 * does NOT match exactly. An entry that stops being observed BLOCKS as stale,
 * so the list cannot outlive its subject.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	D1_DATABASE_NAME,
	withD1LedgerReadRetry,
} from "./check-live-migration-ledger";
import { readExpectedSchema } from "./expected-schema";
import {
	type AcknowledgedDifference,
	applicableAcknowledgements,
	buildSchemaDescription,
	compareSchemaDescriptions,
	partitionAcknowledgedDifferences,
	renderAcknowledgedDifferences,
	renderSchemaDifferences,
	SCHEMA_COLUMN_SQL,
	SCHEMA_OBJECT_SQL,
	type SchemaColumnRow,
	type SchemaDescription,
	type SchemaDifference,
	type SchemaObjectRow,
} from "./schema-description";
import { parseWranglerJson, runWrangler } from "./wrangler-command";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export type LiveDriftOutcome =
	/** A verdict was obtained and the live schema matches exactly. */
	| { verdict: "current"; tableCount: number; indexCount: number }
	/**
	 * A verdict was obtained. Nothing blocks, but named, reviewed differences
	 * were observed. Deliberately NOT `current`: the operator must see the exact
	 * entries rather than an unqualified "matches".
	 */
	| {
			verdict: "acknowledged";
			tableCount: number;
			indexCount: number;
			acknowledged: AcknowledgedDifference[];
			message: string;
	  }
	/** A verdict was obtained and it shows drift. Blocks the deploy. */
	| { verdict: "drift"; message: string; differences: SchemaDifference[] }
	/**
	 * NO verdict was rendered — the live read failed, the chain would not
	 * replay, or the response was malformed. Warns and proceeds, like a
	 * provenance-gate transport failure.
	 */
	| { verdict: "unverified"; message: string };

/**
 * Unwrap Wrangler's `d1 execute --json` envelope for a single statement.
 *
 * Fails loudly on any shape that is not an explicit success with a results
 * array — an unrecognized envelope must never degrade into "zero rows", which
 * would compare as a completely empty database and, for the ACTUAL side, look
 * like catastrophic drift while for a filtered query it could look clean.
 */
export function parseD1Rows(payload: unknown, context: string): unknown[] {
	if (!Array.isArray(payload) || payload.length !== 1) {
		throw new Error(`${context} returned an unexpected envelope`);
	}
	const result = payload[0];
	if (!isRecord(result) || result.success !== true) {
		throw new Error(`${context} did not succeed`);
	}
	if (!Array.isArray(result.results)) {
		throw new Error(`${context} returned no results array`);
	}
	return result.results;
}

function queryLive(
	sql: string,
	context: string,
	run: typeof runWrangler,
): unknown[] {
	const stdout = withD1LedgerReadRetry(() =>
		run([
			"d1",
			"execute",
			D1_DATABASE_NAME,
			"--remote",
			"--config",
			"wrangler.jsonc",
			"--command",
			sql,
			"--json",
		]),
	);
	return parseD1Rows(parseWranglerJson(stdout, context), context);
}

/** Read the live production schema. Throws when it cannot be obtained. */
export function readLiveSchema(
	run: typeof runWrangler = runWrangler,
): SchemaDescription {
	const objectRows = queryLive(
		SCHEMA_OBJECT_SQL,
		"Live D1 sqlite_master query",
		run,
	) as SchemaObjectRow[];
	const columnRows = queryLive(
		SCHEMA_COLUMN_SQL,
		"Live D1 table_info query",
		run,
	) as SchemaColumnRow[];
	return buildSchemaDescription(objectRows, columnRows);
}

/**
 * Turn a completed comparison into a verdict.
 *
 * Split from the process plumbing so the fail-closed / fail-open boundary is
 * unit-testable — it is the only part of this file that decides whether
 * production ships.
 */
export function classifyLiveDrift(
	expected: SchemaDescription,
	actual: SchemaDescription,
): LiveDriftOutcome {
	const differences = compareSchemaDescriptions(expected, actual);
	const { blocking, acknowledged, stale } = partitionAcknowledgedDifferences(
		differences,
		applicableAcknowledgements(expected, actual),
	);

	// A stale entry BLOCKS. If someone genuinely reconciled one of the six, the
	// acknowledgement has to be deleted in the same change — the same exact-match
	// discipline the repo's other reviewed manifests use. Left alone, a list that
	// outlives its subject is indistinguishable from a blanket suppression.
	if (stale.length > 0) {
		return {
			verdict: "drift",
			differences: blocking,
			message:
				`Live D1 schema drift check found ${stale.length} STALE acknowledgement(s): the live ` +
				"schema no longer shows the reviewed difference, so the entry must be removed from " +
				`ACKNOWLEDGED_DIFFERENCES in scripts/schema-description.ts:\n${renderAcknowledgedDifferences(stale)}` +
				(blocking.length > 0
					? `\n\nAlso found ${blocking.length} unreviewed difference(s):\n${renderSchemaDifferences(blocking)}`
					: ""),
		};
	}

	if (blocking.length > 0) {
		return {
			verdict: "drift",
			differences: blocking,
			message:
				`Live D1 schema drift check found ${blocking.length} difference(s) ` +
				`between the reviewed migration chain and production:\n${renderSchemaDifferences(blocking)}` +
				(acknowledged.length > 0
					? `\n\n(${acknowledged.length} separately acknowledged difference(s) were also present and are not the cause:\n${renderAcknowledgedDifferences(acknowledged)})`
					: ""),
		};
	}

	if (acknowledged.length > 0) {
		return {
			verdict: "acknowledged",
			tableCount: expected.tables.length,
			indexCount: expected.indexes.length,
			acknowledged,
			message:
				`Live D1 schema does NOT match the reviewed migration chain exactly: ${acknowledged.length} ` +
				`reviewed, acknowledged difference(s) remain (${expected.tables.length} tables, ${expected.indexes.length} indexes compared, nothing unreviewed):\n` +
				`${renderAcknowledgedDifferences(acknowledged)}\n` +
				`why: ${acknowledged[0]?.reason ?? ""}\n` +
				"Each is acknowledged ONLY in this direction — live stricter than declared. Any other " +
				"property on these columns, the opposite direction, and every other column or table " +
				"still blocks. This is NOT a clean bill of health.",
		};
	}

	return {
		verdict: "current",
		tableCount: expected.tables.length,
		indexCount: expected.indexes.length,
	};
}

export function checkLiveDrift(
	options: { run?: typeof runWrangler } = {},
): LiveDriftOutcome {
	const startedAt = Date.now();
	let expected: SchemaDescription;
	try {
		expected = readExpectedSchema();
	} catch (error) {
		return {
			verdict: "unverified",
			message:
				`Could not build the declared schema by replaying the migration chain: ${error instanceof Error ? error.message : String(error)}\n` +
				`elapsed: ${Date.now() - startedAt}ms`,
		};
	}

	let actual: SchemaDescription;
	try {
		actual = readLiveSchema(options.run ?? runWrangler);
	} catch (error) {
		// Everything an owner needs to reproduce with real credentials. The CI log
		// otherwise shows one sentence and no way to tell a credential failure
		// from an unavailable database.
		return {
			verdict: "unverified",
			message:
				`Could not read the live production schema: ${error instanceof Error ? error.message : String(error)}\n` +
				`command: wrangler d1 execute ${D1_DATABASE_NAME} --remote --config wrangler.jsonc --json --command "<sqlite_master / pragma_table_info>" (cwd packages/db)\n` +
				`requires: CLOUDFLARE_API_TOKEN with D1:read on account ${process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || process.env.CF_ACCOUNT_ID?.trim() || "<CLOUDFLARE_ACCOUNT_ID is unset>"}\n` +
				`elapsed: ${Date.now() - startedAt}ms`,
		};
	}

	return classifyLiveDrift(expected, actual);
}

if (
	import.meta.main ||
	(process.argv[1] &&
		path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: check-live-drift.ts — read the production D1 schema and compare the reviewed migration chain",
		);
	} else {
		const outcome = checkLiveDrift();
		switch (outcome.verdict) {
			case "current":
				console.log(
					`Live D1 schema matches the reviewed migration chain (${outcome.tableCount} tables, ${outcome.indexCount} indexes compared)`,
				);
				break;
			case "acknowledged":
				// A run annotation, not a plain log line: a passing verdict that carries
				// known differences must not scroll past as an unqualified "matches".
				console.log(
					`::notice title=Live D1 drift: ${outcome.acknowledged.length} acknowledged difference(s)::${outcome.message.split("\n")[0]}`,
				);
				console.log(outcome.message);
				break;
			case "unverified":
				// ::warning renders as a run annotation; a bare console.warn is collapsed
				// into the log and this must not be silent.
				console.warn(
					`::warning title=Live D1 drift UNVERIFIED::${outcome.message.split("\n")[0]}`,
				);
				console.warn(outcome.message);
				console.warn(
					"No drift verdict was rendered, so this is NOT evidence the schema is clean " +
						"and NOT evidence it drifted. The deploy proceeds; re-run with owner D1 " +
						"credentials to obtain a real verdict.",
				);
				break;
			case "drift":
				console.error(outcome.message);
				process.exit(1);
		}
	}
}
