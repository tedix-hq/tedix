/**
 * Machines and their tool calls: a runner reports a readable machine name and
 * the tools that machine accepts; a member or a tedi queues a call for a named
 * machine; the machine's runner claims the call and returns a bounded result.
 *
 * A machine accepts the write tools (a workspace, file writes and edits,
 * commands) only when its owner switched them on in the runner's saved
 * settings on that machine. The runner then lists them in its health reports.
 */

import * as z from "zod";

/**
 * The one machine scope that lists machines, queues a read-only tool call for
 * one and reads that call's result. The tedi runtime delegates it over its
 * trusted service binding for the calling tedi, so the machine tools work
 * without the wider `mcp:work.read` and `mcp:work.write`.
 */
export const MACHINES_USE_SCOPE = "machines:use";
/**
 * Needed on top of `machines:use` when a tedi queues one of the write tools.
 * The tedi runtime delegates it like `machines:use`, and offers the write
 * tools only in a chat with a signed-in person.
 */
export const MACHINES_WRITE_SCOPE = "machines:write";

/** A machine counts as online while a runner on it reported health or polled this recently. */
export const MACHINE_ONLINE_WINDOW_MS = 10 * 60_000;
/** A queued call that no runner claimed in this time expires. */
export const MACHINE_TOOL_CALL_CLAIM_WINDOW_MS = 60_000;
/** A claimed call that has no result after this time fails. */
export const MACHINE_TOOL_CALL_ANSWER_WINDOW_MS = 120_000;
export const MACHINE_COMMAND_DEFAULT_TIMEOUT_SECONDS = 120;
export const MACHINE_COMMAND_MAX_TIMEOUT_SECONDS = 1_800;
/** A claimed command may take its longest timeout before it counts as unanswered. */
export const MACHINE_COMMAND_ANSWER_WINDOW_MS =
	MACHINE_COMMAND_MAX_TIMEOUT_SECONDS * 1_000 +
	MACHINE_TOOL_CALL_ANSWER_WINDOW_MS;
export const MACHINE_TOOL_CALL_TIMEOUT_ERROR =
	"The machine did not answer in time";

export const MACHINE_TOOL_INPUT_MAX_CHARS = 4_000;
export const MACHINE_FILE_CONTENT_MAX_CHARS = 200_000;
/** The stored input of a file write or edit: its content plus the other fields. */
export const MACHINE_WRITE_INPUT_MAX_CHARS = 220_000;
export const MACHINE_TOOL_RESULT_MAX_CHARS = 20_000;
export const MACHINE_TOOL_ERROR_MAX_CHARS = 1_000;

export const MACHINE_READ_TOOL_NAMES = [
	"read_file",
	"search_code",
	"list_commits",
	"read_commit",
	"read_ci_runs",
	"read_ci_job_log",
	"read_runner_state",
] as const;
/** Tools that change a workspace on the machine or run a command in it. */
export const MACHINE_WRITE_TOOL_NAMES = [
	"open_workspace",
	"close_workspace",
	"write_file",
	"edit_file",
	"run_command",
] as const;
export const MACHINE_TOOL_NAMES = [
	...MACHINE_READ_TOOL_NAMES,
	...MACHINE_WRITE_TOOL_NAMES,
] as const;
export const MachineToolNameSchema = z.enum(MACHINE_TOOL_NAMES);
export type MachineToolName = z.infer<typeof MachineToolNameSchema>;
export function isMachineWriteTool(tool: string): boolean {
	return (MACHINE_WRITE_TOOL_NAMES as readonly string[]).includes(tool);
}

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

/**
 * The readable name a runner reports for its machine. The pattern is published
 * in the tool's JSON schema, where readers compile it without the `u` flag, so
 * it lists the control characters as code points instead of `\p{Cc}`.
 */
export const MachineNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(
		/^[^\u0000-\u001f\u007f-\u009f]+$/,
		"A machine name cannot hold control characters",
	);

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

/**
 * A workspace is a checkout of the repository that the machine's runner made
 * for the caller with `open_workspace`, apart from every other checkout.
 */
const WorkspaceIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Use the id open_workspace returned");

export const MACHINE_READ_FILE_MAX_LINES = 400;

