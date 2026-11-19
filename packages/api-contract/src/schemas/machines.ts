/**
 * Machines and their tool calls: a runner reports a readable machine name and
 * the read-only tools that machine accepts; a member or a tedi queues a call
 * for a named machine; the machine's runner claims the call and returns a
 * bounded result.
 */

import * as z from "zod";

/**
 * The one machine scope that lists machines, queues a read-only tool call for
 * one and reads that call's result. The tedi runtime delegates it over its
 * trusted service binding for the calling tedi, so the machine tools work
 * without the wider `mcp:work.read` and `mcp:work.write`.
 */
export const MACHINES_USE_SCOPE = "machines:use";

/** A machine counts as online while a runner on it reported this recently. */
export const MACHINE_ONLINE_WINDOW_MS = 3 * 60_000;
/** A queued call that no runner claimed in this time expires. */
export const MACHINE_TOOL_CALL_CLAIM_WINDOW_MS = 60_000;
/** A claimed call that has no result after this time fails. */
export const MACHINE_TOOL_CALL_ANSWER_WINDOW_MS = 120_000;
export const MACHINE_TOOL_CALL_TIMEOUT_ERROR =
	"The machine did not answer in time";

export const MACHINE_TOOL_INPUT_MAX_CHARS = 4_000;
export const MACHINE_TOOL_RESULT_MAX_CHARS = 20_000;
export const MACHINE_TOOL_ERROR_MAX_CHARS = 1_000;

export const MACHINE_TOOL_NAMES = [
	"read_file",
	"search_code",
	"list_commits",
	"read_commit",
	"read_ci_runs",
	"read_ci_job_log",
	"read_runner_state",
] as const;
export const MachineToolNameSchema = z.enum(MACHINE_TOOL_NAMES);
export type MachineToolName = z.infer<typeof MachineToolNameSchema>;

export const MACHINE_TOOL_CALL_STATUS_VALUES = [
	"pending",
	"claimed",
	"done",
	"failed",
	"expired",
] as const;
export const MachineToolCallStatusSchema = z.enum(
	MACHINE_TOOL_CALL_STATUS_VALUES,
);
export type MachineToolCallStatus = z.infer<typeof MachineToolCallStatusSchema>;

/** The readable name a runner reports for its machine. */
export const MachineNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[^\p{Cc}]+$/u, "A machine name cannot hold control characters");

/** What a health report may list; names this server does not know are ignored on read. */
export const ReportedMachineToolsSchema = z
	.array(z.string().trim().min(1).max(64))
	.max(32);

/**
 * A path inside the repository: relative, forward slashes, no `..` segment.
 * The runner resolves it again inside its own checkout and refuses a symlink
 * that leaves it.
 */
const RepositoryPathSchema = z
	.string()
	.min(1)
	.max(1_000)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.startsWith("~") &&
			!/^[A-Za-z]:/.test(path) &&
			!/[\\\p{Cc}]/u.test(path) &&
			!path.split("/").includes(".."),
		{ message: "Use a path inside the repository, without `..`" },
	);

const CommitShaSchema = z
	.string()
	.regex(/^[0-9a-fA-F]{7,40}$/, "Use 7 to 40 hexadecimal characters");

export const MACHINE_READ_FILE_MAX_LINES = 400;

export const MACHINE_TOOL_INPUT_SCHEMAS = {
	read_file: z
		.strictObject({
			path: RepositoryPathSchema,
			startLine: z.number().int().min(1).max(10_000_000).optional(),
			endLine: z.number().int().min(1).max(10_000_000).optional(),
		})
		.refine(
			(input) =>
				input.endLine === undefined ||
				(input.endLine >= (input.startLine ?? 1) &&
					input.endLine - (input.startLine ?? 1) < MACHINE_READ_FILE_MAX_LINES),
			{
				message: `Read at most ${MACHINE_READ_FILE_MAX_LINES} lines per call, with endLine at or after startLine`,
			},
		),
	search_code: z.strictObject({
		pattern: z
			.string()
			.min(1)
			.max(500)
			.regex(/^[^\n\r\0]+$/, "Use a pattern on one line"),
		pathPrefix: RepositoryPathSchema.optional(),
		maxResults: z.number().int().min(1).max(200).optional(),
	}),
	list_commits: z.strictObject({
		path: RepositoryPathSchema.optional(),
		limit: z.number().int().min(1).max(100).optional(),
	}),
	read_commit: z.strictObject({ sha: CommitShaSchema }),
	read_ci_runs: z.strictObject({
		sha: CommitShaSchema.optional(),
		limit: z.number().int().min(1).max(20).optional(),
	}),
	read_ci_job_log: z.strictObject({
		jobId: z.string().regex(/^\d{1,20}$/, "Use the job's number"),
	}),
	read_runner_state: z.strictObject({}),
} as const satisfies Record<MachineToolName, z.ZodType>;

