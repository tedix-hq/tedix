/**
 * The acknowledgement layer of the live-drift gate.
 *
 * These tests exist to prove the list is an ACKNOWLEDGEMENT and not a
 * suppression: scoped to six exact columns and one property, aware of which
 * direction the difference points, loud on a clean run, and self-expiring.
 */

import { describe, expect, it } from "vite-plus/test";
import { classifyLiveDrift } from "./check-live-drift";
import {
	ACKNOWLEDGED_DIFFERENCES,
	applicableAcknowledgements,
	type AcknowledgedDifference,
	partitionAcknowledgedDifferences,
	type SchemaColumn,
	type SchemaDescription,
	type SchemaDifference,
} from "./schema-description";

const ACKNOWLEDGED_TABLES = [
	"app_adapters",
	"mcp_payment_events",
	"tedi_email_attachments",
	"tedi_email_events",
	"tedi_email_messages",
	"tedi_email_threads",
];

/** The exact difference the six push-recreated tables produce today. */
function pushRecreatedDifference(table: string): SchemaDifference {
	return {
		kind: "column_changed",
		table,
		column: "id",
		field: "notNull",
		expected: "false",
		actual: "true",
	};
}

const LIVE_DIFFERENCES = ACKNOWLEDGED_TABLES.map(pushRecreatedDifference);

function idColumn(notNull: boolean): SchemaColumn {
	return {
		name: "id",
		type: "TEXT",
		notNull,
		defaultValue: null,
		primaryKey: 1,
	};
}

/** A schema whose six push-recreated tables carry the given `notNull`. */
function schema(notNull: boolean): SchemaDescription {
	return {
		tables: ACKNOWLEDGED_TABLES.map((name) => ({
			name,
			columns: [idColumn(notNull)],
		})),
		indexes: [],
		objects: [],
	};
}

describe("acknowledged live-drift differences", () => {
	it("covers exactly the six push-recreated primary keys, notNull only", () => {
		expect(ACKNOWLEDGED_DIFFERENCES.map((entry) => entry.table).sort()).toEqual(
			ACKNOWLEDGED_TABLES,
		);
		for (const entry of ACKNOWLEDGED_DIFFERENCES) {
			expect(entry.column).toBe("id");
			expect(entry.field).toBe("notNull");
			expect(entry.declared).toBe("false");
			expect(entry.live).toBe("true");
			expect(entry.reason.length).toBeGreaterThan(0);
		}
	});

	it("acknowledges the six live differences and blocks nothing else", () => {
		const partition = partitionAcknowledgedDifferences(LIVE_DIFFERENCES);
		expect(partition.blocking).toEqual([]);
		expect(partition.stale).toEqual([]);
		expect(partition.acknowledged).toHaveLength(6);
	});

	it("BLOCKS the opposite direction — live looser than declared", () => {
		const looser: SchemaDifference = {
			kind: "column_changed",
			table: "tedi_email_messages",
			column: "id",
			field: "notNull",
			expected: "true",
			actual: "false",
		};
		const partition = partitionAcknowledgedDifferences([looser]);
		expect(partition.blocking).toEqual([looser]);
		expect(partition.acknowledged).toEqual([]);
	});

	it("blocks any other property on an acknowledged column", () => {
		const others: SchemaDifference[] = [
			{
				kind: "column_changed",
				table: "tedi_email_messages",
				column: "id",
				field: "type",
				expected: "TEXT",
				actual: "INTEGER",
			},
			{
				kind: "column_changed",
				table: "tedi_email_messages",
				column: "id",
				field: "primaryKey",
				expected: "1",
				actual: "0",
			},
			{
				kind: "column_changed",
				table: "tedi_email_messages",
				column: "id",
				field: "default",
				expected: "<none>",
				actual: "'x'",
			},
		];
		expect(partitionAcknowledgedDifferences(others).blocking).toEqual(others);
	});

	it("blocks the same notNull difference on a different column or table", () => {
		const elsewhere: SchemaDifference[] = [
			{
				kind: "column_changed",
				table: "tedi_email_messages",
				column: "thread_id",
				field: "notNull",
				expected: "false",
				actual: "true",
			},
			{
				kind: "column_changed",
				table: "organizations",
				column: "id",
				field: "notNull",
				expected: "false",
				actual: "true",
			},
		];
		expect(partitionAcknowledgedDifferences(elsewhere).blocking).toEqual(
			elsewhere,
		);
	});

	it("blocks a missing or unexpected table on an acknowledged table", () => {
		const structural: SchemaDifference[] = [
			{ kind: "missing_table", table: "tedi_email_messages" },
			{
				kind: "missing_column",
				table: "tedi_email_messages",
				column: "id",
			},
		];
		expect(partitionAcknowledgedDifferences(structural).blocking).toEqual(
			structural,
		);
	});

	it("reports an acknowledgement that no longer applies as stale", () => {
		const partition = partitionAcknowledgedDifferences(
			LIVE_DIFFERENCES.filter(
				(difference) =>
					difference.kind === "column_changed" &&
					difference.table !== "tedi_email_threads",
			),
		);
		expect(partition.stale.map((entry) => entry.table)).toEqual([
			"tedi_email_threads",
		]);
		expect(partition.acknowledged).toHaveLength(5);
	});
});

