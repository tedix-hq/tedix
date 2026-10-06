// Harness version, trace-bundle, eval, and promotion tool specs.
import { harnessContract } from "@tedix/api-contract/contracts/harness";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
	withoutTediId,
} from "./aggregate-tedis-shared";

const HARNESS_VERSIONS_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(harnessContract.listHarnessVersions),
	);
	return withoutTediId(schema);
})();

const HARNESS_TRACE_BUNDLE_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(harnessContract.listTraceBundles),
	);
	return withoutTediId(schema);
})();

const HARNESS_EVAL_RUNS_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(harnessContract.listEvalRuns),
	);
	return withoutTediId(schema);
})();

const HARNESS_COMPARE_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(harnessContract.compareHarnessVersions),
	);
	return withoutTediId(schema);
})();

const HARNESS_PROMOTE_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(harnessContract.promoteHarnessVersion),
);

export const HARNESS_TOOLS: TediToolSpec[] = [
	{
		name: "harness_versions",
		remoteName: "harness_versions",
		description:
			"List this tedi's harness versions, optionally filtered by promotion status or runtime kind.",
		inputSchema: HARNESS_VERSIONS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "harness/listHarnessVersions",
	},
	{
		name: "harness_trace_bundle",
		remoteName: "harness_trace_bundle",
		description:
			"List this tedi's trace bundles by run id or harness version for replay and certification evidence.",
		inputSchema: HARNESS_TRACE_BUNDLE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "harness/listTraceBundles",
	},
	{
		name: "harness_eval_runs",
		remoteName: "harness_eval_runs",
		description:
			"List grouped harness eval runs for this tedi and harness version.",
		inputSchema: HARNESS_EVAL_RUNS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "harness/listEvalRuns",
	},
	{
		name: "harness_compare",
		remoteName: "harness_compare",
		description:
			"Compare a candidate harness version against the active version or an explicit base version.",
		inputSchema: HARNESS_COMPARE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "harness/compareHarnessVersions",
	},
	{
		name: "harness_promote",
		remoteName: "harness_promote",
		description:
			"Advance a harness version through the eval-gated promotion ladder.",
		inputSchema: HARNESS_PROMOTE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "harness/promoteHarnessVersion",
		includeTediIdParam: false,
	},
];
