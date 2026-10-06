import { logTediMcpFailure } from "./mcp-failure-log";
import {
	isTediMcpToolReadOnly,
	requiredTediMcpToolScope,
} from "@tedix/mcp-shared/auth/scopes";
import type { ToolSet } from "ai";
/**
 * MCP endpoint mount for the tedi DO.
 *
 * Builds the tedi MCP surface and serves it via `mountMcp()` from
 * @tedix/mcp-shared. Surface = chat/session tools plus a Code Mode `code`
 * tool that mirrors the direct per-tedi `/mcp` surface.
 *
 * Code Mode is provided by `@tedix/tedi-codemode-core`. When the LOADER
 * binding is present we register the platform tools on an inner McpServer and
 * wrap them into the outer
 * `code` tool (with `codemode.__tools()` / `codemode.__doc({ name })`
 * discovery). The platform tools are also registered directly on the outer
 * server, so MCP clients can call deterministic body tools without nesting
 * through Code Mode.
 *
 * Auth is enforced at the Worker edge (apps/tedi-runtime/src/index.ts) via
 * `createMcpAuthMiddleware` from @tedix/mcp-shared/auth before the request
 * reaches the DO. This handler can assume the caller is authenticated and
 * scoped to the resolved tedi.
 */

import {
	registerResources,
	registerResourceTemplates,
} from "@tedix/mcp-shared/resources";
import { createMcpServer } from "@tedix/mcp-shared/server";
import type { McpTaskHandlers } from "@tedix/mcp-shared/tasks";
import {
	type McpCompletionRequest,
	type McpCompletionResult,
	enforceModernMcpProtocol,
	mountMcp,
} from "@tedix/mcp-shared/transport";
import { buildWwwAuthenticate } from "@tedix/mcp-shared/auth";
import { registerCodeModeTools } from "@tedix/tedi-codemode-core/register-codemode-tools";
import type { CodeModeExtras } from "@tedix/tedi-codemode-core/types";
import * as z from "zod";
import { shouldHydrateCodeModeForMcpRequest } from "./mcp-code-mode-hydration";
import {
	canCallTediMcpTool,
	decodeTediMcpCaller,
	type TediMcpCaller,
} from "./mcp-authorization";
import { nativeDirectTediTaskResult } from "./mcp-task-result";

const CODE_MODE_TIMEOUT_MS = 300_000;

export interface AgentMcpTools {
	computerTools?: ToolSet;
	recordMcpAuditEvent?: (event: TediMcpAuditEvent) => Promise<void>;
	/** Direct per-tedi projection of durable runtime runs as MCP Tasks. */
	taskHandlers?: McpTaskHandlers;
	/** Start generated code on this tedi's durable Code Mode facet. */
	runDurableCode?: (input: { code: string }) => Promise<unknown>;
	/** Search durable Code Mode connector methods and saved snippets. */
	searchDurableCode?: (input: { query: string }) => Promise<unknown>;
	/** Describe one durable Code Mode connector method or saved snippet. */
	describeDurableCode?: (input: { target: string }) => Promise<unknown>;
	/** Read one durable Code Mode execution. */
	getCodeExecution?: (input: { execution_id: string }) => Promise<unknown>;
	/** List this tedi's durable Code Mode execution history. */
	listCodeExecutions?: (input: { limit?: number }) => Promise<unknown>;
	/** Approve the next pending action and resume the exact recorded program. */
	approveCodeExecution?: (input: { execution_id: string }) => Promise<unknown>;
	/** Reject one pending action and terminate its durable execution. */
	rejectCodeExecution?: (input: {
		execution_id: string;
		seq: number;
	}) => Promise<unknown>;
	/** Run registered connector compensations in reverse order. */
	rollbackCodeExecution?: (input: { execution_id: string }) => Promise<unknown>;
	recoverCodeExecution?: (input: { execution_id: string }) => Promise<unknown>;
	/**
	 * Read-only D1 audit of this tedi's durable memory facts. Intended for
	 * provenance and quality inspection where fuzzy graph search is insufficient.
	 */
	brainAudit?: (input: BrainAuditMcpInput) => Promise<unknown>;
	conversationGet: (input: { session_key: string }) => Promise<unknown>;
	conversationsList: (input: { limit?: number }) => Promise<unknown>;
	messagesRead: (input: {
		session_key: string;
		limit?: number;
	}) => Promise<unknown>;
	messagesSend: (input: {
		session_key: string;
		text: string;
		trace_id?: string;
		/**
		 * STABLE client-generated id for this message — the turnKey for the turn's
		 * runId. A redelivery carrying the same id dedups to the same runId, so the
		 * caller (mesh sender) MUST supply it; there is no server-side fallback.
		 */
		client_request_id: string;
		/**
		 * Optional attachments (base64-`content` data URLs). Audio is transcribed
		 * at the body via `@tedix/voice/stt`; non-audio files are surfaced as a
		 * context note. Lets a Tedix OS voice-only note (empty `text`) carry the clip.
		 */
		attachments?: Array<{
			content: string;
			fileName: string;
			mimeType: string;
			type: "audio" | "file" | "image";
		}>;
	}) => Promise<unknown>;
	/**
	 * Read any assigned MCP resource by server ID + URI — the progressive
	 * disclosure reader for skill:// guidance. Mirrors the chat loop's
	 * `mcp_read_resource` AI SDK tool so external MCP callers get the same
	 * skills-over-MCP surface as the model. Optional: omitted when the tedi has
	 * no MCP runtime bound (e.g. unauthenticated edge probes).
	 */
	readResource?: (input: { server: string; uri: string }) => Promise<unknown>;
	/**
	 * Read direct children of an assigned MCP directory resource. Complements
	 * `readResource` for the Skills extension's optional directoryRead flow.
	 */
	readDirectory?: (input: {
		cursor?: string;
		server: string;
		uri: string;
	}) => Promise<unknown>;
	/**
	 * Cross-tedi mesh send: deliver a message to a PEER tedi in the SAME
	 * organization and return its reply. The peer runs the message through its
	 * own canonical loop (session + ledger + brain + tools), so it lands a
	 * first-class turn on the receiving side. Server-internal DO→DO path — no
	 * peer MCP token required. Optional: omitted when the tedi has no mesh
	 * capability bound (e.g. unauthenticated edge probes).
	 */
	sendTediMessage?: (input: {
		target: string;
		text: string;
		session_key?: string;
		client_request_id: string;
	}) => Promise<unknown>;
	/**
	 * Manage this tedi's cron jobs (list/add/remove/status/run). Backed
	 * by the Agents SDK durable scheduler (`schedule`/`scheduleEvery`/
	 * `listSchedules`/`cancelSchedule`) on the DO — SQLite-persisted, alarm-woken.
	 * A fired job injects its message as a real tedi turn (parity with the
	 * `agentTurn` routing). Optional: omitted on unauthenticated edge probes.
	 */
	cron?: (input: CronToolInput) => Promise<unknown>;
	/**
	 * Propose committing durable workspace repo/ edits through the approval-gated
	 * GitHub API path. This never writes directly from the MCP call.
	 */
	repoCommit?: (input: RepoCommitMcpInput) => Promise<unknown>;
	/** Read sanitized repo_commit execution status without executing drains. */
	repoCommitStatus?: (input: RepoCommitStatusMcpInput) => Promise<unknown>;
	/** Drain approved/rejected repo_commit approvals and report ledger status. */
	repoCommitDrain?: (input: RepoCommitDrainMcpInput) => Promise<unknown>;
	/**
	 * List files in the tedi's canonical Cloudflare Artifacts repo — the
	 * durable, tenant-owned small-state store for skill workflows and other
	 * automation. Distinct
	 * from the scratch workspace above.
	 */
	listArtifactFiles?: (input: {
		prefix?: string;
		limit?: number;
	}) => Promise<unknown>;
	/** Read one UTF-8 text file from the tedi's canonical Artifacts repo. */
	readArtifactFile?: (input: {
		path: string;
		maxChars?: number;
	}) => Promise<unknown>;
	/**
	 * Write one UTF-8 text file to the tedi's canonical Artifacts repo — git-
	 * committed and pushed. Use for small durable state that should survive
	 * between skill-workflow runs.
	 */
	writeArtifactFile?: (input: {
		path: string;
		content: string;
		message?: string;
	}) => Promise<unknown>;
}

