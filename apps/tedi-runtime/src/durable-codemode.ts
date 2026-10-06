import { TEDI_DURABLE_CODE_EXECUTION_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
import {
	CodemodeConnector,
	type ConnectorTool,
	type ConnectorTools,
	createCodemodeRuntime,
	DynamicWorkerExecutor,
} from "@cloudflare/codemode";
import { shapeBoundedCodeModeResult } from "@tedix/tedi-codemode-core/bounded-result";
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { tediMcpConnectorInstructions } from "./durable-codemode-lifecycle";
import {
	bindDurableCodeRecovery,
	DurableCodePassCoordinator,
	type RecoverableCodemodeRuntimeHandle,
} from "./durable-codemode-recovery";
import type { TedixCodemodeRuntime } from "./durable-codemode-runtime";
import type { ChatToolSpec } from "./llm";
import { durableCodemodeRuntimeName } from "./durable-codemode-runtime-name";

const MAX_EXECUTIONS = 100;
const MAX_REVERSIBLE_WORKSPACE_CHARS = 250_000;

export interface DurableCodeMcpRuntime {
	ensureSynced(options?: { force?: boolean }): Promise<void>;
	getToolSpecs(): ChatToolSpec[];
	executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ReversibleWorkspaceWrite {
	previousContent: string | null;
}

export interface DurableCodeWorkspace {
	/** These capabilities execute at the storage owner; never emulate with separate RPC reads/writes. */
	writeReversibleFile?(
		path: string,
		content: string,
	): Promise<ReversibleWorkspaceWrite>;
	restoreFile?(
		path: string,
		expectedContent: string,
		previousContent: string | null,
	): Promise<void>;
	deleteFile(path: string): Promise<boolean>;
	diffContent(path: string, content: string): Promise<string>;
	readFile(path: string): Promise<string | null>;
	writeFile(path: string, content: string): Promise<void>;
}

function objectArgs(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function durableMethodName(toolName: string): string {
	return toolName.replace(/^tedix_mcp_/, "");
}

/**
 * Durable Code Mode connector over the tedi's existing outbound MCP client.
 * Auth and credentials remain in trusted host code; generated JavaScript only
 * sees the typed connector methods.
 */
class TediMcpConnector extends CodemodeConnector<Cloudflare.Env> {
	constructor(
		ctx: DurableObjectState,
		env: Cloudflare.Env,
		private readonly runtime: DurableCodeMcpRuntime,
	) {
		super(ctx, env);
	}

	name(): string {
		return "mcp";
	}

	protected override instructions(): string {
		return tediMcpConnectorInstructions();
	}

	protected async tools(): Promise<ConnectorTools> {
		await this.runtime.ensureSynced();
		const out: ConnectorTools = {};
		for (const spec of this.runtime.getToolSpecs()) {
			const originalName = spec.function.name;
			// A durable program must not recursively enter the stateless Code
			// Mode wrapper. It can discover and call the underlying tools directly.
			if (originalName === "tedix_mcp_code") continue;
			const name = durableMethodName(originalName);
			const requiresApproval = originalName === "tedix_mcp_call_tool";
			out[name] = {
				description: spec.function.description,
				inputSchema: spec.function.parameters,
				...(requiresApproval
					? { requiresApproval: true }
					: { replay: "reexecute" as const }),
				execute: async (args) =>
					this.runtime.executeTool(originalName, objectArgs(args)),
			};
		}
		return out;
	}
}

function stringField(
	value: unknown,
	name: string,
	maxLength = MAX_REVERSIBLE_WORKSPACE_CHARS,
	allowEmpty = false,
): string {
	const field = objectArgs(value)[name];
	if (typeof field !== "string" || (!allowEmpty && !field)) {
		throw new Error(
			`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
		);
	}
	if (field.length > maxLength) {
		throw new Error(
			`${name} exceeds the durable workspace limit (${maxLength})`,
		);
	}
	return field;
}

export class TediWorkspaceConnector extends CodemodeConnector<Cloudflare.Env> {
	constructor(
		ctx: DurableObjectState,
		env: Cloudflare.Env,
		private readonly workspace: DurableCodeWorkspace,
	) {
		super(ctx, env);
	}

	name(): string {
		return "workspace";
	}

	protected override instructions(): string {
		return [
			"This tedi's durable typed scratch workspace.",
			"Reads and diffs replay by re-execution. Writes pause for operator approval and retain bounded prior content for guarded rollback; a later edit prevents restoration.",
		].join(" ");
	}

	protected tools(): ConnectorTools {
		const pathSchema: NonNullable<ConnectorTool["inputSchema"]> = {
			type: "object",
			properties: { path: { type: "string", minLength: 1 } },
			required: ["path"],
			additionalProperties: false,
		};
		return {
			read_file: {
				description: "Read one UTF-8 file from the tedi's durable workspace.",
				inputSchema: pathSchema,
				replay: "reexecute",
				execute: async (args) => {
					const path = stringField(args, "path", 2_000);
					const content = await this.workspace.readFile(path);
					return content === null
						? { ok: false, error: "workspace_file_not_found", path }
						: { ok: true, path, content, bytes: content.length };
				},
			},
			diff_content: {
				description:
					"Diff proposed UTF-8 content against one durable workspace file without writing.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", minLength: 1 },
						content: {
							type: "string",
							maxLength: MAX_REVERSIBLE_WORKSPACE_CHARS,
						},
					},
					required: ["path", "content"],
					additionalProperties: false,
				},
				replay: "reexecute",
				execute: async (args) => {
					const path = stringField(args, "path", 2_000);
					const content = stringField(
						args,
						"content",
						MAX_REVERSIBLE_WORKSPACE_CHARS,
						true,
					);
					return {
						ok: true,
						path,
						diff: await this.workspace.diffContent(path, content),
					};
				},
			},
			write_file: {
				description:
					"Write one UTF-8 file to the durable workspace. Approval is required; prior content is logged for rollback.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", minLength: 1 },
						content: {
							type: "string",
							maxLength: MAX_REVERSIBLE_WORKSPACE_CHARS,
						},
					},
					required: ["path", "content"],
					additionalProperties: false,
				},
				requiresApproval: true,
				execute: async (args) => {
					const path = stringField(args, "path", 2_000);
					const content = stringField(
						args,
						"content",
						MAX_REVERSIBLE_WORKSPACE_CHARS,
						true,
					);
					if (!this.workspace.writeReversibleFile)
						throw new Error(
							"Workspace does not support owner-guarded reversible writes",
						);
					const { previousContent } = await this.workspace.writeReversibleFile(
						path,
						content,
					);
					return { ok: true, path, bytes: content.length, previousContent };
				},
				revert: async (args, result) => {
					const path = stringField(args, "path", 2_000);
					const previousContent = objectArgs(result).previousContent;
					if (previousContent !== null && typeof previousContent !== "string")
						throw new Error("Missing prior workspace content for rollback");
					if (!this.workspace.restoreFile)
						throw new Error(
							"Workspace does not support owner-guarded rollback",
						);
					const expectedContent = stringField(
						args,
						"content",
						MAX_REVERSIBLE_WORKSPACE_CHARS,
						true,
					);
					await this.workspace.restoreFile(
						path,
						expectedContent,
						previousContent,
					);
				},
			},
		};
	}
}

const coordinators = new WeakMap<
	DurableObjectState,
	DurableCodePassCoordinator
>();
function coordinatorFor(ctx: DurableObjectState) {
	let coordinator = coordinators.get(ctx);
	if (!coordinator) {
		coordinator = new DurableCodePassCoordinator();
		coordinators.set(ctx, coordinator);
	}
	return coordinator;
}

export async function createTediDurableCodemode(input: {
	ctx: DurableObjectState;
	env: Cloudflare.Env;
	loader: WorkerLoader;
	mcpRuntime: DurableCodeMcpRuntime;
	workspace: DurableCodeWorkspace;
	name: string;
}): Promise<RecoverableCodemodeRuntimeHandle> {
	const mcpConnector = new TediMcpConnector(
		input.ctx,
		input.env,
		input.mcpRuntime,
	);
	const workspaceConnector = new TediWorkspaceConnector(
		input.ctx,
		input.env,
		input.workspace,
	);
	const name = await durableCodemodeRuntimeName(input.name);
	const runtime = createCodemodeRuntime({
		ctx: input.ctx,
		name,
		maxExecutions: MAX_EXECUTIONS,
		connectors: [workspaceConnector, mcpConnector],
		executor: new DynamicWorkerExecutor({
			loader: withModelAuthoredCodeIsolation(input.loader, {
				surface: "tedi_durable_code",
				reason: "tedi_durable_authored_invocation",
			}),
			timeout: TEDI_DURABLE_CODE_EXECUTION_TIMEOUT_MS,
			globalOutbound: null,
		}),
		// Bound the model-facing result WITHOUT silent type degradation: an
		// oversized structured result becomes a detectable `__tedix_truncated`
		// envelope instead of a bare clipped string. The raw result is still
		// recorded on the execution — transformResult only reshapes the model view.
		transformResult: (result) => shapeBoundedCodeModeResult(result),
	});
	const ctx = input.ctx as DurableObjectState & {
		exports: { CodemodeRuntime: unknown };
		facets: {
			get(
				name: string,
				factory: () => { class: unknown },
			): Pick<TedixCodemodeRuntime, "recoverExecution" | "getExecution">;
		};
	};
	return bindDurableCodeRecovery({
		runtime,
		key: name,
		coordinator: coordinatorFor(input.ctx),
		recover: async (args) => {
			const facet = ctx.facets.get(`codemode:${name}`, () => ({
				class: ctx.exports.CodemodeRuntime,
			}));
			const row = await facet.getExecution(args.executionId);
			return facet.recoverExecution({
				...args,
				expectedUpdatedAt: row?.updatedAt ?? 0,
			});
		},
	});
}