describe("live drift verdicts with acknowledgements", () => {
	it("renders a qualified verdict, never an unqualified match", () => {
		const outcome = classifyLiveDrift(schema(false), schema(true));
		expect(outcome.verdict).toBe("acknowledged");
		if (outcome.verdict !== "acknowledged") throw new Error("unreachable");
		expect(outcome.acknowledged).toHaveLength(6);
		// The six entries are visible to the operator.
		for (const table of ACKNOWLEDGED_TABLES) {
			expect(outcome.message).toContain(`${table}.id notNull`);
		}
		expect(outcome.message).toContain("NOT a clean bill of health");
		expect(outcome.message).not.toMatch(/^Live D1 schema matches the reviewed/);
	});

	it("tells the operator to delete an entry once the difference is gone", () => {
		const outcome = classifyLiveDrift(schema(false), schema(false));
		// Nothing differs, so every acknowledgement is stale and must be removed.
		expect(outcome.verdict).toBe("drift");
		if (outcome.verdict !== "drift") throw new Error("unreachable");
		expect(outcome.message).toContain("STALE acknowledgement(s)");
		expect(outcome.message).toContain("scripts/schema-description.ts");

		// With an empty acknowledgement list the same comparison is simply clean.
		expect(
			partitionAcknowledgedDifferences([], [] as AcknowledgedDifference[]),
		).toEqual({ blocking: [], acknowledged: [], stale: [] });
	});

	it("blocks when the acknowledged direction reverses in production", () => {
		const outcome = classifyLiveDrift(schema(true), schema(false));
		expect(outcome.verdict).toBe("drift");
		if (outcome.verdict !== "drift") throw new Error("unreachable");
		expect(outcome.message).toContain("STALE acknowledgement(s)");
		expect(outcome.message).toContain("6 unreviewed difference(s)");
		expect(outcome.message).toContain(
			"column tedi_email_messages.id notNull: declared true, live false",
		);
	});

	it("says nothing about an entry whose column is absent from the comparison", () => {
		// A schema that does not contain these tables at all cannot report the six
		// as fixed; a missing table is its own (blocking) difference.
		const unrelated: SchemaDescription = {
			tables: [{ name: "organizations", columns: [idColumn(true)] }],
			indexes: [],
			objects: [],
		};
		expect(applicableAcknowledgements(unrelated, unrelated)).toEqual([]);
		expect(classifyLiveDrift(unrelated, unrelated).verdict).toBe("current");
	});

	it("blocks an unreviewed difference even while the six are present", () => {
		const expected = schema(false);
		const actual = schema(true);
		actual.tables.push({
			name: "unexpected_table",
			columns: [idColumn(true)],
		});
		const outcome = classifyLiveDrift(expected, actual);
		expect(outcome.verdict).toBe("drift");
		if (outcome.verdict !== "drift") throw new Error("unreachable");
		expect(outcome.message).toContain("1 difference(s)");
		expect(outcome.message).toContain("unexpected_table");
		expect(outcome.message).toContain("are not the cause");
	});
});