export interface TediMcpAuditEvent {
	action: "mcp.tool.denied" | "mcp.tool.execute";
	actorId: string;
	actorType: TediMcpCaller["principalType"];
	metadata: Record<string, unknown>;
	resourceId: string;
}

/**
 * Input contract for the tedi `cron` tool. Payload is an `agentTurn` message
 * (no shell `command` channel — the Agent runtime has no shell), and all three
 * schedule kinds (`at`/`every`/`cron`) are natively supported.
 */
export type CronToolInput = {
	action: "list" | "add" | "remove" | "status" | "run";
	job?: {
		name?: string;
		schedule?: {
			kind?: "at" | "every" | "cron";
			/** kind=at: ISO-8601 timestamp for one-shot execution. */
			at?: string;
			/** kind=every: fixed interval in milliseconds. */
			everyMs?: number;
			/** kind=cron: a 5/6-field cron expression. */
			expr?: string;
			/** Best-effort IANA tz label (recorded; SDK cron uses the host clock). */
			tz?: string;
		};
		/**
		 * TTL stop-contract: explicit expiry for a recurring job (ISO-8601,
		 * future, ≤365d). Absent → 30d default. Renewal = re-add the same name.
		 */
		expiresAt?: string;
		payload?: {
			kind?: "agentTurn" | "systemEvent";
			message?: string;
			text?: string;
		};
		/** "main" / "session:<key>" — defaults to the tedi's main session. */
		sessionTarget?: string;
		/** Convenience shorthand for payload.message. */
		message?: string;
	};
	/** remove/run: the schedule id (alias: `id`). */
	jobId?: string;
	id?: string;
};

export type BrainAuditMcpInput = {
	scope?: "self" | "org" | "visible" | "all";
	topic_key_state?: "any" | "missing" | "present";
	review_status?: string;
	priority?: string;
	use_policy?: string;
	fact_type?: string;
	status?: string;
	source_session_id?: string;
	source_prefix?: string;
	producer?: string;
	search?: string;
	include_archived?: boolean;
	limit?: number;
	offset?: number;
	order_by?: "created_desc" | "updated_desc";
};

export type RepoCommitMcpInput = {
	baseRef?: string;
	branch: string;
	deletePaths?: string[];
	message: string;
	openPr?: boolean;
	paths: string[];
	prBase?: string;
};

export type RepoCommitDrainMcpInput = {
	approvalRequestId?: string;
	executionLedgerId?: string;
};

export type RepoCommitStatusMcpInput = {
	approvalRequestId?: string;
	executionLedgerId?: string;
};

function enforceToolAuthorization(
	server: ReturnType<typeof createMcpServer>,
	caller: TediMcpCaller,
	traceId?: string,
	recordAuditEvent?: AgentMcpTools["recordMcpAuditEvent"],
): void {
	const target = server as unknown as {
		registerTool: (...args: unknown[]) => unknown;
	};
	const registerTool = target.registerTool.bind(server);
	target.registerTool = (...args: unknown[]) => {
		const [name, options, handler] = args;
		if (
			typeof name !== "string" ||
			!options ||
			typeof options !== "object" ||
			typeof handler !== "function"
		) {
			return registerTool(...args);
		}
		const readOnly =
			(options as { annotations?: { readOnlyHint?: boolean } }).annotations
				?.readOnlyHint === true;
		const scopeToolName =
			name === "code" && caller.delegatedToolName
				? caller.delegatedToolName
				: name;
		const requiredScope = requiredTediMcpToolScope(scopeToolName, readOnly);
		if (!canCallTediMcpTool(caller, scopeToolName, readOnly)) return undefined;
		const authorizedHandler = async (...handlerArgs: unknown[]) => {
			const startedAt = Date.now();
			let outcome = "error";
			let resultDigest: string | null = null;
			try {
				const result = await (handler as (...values: unknown[]) => unknown)(
					...handlerArgs,
				);
				try {
					const bytes = new TextEncoder().encode(
						(JSON.stringify(result) ?? "null").slice(0, 65_536),
					);
					const digest = await crypto.subtle.digest("SHA-256", bytes);
					resultDigest = Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join("");
				} catch {
					resultDigest = null;
				}
				outcome = "success";
				return result;
			} finally {
				const durationMs = Date.now() - startedAt;
				console.info(
					JSON.stringify({
						event: "tedi.mcp.tool.completed",
						tool: name,
						principalId: caller.principalId,
						principalType: caller.principalType,
						authMethod: caller.method,
						requiredScope,
						decision: "allowed",
						outcome,
						resultDigest,
						durationMs,
						traceId: traceId ?? null,
					}),
				);
				if (recordAuditEvent) {
					try {
						await recordAuditEvent({
							action: "mcp.tool.execute",
							actorId: caller.principalId,
							actorType: caller.principalType,
							resourceId: name,
							metadata: {
								authMethod: caller.method,
								decision: "allowed",
								durationMs,
								outcome,
								requiredScope,
								resultDigest,
								traceId: traceId ?? null,
							},
						});
					} catch (error) {
						logTediMcpFailure("tedi.mcp.audit_execute_failed", error);
					}
				}
			}
		};
		return registerTool(name, options, authorizedHandler);
	};
}

