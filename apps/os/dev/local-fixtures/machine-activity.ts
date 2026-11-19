import { fid, ORG_ID } from "./core";

const MACHINE = "studio-mac";
/** The one sample call whose full result can be read again. */
export const MACHINE_CALL_ID = fid("65", 1);

const README = Array.from(
	{ length: 40 },
	(_, index) =>
		`${index + 1}\t${index === 0 ? "# Churn cohort report" : index % 7 === 0 ? "" : `Line ${index + 1} of the report guide: pages are cut at 50 rows.`}`,
).join("\n");

/** The full text of the sample read; the stored event keeps only its start. */
export const MACHINE_CALL_FULL_RESULT = README;

const fenced = (text: string) =>
	`<<<external_machine_tool>>>\n${text}\n<<<end_external_machine_tool>>>`;

/**
 * What a tedi did on a machine in one sample turn, as the event log stores
 * it: a start event with the arguments, then an end event whose result is
 * kept whole when small and as the first 1,024 characters of its JSON text
 * when large.
 */
export function machineActivityEvents(input: {
	childRunId: string;
	tediId: string;
	at: string;
}) {
	const stored = (result: unknown) => {
		const json = JSON.stringify(result);
		return json.length <= 1_024
			? result
			: {
					truncated: true,
					originalChars: json.length,
					preview: json.slice(0, 1_024),
				};
	};
	const done = (tool: string, text: string, more: object = {}) =>
		stored({
			kind: "machine_tool_result",
			machine: MACHINE,
			tool,
			status: "done",
			...more,
			result: fenced(text),
		});
	const calls: {
		name: string;
		arguments: Record<string, string | number>;
		end?: { failed?: string; result?: unknown };
	}[] = [
		{
			name: "read_machine_file",
			arguments: { machine: MACHINE, path: "docs/reports/churn-cohort.md" },
			end: {
				result: done("read_file", README, { callId: MACHINE_CALL_ID }),
			},
		},
		{
			name: "search_machine_code",
			arguments: {
				machine: MACHINE,
				pattern: "pageSize",
				pathPrefix: "apps/reports/src",
			},
			end: {
				result: done(
					"search_code",
					"apps/reports/src/cohort/paging.ts:12:export const pageSize = 50;\napps/reports/src/cohort/paging.ts:31:\tconst pages = Math.floor(rows.length / pageSize);\napps/reports/src/cohort/table.tsx:48:\t\tpageSize={pageSize}",
				),
			},
		},
		{
			name: "read_machine_file",
			arguments: {
				machine: MACHINE,
				path: "apps/reports/src/cohort/paging.ts",
				startLine: 24,
				endLine: 36,
			},
			end: {
				result: done(
					"read_file",
					"24\texport function pageCount(rows: readonly Row[]): number {\n25\t\tif (rows.length === 0) return 1;\n31\t\tconst pages = Math.floor(rows.length / pageSize);\n32\t\treturn pages;\n33\t}",
				),
			},
		},
		{
			name: "read_machine_ci_runs",
			arguments: { machine: MACHINE, limit: 3 },
			end: {
				result: done(
					"read_ci_runs",
					"verify  main  success  4m 12s\nbrowser-tests  main  success  9m 40s\nship  main  success  3m 05s",
				),
			},
		},
		{
			name: "edit_machine_file",
			arguments: {
				machine: MACHINE,
				workspace: "paging-fix",
				path: "apps/reports/src/cohort/paging.ts",
				oldText:
					"\tif (rows.length === 0) return 1;\n\tconst pages = Math.floor(rows.length / pageSize);\n\treturn pages;",
				newText:
					"\tif (rows.length === 0) return 1;\n\t// A last, shorter page still counts.\n\tconst pages = Math.ceil(rows.length / pageSize);\n\treturn pages;",
			},
			end: { result: done("edit_file", "Replaced 1 occurrence.") },
		},
		{
			name: "run_machine_command",
			arguments: {
				machine: MACHINE,
				workspace: "paging-fix",
				command: "bun test apps/reports/src/cohort/paging.test.ts",
			},
			end: {
				result: stored({
					kind: "machine_tool_result",
					machine: MACHINE,
					tool: "run_command",
					status: "done",
					exitCode: 1,
					result: fenced(
						"bun test v1.3\n\napps/reports/src/cohort/paging.test.ts:\n✓ counts full pages\n✗ keeps an empty report at one page\n  expected 1, received 0\n\n 1 pass\n 1 fail",
					),
				}),
			},
		},
		{
			name: "read_machine_runner_state",
			arguments: { machine: MACHINE },
			end: {
				result: {
					kind: "machine_tool_pending",
					callId: fid("65", 2),
					machine: MACHINE,
					tool: "read_runner_state",
					status: "claimed",
				},
			},
		},
		{
			name: "read_machine_commit",
			arguments: { machine: "build-box", sha: "9f3c2ab41d07" },
			end: { failed: "The machine build-box is offline" },
		},
	];
	return calls.flatMap((call, index) => {
		const event = {
			organizationId: ORG_ID,
			tediId: input.tediId,
			runId: input.childRunId,
			createdAt: input.at,
		};
		const id = `${input.childRunId}:native-tool.machine-${index}`;
		return [
			{
				...event,
				id: `${id}.started`,
				kind: "tool.started" as const,
				payload: { name: call.name, arguments: call.arguments },
			},
			call.end?.failed
				? {
						...event,
						id: `${id}.failed`,
						kind: "tool.failed" as const,
						payload: { name: call.name, error: call.end.failed },
					}
				: {
						...event,
						id: `${id}.completed`,
						kind: "tool.completed" as const,
						payload: {
							name: call.name,
							ok: true,
							resultPreview: call.end?.result,
						},
					},
		];
	});
}
