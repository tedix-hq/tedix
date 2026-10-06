import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import {
	type HarnessEvalResult,
	type HarnessEvalRun,
	HarnessEvalRunReportSchema,
	type HarnessSubjectTraceBundle,
	type HarnessSubjectVersion,
	type HarnessVersion,
	type TraceBundle,
	TraceBundleWorkstationSchema,
} from "@tedix/api-contract/schemas/harness-version";
import {
	listEvalResults as listEvalResultRows,
	listEvalRuns as listEvalRunRows,
} from "@tedix/db/queries/harness-version/evaluations";
import { ensureActiveKernelHarnessVersion as ensureActiveKernelHarnessVersionRow } from "@tedix/db/queries/harness-version/subjects";
import {
	listHarnessSubjectTraceBundles as listHarnessSubjectTraceBundleRows,
	listTraceBundles as listTraceBundleRows,
} from "@tedix/db/queries/harness-version/trace-bundles";
import {
	getActiveHarnessVersion as getActiveHarnessVersionRow,
	getHarnessVersionById as getHarnessVersionRowById,
	listHarnessVersions as listHarnessVersionRows,
} from "@tedix/db/queries/harness-version/versions";
import type {
	HarnessEvalResultRow,
	HarnessEvalRunRow,
	HarnessSubjectTraceBundleRow,
	HarnessSubjectVersionRow,
	HarnessVersionRow,
	TraceBundleRow,
} from "@tedix/db/schema/harness-versions";

function jsonObject(
	value: Record<string, unknown> | null,
	boundary: string,
): Record<string, JsonValue> | undefined {
	if (value === null) return undefined;
	const parsed = JsonValueSchema.parse(value);
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new TypeError(`${boundary} must be a JSON object`);
	}
	return parsed;
}

export function harnessVersionRowToContract(
	row: HarnessVersionRow,
): HarnessVersion {
	return {
		...row,
		orgId: row.orgId ?? undefined,
		runtimeKind: row.runtimeKind ?? undefined,
		components: row.components ?? {},
		metadata: jsonObject(row.metadata, "harness_versions.metadata"),
	};
}

export function harnessSubjectVersionRowToContract(
	row: HarnessSubjectVersionRow,
): HarnessSubjectVersion {
	return {
		...row,
		orgId: row.orgId ?? undefined,
		runtimeKind: row.runtimeKind ?? undefined,
		components: row.components ?? {},
		metadata: jsonObject(row.metadata, "harness_subject_versions.metadata"),
	};
}

export function harnessEvalResultRowToContract(
	row: HarnessEvalResultRow,
): HarnessEvalResult {
	return {
		...row,
		orgId: row.orgId ?? undefined,
		gates: row.gates ?? {},
		metadata: jsonObject(row.metadata, "harness_eval_results.metadata"),
	};
}

export function harnessEvalRunRowToContract(
	row: HarnessEvalRunRow,
): HarnessEvalRun {
	return {
		...row,
		orgId: row.orgId ?? undefined,
		report:
			row.report === null
				? undefined
				: HarnessEvalRunReportSchema.parse(row.report),
		metadata: jsonObject(row.metadata, "harness_eval_runs.metadata"),
	};
}

function traceWorkstation(metadata: Record<string, unknown> | undefined) {
	const parsed = TraceBundleWorkstationSchema.safeParse(metadata?.workstation);
	return parsed.success ? parsed.data : null;
}

export function traceBundleRowToContract(row: TraceBundleRow): TraceBundle {
	const metadata = jsonObject(row.metadata, "trace_bundles.metadata");
	return {
		...row,
		orgId: row.orgId ?? undefined,
		conversationId: row.conversationId ?? undefined,
		outcome: row.outcome ?? undefined,
		eventIds: row.eventIds ?? [],
		rationaleRecordIds: row.rationaleRecordIds ?? [],
		artifactIds: row.artifactIds ?? [],
		metadata,
		workstation: traceWorkstation(metadata),
	};
}

export function harnessSubjectTraceBundleRowToContract(
	row: HarnessSubjectTraceBundleRow,
): HarnessSubjectTraceBundle {
	const metadata = jsonObject(
		row.metadata,
		"harness_subject_trace_bundles.metadata",
	);
	return {
		...row,
		orgId: row.orgId ?? undefined,
		conversationId: row.conversationId ?? undefined,
		outcome: row.outcome ?? undefined,
		eventIds: row.eventIds ?? [],
		rationaleRecordIds: row.rationaleRecordIds ?? [],
		artifactIds: row.artifactIds ?? [],
		metadata,
		workstation: traceWorkstation(metadata),
	};
}

export async function getActiveHarnessVersion(
	...args: Parameters<typeof getActiveHarnessVersionRow>
) {
	const row = await getActiveHarnessVersionRow(...args);
	return row ? harnessVersionRowToContract(row) : null;
}

export async function ensureActiveKernelHarnessVersion(
	...args: Parameters<typeof ensureActiveKernelHarnessVersionRow>
) {
	const result = await ensureActiveKernelHarnessVersionRow(...args);
	return {
		...result,
		version: harnessSubjectVersionRowToContract(result.version),
	};
}

export async function getHarnessVersionById(
	...args: Parameters<typeof getHarnessVersionRowById>
) {
	const row = await getHarnessVersionRowById(...args);
	return row ? harnessVersionRowToContract(row) : null;
}

export async function listHarnessVersions(
	...args: Parameters<typeof listHarnessVersionRows>
) {
	return (await listHarnessVersionRows(...args)).map(
		harnessVersionRowToContract,
	);
}

export async function listTraceBundles(
	...args: Parameters<typeof listTraceBundleRows>
) {
	return (await listTraceBundleRows(...args)).map(traceBundleRowToContract);
}

export async function listHarnessSubjectTraceBundles(
	...args: Parameters<typeof listHarnessSubjectTraceBundleRows>
) {
	return (await listHarnessSubjectTraceBundleRows(...args)).map(
		harnessSubjectTraceBundleRowToContract,
	);
}

export async function listEvalResults(
	...args: Parameters<typeof listEvalResultRows>
) {
	return (await listEvalResultRows(...args)).map(
		harnessEvalResultRowToContract,
	);
}

export async function listEvalRuns(
	...args: Parameters<typeof listEvalRunRows>
) {
	return (await listEvalRunRows(...args)).map(harnessEvalRunRowToContract);
}