export async function rejectUnauthorizedToolCall(
	request: Request,
	caller: TediMcpCaller,
	recordAuditEvent?: AgentMcpTools["recordMcpAuditEvent"],
): Promise<Response | null> {
	const declaredMethod = request.headers.get("Mcp-Method")?.trim();
	if (declaredMethod && declaredMethod !== "tools/call") return null;
	let payload: unknown;
	try {
		payload = await request.clone().json();
	} catch {
		return null;
	}
	if (!payload || typeof payload !== "object") return null;
	const rpc = payload as {
		id?: unknown;
		method?: unknown;
		params?: { name?: unknown };
	};
	if (rpc.method !== "tools/call" || typeof rpc.params?.name !== "string") {
		return null;
	}
	const toolName = rpc.params.name;
	const scopeToolName =
		toolName === "code" && caller.delegatedToolName
			? caller.delegatedToolName
			: toolName;
	const readOnly = isTediMcpToolReadOnly(scopeToolName);
	const requiredScope = requiredTediMcpToolScope(scopeToolName, readOnly);
	if (canCallTediMcpTool(caller, scopeToolName, readOnly)) return null;
	const hostname = new URL(request.url).hostname;
	console.warn(
		JSON.stringify({
			event: "tedi.mcp.tool.denied",
			tool: toolName,
			principalId: caller.principalId,
			principalType: caller.principalType,
			authMethod: caller.method,
			requiredScope,
			decision: "denied",
			traceId: requestTraceId(request) ?? null,
		}),
	);
	if (recordAuditEvent) {
		try {
			await recordAuditEvent({
				action: "mcp.tool.denied",
				actorId: caller.principalId,
				actorType: caller.principalType,
				resourceId: toolName,
				metadata: {
					authMethod: caller.method,
					decision: "denied",
					requiredScope,
					traceId: requestTraceId(request) ?? null,
				},
			});
		} catch (error) {
			logTediMcpFailure("tedi.mcp.audit_denial_failed", error);
		}
	}
	return Response.json(
		{
			jsonrpc: "2.0",
			id: rpc.id ?? null,
			error: {
				code: -32003,
				message: "Insufficient scope",
				data: { error: "insufficient_scope", required_scope: requiredScope },
			},
		},
		{
			status: 403,
			headers: {
				"WWW-Authenticate": buildWwwAuthenticate(
					hostname,
					"insufficient_scope",
					`Required scope: ${requiredScope}`,
					requiredScope,
				),
			},
		},
	);
}

export async function handleMcp(
	request: Request,
	tediSlug: string,
	tools: AgentMcpTools,
	env?: {
		LOADER?: WorkerLoader;
		codeModeExtras?: CodeModeExtras;
		codeModeExtraInstructions?: string[];
	},
): Promise<Response> {
	const protocolError = enforceModernMcpProtocol(request);
	if (protocolError) return protocolError;
	const traceId = requestTraceId(request);
	const caller = decodeTediMcpCaller(request);
	if (!caller) {
		return Response.json(
			{
				error: "invalid_token",
				message: "Missing edge-derived MCP caller context",
			},
			{ status: 401 },
		);
	}
	const denied = await rejectUnauthorizedToolCall(
		request,
		caller,
		tools.recordMcpAuditEvent,
	);
	if (denied) return denied;
	// Prompts and resources are config-driven: content comes from files in the
	// tedi's Artifacts repo (`prompts/*.md` for prompts, any repo file for
	// resources), so the surface only implements prompts/* and resources/* when
	// both artifact readers are bound. Constructing the server WITH those
	// capabilities installs the SDK's prompts/list + prompts/get and
	// resources/list + resources/read + resources/templates/list handlers up
	// front, so an empty repo serves honest empty lists instead of "Method not
	// found". listChanged is false: this transport is stateless, so no
	// list_changed notification can ever be delivered.
	const artifactTools =
		tools.listArtifactFiles && tools.readArtifactFile
			? {
					listArtifactFiles: tools.listArtifactFiles,
					readArtifactFile: tools.readArtifactFile,
				}
			: undefined;
	const server = createMcpServer(
		{
			name: `tedi-runtime-${tediSlug}`,
			version: "0.1.0",
		},
		artifactTools
			? {
					capabilities: {
						prompts: { listChanged: false },
						resources: { listChanged: false },
					},
				}
			: undefined,
	);

	const loader = env?.LOADER;

	enforceToolAuthorization(server, caller, traceId, tools.recordMcpAuditEvent);
	registerPlatformTools(server, tools, traceId);

	// The server is rebuilt per request, so the bounded Artifacts read behind
	// prompt registration is gated on the request actually being a prompts/*
	// method — modern callers declare it via the SEP-2243 `Mcp-Method` header.
	// A prompts/* call WITHOUT the header serves the empty list installed
	// above (legacy callers lose nothing they had: the surface was tools-only).
	const mcpMethod = request.headers.get("Mcp-Method")?.trim() ?? "";
	if (artifactTools && mcpMethod.startsWith("prompts/")) {
		await registerTediPrompts(server, artifactTools, mcpMethod);
	}

	// Same SEP-2243 gate for resources/*: the `artifact:///{+file_path}`
	// template registers I/O-free (covers resources/read of any path plus
	// resources/templates/list); only resources/list pays the bounded Artifacts
	// listing. Other requests see zero added I/O.
	if (artifactTools && mcpMethod.startsWith("resources/")) {
		await registerTediArtifactResources(server, artifactTools, mcpMethod);
	}

	if (loader && (await shouldHydrateCodeModeForMcpRequest(request))) {
		const innerServer = createMcpServer({
			name: `tedi-runtime-${tediSlug}-inner`,
			version: "0.1.0",
		});
		enforceToolAuthorization(
			innerServer,
			caller,
			traceId,
			tools.recordMcpAuditEvent,
		);
		registerPlatformTools(innerServer, tools, traceId);
		try {
			await registerCodeModeTools(server, innerServer, {
				loader,
				tediId: tediSlug,
				timeoutMs: CODE_MODE_TIMEOUT_MS,
				traceContext: { surface: "tedi-runtime-mcp", traceId },
				extras: env?.codeModeExtras,
				extraInstructions: env?.codeModeExtraInstructions,
			});
		} catch (err) {
			console.warn(
				`[tedi-runtime-mcp] Code Mode setup failed (${
					err instanceof Error ? err.message : String(err)
				}), falling back to standard tools.`,
			);
		}
	}

	const origin = request.headers.get("Origin") ?? "*";
	return mountMcp(server, request, {
		route: "/mcp",
		cors: { origin },
		discover: {
			serverInfo: {
				name: `tedi-runtime-${tediSlug}`,
				version: "0.1.0",
			},
			// `prompts`/`resources` mirror the edge's static declaration in
			// apps/mcp (the transport does not auto-derive them): declared
			// whenever the artifact readers are bound, because the discover
			// request itself never carries a prompts/* or resources/* Mcp-Method
			// — gating the declaration on a successful per-request listing would
			// mean the capabilities are never advertised.
			capabilities: {
				tools: {},
				...(artifactTools ? { prompts: {}, resources: {} } : {}),
			},
		},
		taskHandlers: tools.taskHandlers,
		// 2026-07-28 completion/complete: the transport implements the method and
		// auto-advertises the `completions` capability when a handler is mounted.
		completionHandler: buildTediCompletionHandler(tools),
	});
}