export type MachineToolInput = Record<string, string | number>;

/**
 * Check one tool's input. The server runs this before it queues a call and the
 * runner runs it again before it executes one.
 */
export function parseMachineToolInput(
	tool: MachineToolName,
	input: unknown,
): { ok: true; input: MachineToolInput } | { ok: false; message: string } {
	const parsed = MACHINE_TOOL_INPUT_SCHEMAS[tool].safeParse(input ?? {});
	if (!parsed.success)
		return {
			ok: false,
			message: parsed.error.issues
				.map((issue) =>
					issue.path.length
						? `${issue.path.join(".")}: ${issue.message}`
						: issue.message,
				)
				.join("; ")
				.slice(0, 500),
		};
	if (JSON.stringify(parsed.data).length > MACHINE_TOOL_INPUT_MAX_CHARS)
		return { ok: false, message: "The input is too long" };
	return { ok: true, input: parsed.data as MachineToolInput };
}

export const MachineSchema = z.object({
	machineName: MachineNameSchema,
	/** The agents this machine's runners start, such as `codex`. */
	executors: z.array(z.string().min(1).max(64)).max(100),
	lastSeenAt: z.iso.datetime(),
	/** Null until runners report their version. */
	cliVersion: z.string().min(1).max(64).nullable(),
	machineTools: z.array(MachineToolNameSchema).max(MACHINE_TOOL_NAMES.length),
	online: z.boolean(),
});
export type Machine = z.infer<typeof MachineSchema>;

export const ListMachinesResultSchema = z.object({
	machines: z.array(MachineSchema),
});

const MachineToolCallIdSchema = z.uuid();

export const RequestMachineToolCallInputSchema = z.object({
	machine: MachineNameSchema.describe(
		"The machine's name, as `list_machines` returns it",
	),
	tool: MachineToolNameSchema,
	input: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.default({})
		.describe(
			"The tool's input: read_file {path, startLine?, endLine?}; search_code {pattern, pathPrefix?, maxResults?}; list_commits {path?, limit?}; read_commit {sha}; read_ci_runs {sha?, limit?}; read_ci_job_log {jobId}; read_runner_state {}",
		),
});

export const RequestMachineToolCallResultSchema = z.object({
	callId: MachineToolCallIdSchema,
	status: MachineToolCallStatusSchema,
});

export const ReadMachineToolCallInputSchema = z.object({
	callId: MachineToolCallIdSchema,
});

export const MachineToolCallSchema = z.object({
	callId: MachineToolCallIdSchema,
	machine: MachineNameSchema,
	tool: MachineToolNameSchema,
	status: MachineToolCallStatusSchema,
	result: z.string().max(MACHINE_TOOL_RESULT_MAX_CHARS).optional(),
	error: z.string().max(MACHINE_TOOL_ERROR_MAX_CHARS).optional(),
	createdAt: z.iso.datetime(),
	finishedAt: z.iso.datetime().optional(),
});
export type MachineToolCall = z.infer<typeof MachineToolCallSchema>;

/**
 * The runner cuts a result to the stored bound before it sends it. The server
 * accepts a little more and cuts again, so a note the runner adds after
 * cutting can never make a whole claim fail.
 */
export const MachineToolCallOutcomeSchema = z.object({
	callId: MachineToolCallIdSchema,
	ok: z.boolean(),
	result: z
		.string()
		.max(MACHINE_TOOL_RESULT_MAX_CHARS + 1_000)
		.optional(),
	error: z
		.string()
		.max(MACHINE_TOOL_ERROR_MAX_CHARS + 1_000)
		.optional(),
});

export const ClaimMachineToolCallsInputSchema = z.object({
	reporterId: z.string().trim().min(1).max(128),
	machineName: MachineNameSchema,
	limit: z.number().int().min(1).max(10),
	results: z.array(MachineToolCallOutcomeSchema).max(20).optional(),
});

export const ClaimMachineToolCallsResultSchema = z.object({
	calls: z
		.array(
			z.object({
				callId: MachineToolCallIdSchema,
				tool: MachineToolNameSchema,
				input: z.record(z.string(), z.union([z.string(), z.number()])),
			}),
		)
		.max(10),
});