export const MACHINE_TOOL_INPUT_SCHEMAS = {
	read_file: z
		.strictObject({
			path: RepositoryPathSchema,
			startLine: z.number().int().min(1).max(10_000_000).optional(),
			endLine: z.number().int().min(1).max(10_000_000).optional(),
			/** Read the file as it is in this workspace, not on the main branch. */
			workspace: WorkspaceIdSchema.optional(),
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
		/** Search the files as they are in this workspace. */
		workspace: WorkspaceIdSchema.optional(),
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
	open_workspace: z.strictObject({
		name: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and -")
			.optional(),
		/** A commit, branch or tag to start from; the main branch when omitted. */
		base: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/, "Use a commit or a branch")
			.optional(),
	}),
	close_workspace: z.strictObject({ workspace: WorkspaceIdSchema }),
	write_file: z.strictObject({
		workspace: WorkspaceIdSchema,
		path: RepositoryPathSchema,
		content: z.string().max(MACHINE_FILE_CONTENT_MAX_CHARS),
	}),
	edit_file: z.strictObject({
		workspace: WorkspaceIdSchema,
		path: RepositoryPathSchema,
		oldText: z
			.string()
			.min(1)
			.max(MACHINE_FILE_CONTENT_MAX_CHARS / 2),
		newText: z.string().max(MACHINE_FILE_CONTENT_MAX_CHARS / 2),
		replaceAll: z.boolean().optional(),
	}),
	run_command: z.strictObject({
		workspace: WorkspaceIdSchema,
		command: z
			.string()
			.min(1)
			.max(3_500)
			.regex(/^[^\0]+$/, "A command cannot hold a null character"),
		timeoutSeconds: z
			.number()
			.int()
			.min(1)
			.max(MACHINE_COMMAND_MAX_TIMEOUT_SECONDS)
			.optional(),
	}),
} as const satisfies Record<MachineToolName, z.ZodType>;

export type MachineToolInput = Record<string, string | number | boolean>;

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
	const maxChars =
		tool === "write_file" || tool === "edit_file"
			? MACHINE_WRITE_INPUT_MAX_CHARS
			: MACHINE_TOOL_INPUT_MAX_CHARS;
	if (JSON.stringify(parsed.data).length > maxChars)
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
			"The tool's input: read_file {path, startLine?, endLine?, workspace?}; search_code {pattern, pathPrefix?, maxResults?, workspace?}; list_commits {path?, limit?}; read_commit {sha}; read_ci_runs {sha?, limit?}; read_ci_job_log {jobId}; read_runner_state {}. On a machine that accepts the write tools: open_workspace {name?, base?}; close_workspace {workspace}; write_file {workspace, path, content}; edit_file {workspace, path, oldText, newText, replaceAll?}; run_command {workspace, command, timeoutSeconds?}",
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
				input: z.record(
					z.string(),
					z.union([z.string(), z.number(), z.boolean()]),
				),
			}),
		)
		.max(10),
	/**
	 * Present when the server can hold an open connection to the machine: where
	 * to open it and the ticket that opens it, valid for a minute. Over the
	 * connection calls arrive at once; without it the machine keeps polling.
	 */
	connection: z
		.object({
			url: z.string().max(500),
			ticket: z.string().max(2_000),
			expiresAt: z.iso.datetime(),
		})
		.optional(),
});

/** A list of machine tool calls reaches this far back when no start is given. */
export const MACHINE_TOOL_CALL_LIST_DEFAULT_RANGE_MS = 24 * 60 * 60_000;
/** The longest time range one list of machine tool calls may cover. */
export const MACHINE_TOOL_CALL_LIST_MAX_RANGE_MS = 7 * 24 * 60 * 60_000;

const MachineToolCallListTimestampSchema = z.iso
	.datetime({ offset: true })
	.transform((value) => new Date(value).toISOString());

/** Where the next page starts: the last call of this page. */
export const MachineToolCallListCursorSchema = z.strictObject({
	at: z.iso.datetime(),
	id: MachineToolCallIdSchema,
});

export const ListMachineToolCallsInputSchema = z.strictObject({
	machine: MachineNameSchema.optional().describe(
		"Only calls for this machine, named exactly as `list_machines` returns it",
	),
	from: MachineToolCallListTimestampSchema.optional().describe(
		"Inclusive start of the time the calls were made; defaults to 24 hours before `until`",
	),
	until: MachineToolCallListTimestampSchema.optional().describe(
		"Exclusive end of the time the calls were made; defaults to now. The range may cover at most 7 days",
	),
	writesOnly: z
		.boolean()
		.default(true)
		.describe(
			"Only calls that change a workspace or run a command (the default); false includes the read tools",
		),
	cursor: MachineToolCallListCursorSchema.optional().describe(
		"nextCursor from the previous page; keep the same machine, range and writesOnly",
	),
	limit: z.number().int().min(1).max(100).default(50),
});

export const ListedMachineToolCallSchema = z.object({
	callId: MachineToolCallIdSchema,
	machine: z.string(),
	tool: MachineToolNameSchema,
	/** The checked input exactly as it was stored for the machine. */
	input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
	status: MachineToolCallStatusSchema,
	requestedBy: z.object({
		type: z.enum(["user", "tedi"]),
		id: z.string(),
	}),
	createdAt: z.iso.datetime(),
	claimedAt: z.iso.datetime().optional(),
	finishedAt: z.iso.datetime().optional(),
	error: z.string().max(MACHINE_TOOL_ERROR_MAX_CHARS).optional(),
	/** The length of the stored result; the result itself is never listed. */
	resultChars: z.number().int().nonnegative().optional(),
});
export type ListedMachineToolCall = z.infer<typeof ListedMachineToolCallSchema>;

export const ListMachineToolCallsResultSchema = z.object({
	from: z.iso.datetime(),
	until: z.iso.datetime(),
	calls: z.array(ListedMachineToolCallSchema).max(100),
	nextCursor: MachineToolCallListCursorSchema.nullable(),
});