/**
 * Argument autocompletion for the tedi's own tools.
 * Candidates come from bounded reads the surface already owns:
 * `session_key`/`conversationId` from the conversation summaries, artifact
 * `path`/`prefix` from the Artifacts repo listing. Best-effort — a failed
 * candidate read degrades to no suggestions, never an error.
 */
export function buildTediCompletionHandler(
	tools: Pick<AgentMcpTools, "conversationsList" | "listArtifactFiles">,
): (input: McpCompletionRequest) => Promise<McpCompletionResult> {
	const pick = (
		values: Array<string | null | undefined>,
		partial: string,
	): McpCompletionResult => ({
		values: [
			...new Set(
				values.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				),
			),
		]
			.filter((value) => value.toLowerCase().startsWith(partial))
			.slice(0, 25),
	});
	return async ({ argument }) => {
		const argName = argument.name.trim().toLowerCase();
		const partial = (argument.value ?? "").toLowerCase();
		try {
			if (argName === "session_key" || argName === "conversationid") {
				const result = (await tools.conversationsList({ limit: 100 })) as {
					conversations?: Array<{ sessionKey?: string }>;
				};
				return pick(
					(result.conversations ?? []).map((entry) => entry.sessionKey),
					partial,
				);
			}
			if (
				(argName === "path" || argName === "prefix") &&
				tools.listArtifactFiles
			) {
				const result = (await tools.listArtifactFiles({ limit: 200 })) as {
					// Live DO shape is a plain string[] of paths
					// (listArtifactFilesTool in do.ts); tolerate object entries too.
					files?: Array<string | { path?: string; name?: string }>;
				};
				return pick(
					(result.files ?? []).map((file) =>
						typeof file === "string" ? file : (file.path ?? file.name),
					),
					partial,
				);
			}
		} catch {
			// Best-effort completion: candidate-source failures yield no values.
		}
		return { values: [] };
	};
}

/** Artifacts repo prefix that holds this tedi's MCP prompt files. */
const TEDI_PROMPTS_PREFIX = "prompts/";
/** Bounded listing size for prompt registration (one file = one prompt). */
const TEDI_PROMPT_LIST_LIMIT = 50;
/** Bounded head-read used only to derive prompts/list descriptions. */
const TEDI_PROMPT_DESCRIPTION_READ_CHARS = 600;
/** Cap on a derived prompt description (heading/first line, trimmed). */
const TEDI_PROMPT_DESCRIPTION_MAX_CHARS = 200;
/**
 * `prompts/<name>.md` → prompt name. Direct children only (no `/`), and the
 * name must be a host-safe slash-command token.
 */
const TEDI_PROMPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface TediPromptDescriptor {
	/** Prompt name: the `prompts/` filename without its `.md` extension. */
	name: string;
	/** Full Artifacts repo path, e.g. `prompts/weekly-report.md`. */
	path: string;
}

/**
 * Derive prompt descriptors from an `artifact_list_files` result. Accepts both
 * the live DO shape (`files: string[]` of repo paths) and object entries
 * (`{ path }` / `{ name }`). One `prompts/<name>.md` file = one prompt.
 * Non-markdown files, nested directories, unsafe names, and duplicates are
 * skipped. Pure — exported for tests.
 */
export function deriveTediPromptDescriptors(
	listing: unknown,
): TediPromptDescriptor[] {
	const files = (listing as { files?: unknown } | null | undefined)?.files;
	if (!Array.isArray(files)) return [];
	const seen = new Set<string>();
	const descriptors: TediPromptDescriptor[] = [];
	for (const entry of files) {
		const record =
			entry && typeof entry === "object"
				? (entry as { path?: unknown; name?: unknown })
				: undefined;
		const path =
			typeof entry === "string"
				? entry
				: typeof record?.path === "string"
					? record.path
					: typeof record?.name === "string"
						? record.name
						: null;
		if (!path?.startsWith(TEDI_PROMPTS_PREFIX)) continue;
		const relative = path.slice(TEDI_PROMPTS_PREFIX.length);
		if (!relative.toLowerCase().endsWith(".md")) continue;
		const name = relative.slice(0, -".md".length);
		if (!TEDI_PROMPT_NAME_PATTERN.test(name)) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		descriptors.push({ name, path });
		if (descriptors.length >= TEDI_PROMPT_LIST_LIMIT) break;
	}
	return descriptors;
}

/**
 * Prompt description from a prompt file body: the first markdown heading, or
 * the first non-empty line when the file has no heading; `fallback` when the
 * body is effectively empty. Pure — exported for tests.
 */
export function tediPromptDescription(body: string, fallback: string): string {
	const lines = body.split(/\r?\n/);
	let firstLine: string | undefined;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.+)$/.exec(line);
		if (heading) return clampPromptDescription(heading[1]!.trim(), fallback);
		firstLine ??= line;
	}
	return firstLine ? clampPromptDescription(firstLine, fallback) : fallback;
}

function clampPromptDescription(text: string, fallback: string): string {
	if (!text) return fallback;
	return text.length > TEDI_PROMPT_DESCRIPTION_MAX_CHARS
		? `${text.slice(0, TEDI_PROMPT_DESCRIPTION_MAX_CHARS - 1)}…`
		: text;
}

/**
 * Extract the UTF-8 body from an `artifact_read_file` result, or null when
 * the read failed / returned no content. Pure — exported for tests.
 */
export function artifactFileContent(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const record = result as { ok?: unknown; content?: unknown };
	if (record.ok === false) return null;
	return typeof record.content === "string" ? record.content : null;
}

/**
 * `prompts/get` payload for a prompt file body: exactly one user message whose
 * text is the file body. Pure — exported for tests.
 */
export function tediPromptMessages(body: string): {
	messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
} {
	return {
		messages: [
			{ role: "user", content: { type: "text" as const, text: body } },
		],
	};
}

/**
 * Register this tedi's Artifacts-repo prompts (`prompts/*.md`) on the
 * per-request server. Only called when the SEP-2243 `Mcp-Method` header names
 * a prompts/* method, so the I/O stays bounded and off every other request:
 *
 * - one `listArtifactFiles` call (limit {@link TEDI_PROMPT_LIST_LIMIT});
 * - for `prompts/list` only, one bounded head-read per file to derive the
 *   description (first heading / first line);
 * - for `prompts/get`, no eager reads — the invoked prompt's callback reads
 *   its full body lazily (one read for the single requested prompt).
 *
 * Best-effort: a failed listing registers nothing (the constructor-installed
 * prompts capability still serves an empty list); a failed description read
 * falls back to the prompt name.
 */
