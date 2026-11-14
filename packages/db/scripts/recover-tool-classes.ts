import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import { toolClassDeclarationGap } from "@tedix/api-contract/utils/tool-declared-class";

const Row = z.object({
	id: z.string().min(1),
	app_id: z.string().min(1),
	tool_id: z.string().min(1),
	write_capability: z.enum(["read", "write", "destructive"]).nullable(),
	meta: z.string().nullable(),
	updated_at: z.string().nullable(),
});
type Row = z.infer<typeof Row>;
const key = "com.tedix/policy";
const quote = (value: string | null) =>
	value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

function indexRows(input: unknown): Map<string, Row> {
	const rows = z.array(Row).parse(input);
	const indexed = new Map(rows.map((row) => [row.id, row]));
	if (indexed.size !== rows.length) throw new Error("Duplicate tool row IDs");
	return indexed;
}

/** Plan only: inputs must come from an isolated old copy and a fresh live read. */
export function planToolClassRecovery(
	priorInput: unknown,
	currentInput: unknown,
) {
	const prior = indexRows(priorInput);
	const current = indexRows(currentInput);
	const changes: Array<{
		id: string;
		appId: string;
		toolId: string;
		before: string | null;
		after: string | null;
		sql: string;
	}> = [];
	const review: Array<{ id: string; toolId: string; reason: string }> = [];
	for (const row of current.values()) {
		const old = prior.get(row.id);
		const hold = (reason: string) =>
			review.push({ id: row.id, toolId: row.tool_id, reason });
		if (!old) {
			hold("No prior row; do not infer a class");
			continue;
		}
		if (old.app_id !== row.app_id || old.tool_id !== row.tool_id) {
			hold("Tool identity changed");
			continue;
		}
		if (old.meta === row.meta && old.write_capability === row.write_capability)
			continue;
		let meta: Record<string, unknown>;
		try {
			meta = z
				.record(z.string(), z.unknown())
				.parse(JSON.parse(old.meta ?? "{}"));
		} catch {
			hold("Prior metadata is invalid");
			continue;
		}
		const policy = parseToolPolicyMetadata(meta);
		if (
			!policy?.riskTier ||
			!policy.blastRadius ||
			toolClassDeclarationGap({ writeCapability: old.write_capability, meta })
		) {
			hold("No complete valid prior class");
			continue;
		}
		// Reproduce only the known migration's exact write. Anything else is a
		// later decision or unknown history and must be reviewed, never undone.
		const expected = {
			...meta,
			[key]: {
				...policy,
				riskTier: "high_impact_write",
				blastRadius: "multi_tenant",
				declared: true,
			},
		};
		let actual: unknown;
		try {
			actual = JSON.parse(row.meta ?? "{}");
		} catch {
			hold("Current metadata is invalid");
			continue;
		}
		if (
			policy.declared === true ||
			old.write_capability === "read" ||
			old.write_capability !== row.write_capability ||
			old.updated_at !== row.updated_at ||
			!sameJson(expected, actual)
		) {
			hold("Current row differs from the migration result");
			continue;
		}
		const sql = `UPDATE app_tools SET meta = ${quote(old.meta)} WHERE id = ${quote(row.id)} AND app_id = ${quote(row.app_id)} AND tool_id = ${quote(row.tool_id)} AND write_capability IS ${quote(row.write_capability)} AND meta IS ${quote(row.meta)} AND updated_at IS ${quote(row.updated_at)};`;
		changes.push({
			id: row.id,
			appId: row.app_id,
			toolId: row.tool_id,
			before: row.meta,
			after: old.meta,
			sql,
		});
	}
	return { changes, review };
}

function sameJson(a: unknown, b: unknown): boolean {
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => [k, canonical(v)]),
			);
		return value;
	};
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

if (import.meta.main) {
	const [priorPath, currentPath] = process.argv.slice(2);
	if (!priorPath || !currentPath)
		throw new Error(
			"Usage: bun scripts/recover-tool-classes.ts <prior-rows.json> <current-rows.json>",
		);
	console.log(
		JSON.stringify(
			planToolClassRecovery(
				JSON.parse(readFileSync(priorPath, "utf8")),
				JSON.parse(readFileSync(currentPath, "utf8")),
			),
			null,
			2,
		),
	);
}