export async function registerTediPrompts(
	server: ReturnType<typeof createMcpServer>,
	tools: Required<
		Pick<AgentMcpTools, "listArtifactFiles" | "readArtifactFile">
	>,
	mcpMethod: string,
): Promise<void> {
	let descriptors: TediPromptDescriptor[];
	try {
		descriptors = deriveTediPromptDescriptors(
			await tools.listArtifactFiles({
				prefix: TEDI_PROMPTS_PREFIX,
				limit: TEDI_PROMPT_LIST_LIMIT,
			}),
		);
	} catch {
		return;
	}
	const descriptions =
		mcpMethod === "prompts/get"
			? descriptors.map((descriptor) => descriptor.name)
			: await Promise.all(
					descriptors.map(async (descriptor) => {
						try {
							const body = artifactFileContent(
								await tools.readArtifactFile({
									path: descriptor.path,
									maxChars: TEDI_PROMPT_DESCRIPTION_READ_CHARS,
								}),
							);
							return body === null
								? descriptor.name
								: tediPromptDescription(body, descriptor.name);
						} catch {
							return descriptor.name;
						}
					}),
				);
	descriptors.forEach((descriptor, index) => {
		server.registerPrompt(
			descriptor.name,
			{ title: descriptor.name, description: descriptions[index] },
			async () => {
				const body = artifactFileContent(
					await tools.readArtifactFile({ path: descriptor.path }),
				);
				if (body === null) {
					throw new Error(
						`Prompt file ${descriptor.path} is unavailable in the Artifacts repo`,
					);
				}
				return {
					description: tediPromptDescription(body, descriptor.name),
					...tediPromptMessages(body),
				};
			},
		);
	});
}

/** URI prefix for this tedi's Artifacts-repo files exposed as MCP resources. */
const TEDI_ARTIFACT_URI_PREFIX = "artifact:///";
/** RFC 6570 template resolving any Artifacts repo path to a resource URI. */
const TEDI_ARTIFACT_URI_TEMPLATE = "artifact:///{+file_path}";
/** Bounded listing size for resources/list (one file = one resource). */
const TEDI_ARTIFACT_RESOURCE_LIST_LIMIT = 200;

export interface TediArtifactResourceDescriptor {
	/** Full Artifacts repo path, e.g. `memory/MEMORY.md` or `repo/src/index.ts`. */
	path: string;
	/** Resource URI: {@link TEDI_ARTIFACT_URI_PREFIX} + path. */
	uri: string;
	/** MIME type derived from the path extension. */
	mimeType: string;
}

/**
 * MIME type for an Artifacts repo path — the local mirror of the edge's
 * `skillFileMimeType` mapping (apps/mcp tool-registration.ts). Pure — exported
 * for tests.
 */
export function artifactResourceMimeType(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".md")) return "text/markdown";
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml"))
		return "application/yaml";
	if (lower.endsWith(".sh")) return "text/x-shellscript";
	if (lower.endsWith(".py")) return "text/x-python";
	if (lower.endsWith(".js") || lower.endsWith(".ts")) return "text/javascript";
	return "text/plain";
}

/**
 * Derive resource descriptors from an `artifact_list_files` result. Accepts
 * both the live DO shape (`files: string[]` of repo paths) and object entries
 * (`{ path }` / `{ name }`). Every listed path becomes a resource — including
 * `.r2/` notes and `repo/` files — with no filtering beyond deduplication and
 * the {@link TEDI_ARTIFACT_RESOURCE_LIST_LIMIT} cap. Pure — exported for tests.
 */
export function deriveTediArtifactResourceDescriptors(
	listing: unknown,
): TediArtifactResourceDescriptor[] {
	const files = (listing as { files?: unknown } | null | undefined)?.files;
	if (!Array.isArray(files)) return [];
	const seen = new Set<string>();
	const descriptors: TediArtifactResourceDescriptor[] = [];
	for (const entry of files) {
		const record =
			entry && typeof entry === "object"
				? (entry as { path?: unknown; name?: unknown })
				: undefined;
		const path =
			typeof entry === "string"
				? entry
				: typeof record?.path === "string"
					? record.path
					: typeof record?.name === "string"
						? record.name
						: null;
		if (!path) continue;
		if (seen.has(path)) continue;
		seen.add(path);
		descriptors.push({
			path,
			uri: `${TEDI_ARTIFACT_URI_PREFIX}${path}`,
			mimeType: artifactResourceMimeType(path),
		});
		if (descriptors.length >= TEDI_ARTIFACT_RESOURCE_LIST_LIMIT) break;
	}
	return descriptors;
}

/**
 * resources/read envelope for one Artifacts repo file: lazy single read via
 * `artifact_read_file`. A missing/unreadable file fails loudly, naming the
 * path (mirrors the edge's resourceNotFound semantics — that helper lives in
 * apps/mcp and is not importable here). Exported for tests.
 */
export async function readTediArtifactResource(
	tools: Required<Pick<AgentMcpTools, "readArtifactFile">>,
	path: string,
	uri: string,
): Promise<{
	contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
	const body = artifactFileContent(await tools.readArtifactFile({ path }));
	if (body === null) {
		throw new Error(
			`Artifact file ${path} is unavailable in the Artifacts repo`,
		);
	}
	return {
		contents: [{ uri, mimeType: artifactResourceMimeType(path), text: body }],
	};
}

/**
 * Register this tedi's Artifacts-repo files as MCP resources on the
 * per-request server. Only called when the SEP-2243 `Mcp-Method`
 * header names a resources/* method, so the I/O stays bounded and off every
 * other request:
 *
 * - the `artifact:///{+file_path}` ResourceTemplate always registers with NO
 *   I/O — it serves resources/templates/list and lets resources/read resolve
 *   any repo path, listed or not, via one lazy `readArtifactFile`;
 * - for `resources/list` only, one `listArtifactFiles` call (limit
 *   {@link TEDI_ARTIFACT_RESOURCE_LIST_LIMIT}) registers each listed path as a
 *   static resource whose name/description is the path — no per-file reads.
 *
 * Best-effort: a failed listing registers only the template (the
 * constructor-installed resources capability still serves an empty list).
 */
export async function registerTediArtifactResources(
	server: ReturnType<typeof createMcpServer>,
	tools: Required<
		Pick<AgentMcpTools, "listArtifactFiles" | "readArtifactFile">
	>,
	mcpMethod: string,
): Promise<void> {
	registerResourceTemplates(server, [
		{
			id: "tedi-artifact-file",
			uriTemplate: TEDI_ARTIFACT_URI_TEMPLATE,
			description:
				"Any UTF-8 text file in this tedi's canonical Artifacts repo. URI: artifact:///{+file_path}",
			handler: async (uri, variables) => {
				const raw = variables.file_path;
				const path = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
				return readTediArtifactResource(tools, path, uri.toString());
			},
		},
	]);
	if (mcpMethod !== "resources/list") return;
	let descriptors: TediArtifactResourceDescriptor[];
	try {
		descriptors = deriveTediArtifactResourceDescriptors(
			await tools.listArtifactFiles({
				limit: TEDI_ARTIFACT_RESOURCE_LIST_LIMIT,
			}),
		);
	} catch {
		return;
	}
	registerResources(
		server,
		descriptors.map((descriptor) => ({
			id: descriptor.path,
			uri: descriptor.uri,
			// Path-derived description: resources/list must not read file bodies.
			description: descriptor.path,
			mimeType: descriptor.mimeType,
			handler: () =>
				readTediArtifactResource(tools, descriptor.path, descriptor.uri),
		})),
	);
}

function requestTraceId(request: Request): string | undefined {
	const explicit = request.headers.get("X-Trace-Id")?.trim();
	if (explicit) return explicit;
	const traceparent = request.headers.get("traceparent")?.trim();
	if (!traceparent) return undefined;
	const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(
		traceparent,
	);
	if (!match) return undefined;
	const hex = match[1]!.toLowerCase();
	if (hex === "0".repeat(32)) return undefined;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function registerPlatformTools(
	server: ReturnType<typeof createMcpServer>,
	tools: AgentMcpTools,
	traceId?: string,
): void {
	if (tools.runDurableCode) {
		server.registerTool(
			"run_durable_code",
			{
				title: "run_durable_code",
				description: [
					"Run generated JavaScript on this tedi's durable Code Mode runtime.",
					"Use for multi-call programs, side effects, or work that may pause for approval. The execution log survives Durable Object hibernation and deploys.",
					"Use the gateway `code` tool for bounded read-only batches, a direct tool for one known call, and a Workflow for known long-running orchestration.",
				].join(" "),
				inputSchema: {
					code: z.string().min(1).max(1_000_000),
				},
				annotations: { readOnlyHint: false },
			},
			async ({ code }) => jsonToolResult(await tools.runDurableCode!({ code })),
		);
	}

	if (tools.searchDurableCode) {
		server.registerTool(
			"search_durable_code",
			{
				title: "search_durable_code",
				description:
					"Search this tedi's durable Code Mode connector methods and saved snippets. Results identify methods that require approval.",
				inputSchema: { query: z.string().min(1).max(500) },
				annotations: { readOnlyHint: false },
			},
			async ({ query }) =>
				jsonToolResult(await tools.searchDurableCode!({ query })),
		);
	}

	if (tools.describeDurableCode) {
		server.registerTool(
			"describe_durable_code",
			{
				title: "describe_durable_code",
				description:
					"Get TypeScript documentation for one durable Code Mode connector method or saved snippet.",
				inputSchema: { target: z.string().min(1).max(500) },
				annotations: { readOnlyHint: true },
			},
			async ({ target }) =>
				jsonToolResult(await tools.describeDurableCode!({ target })),
		);
	}

	if (tools.getCodeExecution) {
		server.registerTool(
			"get_code_execution",
			{
				title: "get_code_execution",
				description: "Read one durable Code Mode execution and its replay log.",
				inputSchema: { execution_id: z.string().min(1) },
				annotations: { readOnlyHint: true },
			},
			async ({ execution_id }) =>
				jsonToolResult(await tools.getCodeExecution!({ execution_id })),
		);
	}

	if (tools.listCodeExecutions) {
		server.registerTool(
			"list_code_executions",
			{
				title: "list_code_executions",
				description: "List this tedi's durable Code Mode execution history.",
				inputSchema: { limit: z.number().int().positive().max(100).optional() },
				annotations: { readOnlyHint: true },
			},
			async ({ limit }) =>
				jsonToolResult(await tools.listCodeExecutions!({ limit })),
		);
	}

	if (tools.approveCodeExecution) {
		server.registerTool(
			"approve_code_execution",
			{
				title: "approve_code_execution",
				description:
					"Approve the next pending connector action and resume the durable program by deterministic replay.",
				inputSchema: { execution_id: z.string().min(1) },
				annotations: { readOnlyHint: false },
			},
			async ({ execution_id }) =>
				jsonToolResult(await tools.approveCodeExecution!({ execution_id })),
		);
	}

	if (tools.rejectCodeExecution) {
		server.registerTool(
			"reject_code_execution",
			{
				title: "reject_code_execution",
				description:
					"Reject one pending connector action and end the execution.",
				inputSchema: {
					execution_id: z.string().min(1),
					seq: z.number().int().min(0),
				},
				annotations: { readOnlyHint: false },
			},
			async ({ execution_id, seq }) =>
				jsonToolResult(await tools.rejectCodeExecution!({ execution_id, seq })),
		);
	}

	if (tools.rollbackCodeExecution) {
		server.registerTool(
			"rollback_code_execution",
			{
				title: "rollback_code_execution",
				description:
					"Run available connector compensations in reverse order. Calls without a registered compensation cannot be undone.",
				inputSchema: { execution_id: z.string().min(1) },
				annotations: { readOnlyHint: false },
			},
			async ({ execution_id }) =>
				jsonToolResult(await tools.rollbackCodeExecution!({ execution_id })),
		);
	}

	if (tools.recoverCodeExecution) {
		server.registerTool(
			"recover_code_execution",
			{
				title: "recover_code_execution",
				description:
					"Record a stale interrupted execution as completion unconfirmed. Preserves effects and history; never repeats actions.",
				inputSchema: { execution_id: z.string().min(1).max(256) },
				annotations: { readOnlyHint: false },
			},
			async (args) => jsonToolResult(await tools.recoverCodeExecution!(args)),
		);
	}

	if (tools.brainAudit) {
		const brainAudit = tools.brainAudit;
		server.registerTool(
			"audit_memory_graph",
			{
				title: "audit_memory_graph",
				description:
					"Read-only audit of this tedi's durable memory facts. Use this for exact brain quality/provenance checks: pending facts without topic keys, producer/source-session counts, review status, priorities, and recent fact samples. It does not create, update, promote, or delete memory.",
				inputSchema: {
					scope: z
						.enum(["self", "org", "visible", "all"])
						.optional()
						.describe(
							"self=this tedi's facts; org=org/shared facts; visible=self+org/shared; all=all org facts. Defaults to self.",
						),
					topic_key_state: z
						.enum(["any", "missing", "present"])
						.optional()
						.describe("Filter by topic_key presence. Defaults to any."),
					review_status: z
						.string()
						.optional()
						.describe("Exact review_status filter, or omit for all."),
					priority: z
						.string()
						.optional()
						.describe("Exact priority filter, or omit for all."),
					use_policy: z
						.string()
						.optional()
						.describe("Exact use_policy filter, or omit for all."),
					fact_type: z
						.string()
						.optional()
						.describe("Exact fact_type filter, or omit for all."),
					status: z
						.string()
						.optional()
						.describe("Exact lifecycle status filter, or omit for all."),
					source_session_id: z
						.string()
						.optional()
						.describe("Exact source_session_id filter."),
					source_prefix: z
						.string()
						.optional()
						.describe("Source URI prefix filter."),
					producer: z
						.string()
						.optional()
						.describe("Exact metadata.producer filter."),
					search: z
						.string()
						.optional()
						.describe("Simple substring search over content and summary."),
					include_archived: z
						.boolean()
						.optional()
						.describe("Include archived facts. Defaults to false."),
					limit: z.number().int().positive().max(100).optional(),
					offset: z.number().int().min(0).optional(),
					order_by: z.enum(["created_desc", "updated_desc"]).optional(),
				},
				annotations: { readOnlyHint: true },
			},
			async (input) => jsonToolResult(await brainAudit(input)),
		);
	}

	server.registerTool(
		"conversations_list",
		{
			title: "conversations_list",
			description: "List tedi conversations.",
			inputSchema: { limit: z.number().int().positive().max(100).optional() },
			// Declared output contract — the tool already returns this
			// via structuredContent; the schema lets clients validate it.
			outputSchema: {
				conversations: z.array(z.record(z.string(), z.unknown())),
			},
			annotations: { readOnlyHint: true },
		},
		async (input) => jsonToolResult(await tools.conversationsList(input)),
	);

	server.registerTool(
		"conversation_get",
		{
			title: "conversation_get",
			description: "Get one tedi conversation by session key.",
			inputSchema: { session_key: z.string().min(1) },
			annotations: { readOnlyHint: true },
		},
		async (input) => jsonToolResult(await tools.conversationGet(input)),
	);

	server.registerTool(
		"messages_read",
		{
			title: "messages_read",
			description: "Read recent tedi messages.",
			inputSchema: {
				session_key: z.string().min(1),
				limit: z.number().int().positive().max(100).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async (input) => jsonToolResult(await tools.messagesRead(input)),
	);

	server.registerTool(
		"run_tedi_turn",
		{
			title: "run_tedi_turn",
			description:
				"Start a durable tedi turn. Returns a task or a pending receipt with run_id; read messages_read for the reply. Reuse client_request_id when retrying the same turn.",
			inputSchema: {
				session_key: z.string().min(1),
				// `text` may be empty when `attachments` carry the content (a Tedix OS
				// voice-only note has no typed text — the audio transcript becomes
				// the turn). The DO still rejects a turn that resolves to NO content.
				text: z.string().default(""),
				// Stable client-generated id used as the turn's runId turnKey. A
				// redelivery with the same id dedups to the same runId. Required —
				// the sender must mint a stable id (no server wall-clock fallback).
				client_request_id: z.string().min(1),
				attachments: z
					.array(
						z.object({
							content: z.string().min(1),
							fileName: z.string(),
							mimeType: z.string(),
							type: z.enum(["audio", "file", "image"]),
						}),
					)
					.max(8)
					.optional(),
			},
			annotations: { readOnlyHint: false },
		},
		async (input, ctx) => {
			const result = await tools.messagesSend({ ...input, trace_id: traceId });
			// Durable turn → emit the protocol-native 2026-07-28 task envelope
			// directly (pollable via the mounted taskHandlers) for callers that
			// declared the tasks extension; otherwise the plain result.
			const task = nativeDirectTediTaskResult(result, ctx?.mcpReq?._meta);
			if (task) return task as unknown as ReturnType<typeof jsonToolResult>;
			return jsonToolResult(result);
		},
	);

	if (tools.sendTediMessage) {
		const sendTediMessage = tools.sendTediMessage;
		server.registerTool(
			"send_tedi_message",
			{
				title: "send_tedi_message",
				description:
					"Send a message to another tedi in YOUR organization and wait for its reply. Address the peer by its slug or id via `target`. The peer runs your message through its own loop (its session, ledger, brain, and tools) and returns a reply. Use a STABLE `client_request_id` for idempotent delivery. Do not loop: avoid auto-replying to a peer message with another mesh send.",
				inputSchema: {
					target: z
						.string()
						.min(1)
						.describe("Peer tedi slug or id (must be in your organization)."),
					text: z.string().min(1).describe("Message to deliver to the peer."),
					session_key: z
						.string()
						.min(1)
						.optional()
						.describe("Peer session key; defaults to the peer's main session."),
					client_request_id: z
						.string()
						.min(1)
						.describe(
							"Stable id for idempotent delivery (no server fallback).",
						),
				},
				annotations: { readOnlyHint: false },
			},
			async (input) => jsonToolResult(await sendTediMessage(input)),
		);
	}

	if (tools.repoCommit) {
		const repoCommit = tools.repoCommit;
		server.registerTool(
			"repo_commit",
			{
				title: "repo_commit",
				description:
					"Propose committing durable repo/ workspace edits through the approval-gated GitHub API path. Returns an approval/execution id; it does not directly push from the MCP call.",
				inputSchema: {
					baseRef: z.string().optional(),
					branch: z.string().min(1),
					deletePaths: z.array(z.string().min(1)).optional(),
					message: z.string().min(1),
					openPr: z.boolean().optional(),
					paths: z
						.array(z.string().min(1))
						.min(1)
						.describe(
							"Workspace repo/ paths or repo-relative paths to include.",
						),
					prBase: z.string().optional(),
				},
				annotations: { readOnlyHint: false },
			},
			async (input) => jsonToolResult(await repoCommit(input)),
		);
	}

	if (tools.repoCommitDrain) {
		const repoCommitDrain = tools.repoCommitDrain;
		server.registerTool(
			"repo_commit_drain",
			{
				title: "repo_commit_drain",
				description:
					"Drain approved/rejected repo_commit approvals and report the DO-local execution ledger status. Use after approving a repo_commit to get commit SHA, PR URL, or execution error.",
				inputSchema: {
					approvalRequestId: z.string().optional(),
					executionLedgerId: z.string().optional(),
				},
				annotations: { readOnlyHint: false },
			},
			async (input) => jsonToolResult(await repoCommitDrain(input)),
		);
	}

	if (tools.repoCommitStatus) {
		const repoCommitStatus = tools.repoCommitStatus;
		server.registerTool(
			"repo_commit_status",
			{
				title: "repo_commit_status",
				description:
					"Read sanitized DO-local repo_commit execution status without draining or executing it. Use after approval to prove whether the approval-triggered drain already committed, failed, or stayed pending.",
				inputSchema: {
					approvalRequestId: z.string().optional(),
					executionLedgerId: z.string().optional(),
				},
				annotations: { readOnlyHint: true },
			},
			async (input) => jsonToolResult(await repoCommitStatus(input)),
		);
	}

	if (tools.listArtifactFiles) {
		const listArtifactFiles = tools.listArtifactFiles;
		server.registerTool(
			"artifact_list_files",
			{
				title: "artifact_list_files",
				description:
					"List files in this tedi's canonical Cloudflare Artifacts repo. Use to inspect durable operating files, skills, memory files, daily logs, and skill-workflow small state. Not the scratch workspace and not a shell.",
				inputSchema: {
					prefix: z
						.string()
						.optional()
						.describe(
							"Optional repo path prefix, e.g. memory/ or workspace/daily/.",
						),
					limit: z.number().int().positive().max(500).optional(),
				},
				annotations: { readOnlyHint: true },
			},
			async (input) => jsonToolResult(await listArtifactFiles(input)),
		);
	}

	if (tools.readArtifactFile) {
		const readArtifactFile = tools.readArtifactFile;
		server.registerTool(
			"artifact_read_file",
			{
				title: "artifact_read_file",
				description:
					"Read one UTF-8 text file from this tedi's canonical Cloudflare Artifacts repo, for example SOUL.md, AGENTS.md, or a skill-workflow's durable state file. A path that names a ledger-recorded run artifact (workstation_process/<id>/stdout.log, deliverable/<file>) or an artifact id reads that artifact's stored body instead.",
				inputSchema: {
					path: z.string().min(1),
					maxChars: z.number().int().positive().optional(),
				},
				annotations: { readOnlyHint: true },
			},
			async (input) => jsonToolResult(await readArtifactFile(input)),
		);
	}

	if (tools.writeArtifactFile) {
		const writeArtifactFile = tools.writeArtifactFile;
		server.registerTool(
			"artifact_write_file",
			{
				title: "artifact_write_file",
				description:
					"Write one UTF-8 text file to this tedi's canonical Cloudflare Artifacts repo (git-committed and pushed). Use for durable small state that should survive between skill-workflow runs — e.g. ingestion data, config, or cursors — not a scratch workspace and not a shell.",
				inputSchema: {
					path: z.string().min(1),
					content: z.string(),
					message: z
						.string()
						.max(200)
						.optional()
						.describe("Optional commit message subject."),
				},
				annotations: { readOnlyHint: false },
			},
			async (input) => jsonToolResult(await writeArtifactFile(input)),
		);
	}

	for (const [name, definition] of Object.entries(tools.computerTools ?? {})) {
		if (
			![
				"repo_load",
				"clone_repo",
				"run_git",
				"open_computer",
				"close_computer",
				"read_execution",
				"cancel_execution",
				"read",
				"write",
				"edit",
				"delete",
				"ls",
				"find",
				"grep",
				"code_search",
				"exec",
			].includes(name) ||
			definition.type === "provider" ||
			!definition.execute
		)
			continue;
		const execute = definition.execute;
		server.registerTool(
			name,
			{
				description:
					typeof definition.description === "string"
						? definition.description
						: undefined,
				inputSchema: (definition.inputSchema as z.ZodObject).shape,
				annotations: {
					readOnlyHint: [
						"read",
						"ls",
						"find",
						"grep",
						"code_search",
						"read_execution",
					].includes(name),
				},
			},
			async (input) =>
				jsonToolResult(
					await execute(
						(definition.inputSchema as z.ZodObject).parse(input) as never,
						{
							toolCallId: crypto.randomUUID(),
							messages: [],
							context: undefined,
						},
					),
				),
		);
	}

	if (tools.readResource) {
		const readResource = tools.readResource;
		server.registerTool(
			"mcp_read_resource",
			{
				title: "mcp_read_resource",
				description:
					"Read any assigned MCP resource by server ID and URI. Use this to load skill:// resources for full instructions, follow cross-references inside a skill, or read templates (substitute {placeholders} first).",
				inputSchema: {
					server: z.string().min(1),
					uri: z.string().min(1),
				},
				annotations: { readOnlyHint: true },
			},
			async (input) => jsonToolResult(await readResource(input)),
		);
	}

	if (tools.readDirectory) {
		const readDirectory = tools.readDirectory;
		server.registerTool(
			"mcp_directory_read",
			{
				title: "mcp_directory_read",
				description:
					"Read direct children of an assigned MCP directory resource by server ID and URI. Use this for skill:// directories when a server advertises directoryRead.",
				inputSchema: {
					server: z.string().min(1),
					uri: z.string().min(1),
					cursor: z.string().optional(),
				},
				annotations: { readOnlyHint: true },
			},
			async (input) => jsonToolResult(await readDirectory(input)),
		);
	}

	const cron = tools.cron;
	if (cron) {
		server.registerTool(
			"cron",
			{
				title: "cron",
				description: CRON_TOOL_DESCRIPTION,
				inputSchema: {
					action: z
						.enum(["list", "add", "remove", "status", "run"])
						.describe("Cron action to perform"),
					job: z
						.object({
							name: z.string().optional(),
							schedule: z
								.object({
									kind: z.enum(["at", "every", "cron"]).optional(),
									at: z.string().optional(),
									everyMs: z.number().optional(),
									expr: z.string().optional(),
									tz: z.string().optional(),
								})
								.passthrough()
								.optional(),
							payload: z
								.object({
									kind: z.enum(["agentTurn", "systemEvent"]).optional(),
									message: z.string().optional(),
									text: z.string().optional(),
								})
								.passthrough()
								.optional(),
							sessionTarget: z.string().optional(),
							message: z.string().optional(),
						})
						.passthrough()
						.optional()
						.describe("(add) Job definition — see schema in description"),
					jobId: z.string().optional().describe("(remove/run) Cron job id"),
					id: z.string().optional().describe("Alias for jobId"),
				},
			},
			async (input) => jsonToolResult(await cron(input as CronToolInput)),
		);
	}
}

const CRON_TOOL_DESCRIPTION = `Manage this tedi's cron jobs (list/add/remove/status/run).

Use for reminders, "check back later" follow-ups, and recurring tasks. A fired job runs its message as a real tedi turn (full session + ledger + brain), so the tedi can act on it autonomously.

ACTIONS:
- list / status: list this tedi's cron jobs
- add: create a job (requires \`job\` with \`schedule\` + a message)
- remove: delete a job (requires \`id\`)
- run: fire a job now (requires \`id\`)

JOB SCHEMA (for add):
{
  "name": "string (optional)",
  "schedule": {
    "kind": "at" | "every" | "cron",
    "at": "<ISO-8601>",           // kind=at  (one-shot)
    "everyMs": <ms>,             // kind=every (recurring interval)
    "expr": "<cron-expression>"  // kind=cron (e.g. "0 9 * * 1-5")
  },
  "message": "<the prompt the tedi runs when the job fires>",
  "sessionTarget": "main" | "session:<key>"   // optional, defaults to main
}

NOTES:
- Agent-runtime cron runs an \`agentTurn\` message. Use a workstation lease for shell commands.
- All three schedule kinds (at/every/cron) are supported.`;

function jsonToolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		structuredContent: value,
	};
}
