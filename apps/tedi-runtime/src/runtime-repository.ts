import {
	callRpc,
	RpcCallError,
	serviceBindingFetch,
} from "@tedix/api-client/internal";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import {
	nativeWorkProvenance,
	stampWorkProvenance,
} from "@tedix/context-core/work-provenance";
import {
	getTediRuntimeApproval,
	getTediRuntimeEncryptedSecret,
	getTediRuntimeRepoConfig,
	updateTediRuntimeApprovalResolution,
} from "@tedix/db/queries/tedi-runtime-bootstrap";
import { decryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { tool, type ToolSet } from "ai";
import * as z from "zod";
import { recordDeliverableArtifact } from "./artifact-recorder";
import { TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION } from "./artifacts-contract";
import { boundGitCliOutput, validateGitCliArgs } from "./computer-git-policy";
import { ScopedComputerWorkspace } from "./computer-workspace-scope";
import { publishComputerWorkspaceSnapshot } from "./computer-workspace-snapshot";
import { readRecordedArtifact } from "./deliverable-artifact-reader";
import type { AgentTediDO } from "./do";
import { buildRunId } from "./ledger-mirror";
import { normalizePortablePath } from "./portable-path";
import {
	commitRepoChanges as repoApiCommitChanges,
	openPullRequest as repoApiOpenPullRequest,
} from "./repo-api";
import {
	buildRepoCommitPayload,
	classifyRepoCommitRisk,
	executeRepoCommitFromLedger,
	REPO_COMMIT_WRITE_KIND,
	type RepoCommitExecuteResult,
} from "./repo-commit";
import { drainRepoCommits } from "./repo-commit-drain";
import {
	buildRepoCommitDrainedEvent,
	type RepoCommitDrainedEvent,
} from "./repo-commit-drain-event";
import {
	authorizeRepoCommitPublish,
	buildRepoCommitDeclaration,
	parseRepoCommitFenceDenial,
	repoCommitFenceDenialError,
	RepoCommitFenceStore,
} from "./repo-commit-fence";
import { type RepoCommitRow, RepoCommitStore } from "./repo-commit-store";
import {
	confineGitCwd,
	parseRepoUrl,
	replaceRepoFallbackSnapshot,
	runRepoClone,
	runRepoLoad,
} from "./repo-load";
import { identityValue } from "./runtime-facet-turns";
import { logTediRuntimeFailure } from "./runtime-failure-log";
import { type WorkstationTurnContext } from "./workstation-turn-context";
function clampPositiveInt(
	value: unknown,
	defaultValue: number,
	maxValue: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
	return Math.max(1, Math.min(maxValue, Math.floor(value)));
}

const ARTIFACT_READ_MAX_CHARS = 80_000;

function repoCommitStatusSnapshot(
	row: RepoCommitRow | null,
): Record<string, unknown> | null {
	if (!row) return null;
	return {
		id: row.id,
		approvalRequestId: row.approvalRequestId,
		owner: row.owner,
		repo: row.repo,
		baseRef: row.baseRef,
		branch: row.branch,
		message: row.message,
		openPr: row.openPr === 1,
		prBase: row.prBase,
		riskTier: row.riskTier,
		status: row.status,
		commitSha: row.commitSha,
		prUrl: row.prUrl,
		error: row.error,
		createdAt: new Date(row.createdAt).toISOString(),
		updatedAt: new Date(row.updatedAt).toISOString(),
	};
}
export interface RuntimeRepositoryHost {
	ensureIdentity: AgentTediDO["ensureIdentity"];
	state: AgentTediDO["state"];
	env: AgentTediDO["env"];
	activeTurnBinding: AgentTediDO["activeTurnBinding"];
	getPlatformClient: AgentTediDO["getPlatformClient"];
	assertChatTurnActive: AgentTediDO["assertChatTurnActive"];
	dailyLogWriteLock: AgentTediDO["dailyLogWriteLock"];
	listArtifactFilesTool: AgentTediDO["listArtifactFilesTool"];
	readArtifactFileTool: AgentTediDO["readArtifactFileTool"];
	writeArtifactFileTool: AgentTediDO["writeArtifactFileTool"];
	workspaceSnapshotTool: AgentTediDO["workspaceSnapshotTool"];
	repoLoadTool: AgentTediDO["repoLoadTool"];
	runRepoCommitGate: AgentTediDO["runRepoCommitGate"];
	ctx: AgentTediDO["ctx"];
	getSqlRunner: AgentTediDO["getSqlRunner"];
	drainPendingRepoCommits: AgentTediDO["drainPendingRepoCommits"];
	recordRepoCommitDrainedEvent: AgentTediDO["recordRepoCommitDrainedEvent"];
	resolveIdentityFromD1: AgentTediDO["resolveIdentityFromD1"];
}

export const runtimeRepository = {
	async listArtifactFilesTool(
		this: RuntimeRepositoryHost,
		input: {
			prefix?: string;
			limit?: number;
		},
	): Promise<unknown> {
		await this.ensureIdentity();
		const tediId = identityValue(this.state.tediId);
		if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
		if (!this.env.ARTIFACTS || !this.env.CF_ACCOUNT_ID) {
			return { ok: false, error: "ARTIFACTS binding is not configured" };
		}
		const prefix =
			typeof input.prefix === "string" && input.prefix.trim()
				? (normalizePortablePath(input.prefix) ?? "")
				: "";
		const limit = clampPositiveInt(input.limit, 100, 500);
		const { listFilesFromExistingRepoWithStatus } =
			await import("./artifacts-git");
		const result = await listFilesFromExistingRepoWithStatus(
			this.env.ARTIFACTS,
			this.env.CF_ACCOUNT_ID,
			TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
			tediId,
		);
		const files = result.files
			.filter((path) => !prefix || path.startsWith(prefix))
			.slice(0, limit);
		return {
			ok: result.repoFound && result.cloneOk && !result.error,
			repoFound: result.repoFound,
			cloneOk: result.cloneOk,
			error: result.error ?? null,
			namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
			repoName: tediId,
			prefix,
			files,
			truncated: result.files.length > files.length,
		};
	},
	async readArtifactFileTool(
		this: RuntimeRepositoryHost,
		input: {
			path?: string;
			maxChars?: number;
		},
	): Promise<unknown> {
		await this.ensureIdentity();
		const tediId = identityValue(this.state.tediId);
		if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
		const maxChars = clampPositiveInt(
			input.maxChars,
			ARTIFACT_READ_MAX_CHARS,
			ARTIFACT_READ_MAX_CHARS,
		);
		// A run artifact the ledger recorded (`workstation_process/<id>/stdout.log`,
		// `deliverable/report.md`, or its artifact id) lives in R2, not in the git
		// repo; resolve it through the artifact index first and fall back to the
		// repo only when nothing was recorded under that name.
		if (typeof input.path === "string" && this.env.TEDI_STORAGE) {
			const recorded = await readRecordedArtifact(
				{
					bucket: this.env.TEDI_STORAGE,
					ensureIdentity: () => this.ensureIdentity(),
					getTediId: () => identityValue(this.state.tediId),
					getPlatformClient: async () =>
						this.activeTurnBinding?.platform ??
						(await this.getPlatformClient()),
				},
				{ ref: input.path, maxChars },
			);
			if (recorded) return recorded;
		}
		if (!this.env.ARTIFACTS || !this.env.CF_ACCOUNT_ID) {
			return { ok: false, error: "ARTIFACTS binding is not configured" };
		}
		const path = normalizePortablePath(input.path);
		if (!path) return { ok: false, error: "path must be a safe repo path" };
		const { readFileFromExistingRepo } = await import("./artifacts-git");
		const content = await readFileFromExistingRepo(
			this.env.ARTIFACTS,
			this.env.CF_ACCOUNT_ID,
			TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
			tediId,
			path,
		);
		if (content == null) {
			return {
				ok: false,
				error: "not_found",
				namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
				repoName: tediId,
				path,
			};
		}
		return {
			ok: true,
			namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
			repoName: tediId,
			path,
			content: content.slice(0, maxChars),
			chars: content.length,
			truncated: content.length > maxChars,
		};
	},
	/**
	 * Write one UTF-8 text file to the canonical Cloudflare Artifacts repo —
	 * the durable, tenant-owned small-state store for skill workflows and
	 * other automation. Not
	 * a scratch workspace or a shell; git-diffable, git-history-tracked.
	 *
	 * Serialized on {@link dailyLogWriteLock} — the same lock the daily-log
	 * flush uses — so this can never race a concurrent push to the same repo
	 * into a non-fast-forward failure. Reuses {@link commitDailyLogs} directly
	 * (already generic: "write these bytes at these paths, commit, push" —
	 * see its own doc comment in artifacts-git.ts), not a new git primitive.
	 */
	async writeArtifactFileTool(
		this: RuntimeRepositoryHost,
		input: {
			path?: string;
			content?: string;
			message?: string;
		},
		runId: string | null | undefined,
	): Promise<unknown> {
		await this.assertChatTurnActive(runId);
		await this.ensureIdentity();
		const tediId = identityValue(this.state.tediId);
		const slug = identityValue(this.state.slug);
		if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
		if (!this.env.ARTIFACTS || !this.env.CF_ACCOUNT_ID) {
			return { ok: false, error: "ARTIFACTS binding is not configured" };
		}
		const path = normalizePortablePath(input.path);
		if (!path) return { ok: false, error: "path must be a safe repo path" };
		if (typeof input.content !== "string") {
			return { ok: false, error: "content must be a string" };
		}
		const message =
			typeof input.message === "string" && input.message.trim()
				? input.message.trim().slice(0, 200)
				: `artifact_write_file: ${path}`;

		const run = async () => {
			const { commitDailyLogs } = await import("./artifacts-git");
			return commitDailyLogs({
				assertReady: () => this.assertChatTurnActive(runId),
				artifacts: this.env.ARTIFACTS,
				accountId: this.env.CF_ACCOUNT_ID,
				namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
				tediId,
				slug: slug || tediId,
				files: [{ path, content: input.content as string }],
				message,
			});
		};
		const next = this.dailyLogWriteLock.then(run, run);
		this.dailyLogWriteLock = next.then(
			() => undefined,
			() => undefined,
		);
		try {
			const { commitOid } = await next;
			return {
				ok: true,
				namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
				repoName: tediId,
				path,
				commitOid,
				bytes: new TextEncoder().encode(input.content).byteLength,
			};
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
				repoName: tediId,
				path,
			};
		}
	},
	/**
	 * Publish the captured workspace into its own prefix in canonical Artifacts.
	 * Deletions are honored: a path removed from the workspace disappears
	 * from the snapshot subtree on the next commit (prefix-replacing
	 * semantics — daily logs/MEMORY.md outside the prefix are untouched).
	 * `repo/` (cloned third-party repos) and `.r2/` (read-only identity
	 * mount) are structurally excluded. Serialized on the same write mutex
	 * as daily-log flushes — one repo, one writer.
	 */
	async workspaceSnapshotTool(
		this: RuntimeRepositoryHost,
		input: {
			message?: string;
		},
		computer: ScopedComputerWorkspace,
		runId: string | null | undefined,
	): Promise<unknown> {
		await this.assertChatTurnActive(runId);
		await this.ensureIdentity();
		const tediId = identityValue(this.state.tediId);
		const slug = identityValue(this.state.slug);
		if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
		if (!this.env.ARTIFACTS || !this.env.CF_ACCOUNT_ID) {
			return { ok: false, error: "ARTIFACTS binding is not configured" };
		}
		return publishComputerWorkspaceSnapshot({
			computer,
			message: input.message,
			commit: (snapshot) => {
				const run = async () => {
					const { commitPrefixSnapshot } = await import("./artifacts-git");
					return commitPrefixSnapshot({
						assertReady: () => this.assertChatTurnActive(runId),
						...snapshot,
						artifacts: this.env.ARTIFACTS,
						accountId: this.env.CF_ACCOUNT_ID,
						namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
						tediId,
						slug: slug || tediId,
					});
				};
				const next = this.dailyLogWriteLock.then(run, run);
				this.dailyLogWriteLock = next.then(
					() => undefined,
					() => undefined,
				);
				return next;
			},
		});
	},
	artifactRepoAiTools(
		this: RuntimeRepositoryHost,
		computer: ScopedComputerWorkspace,
		runId: string | null | undefined,
	): ToolSet {
		return {
			artifact_list_files: tool({
				description:
					"List files in your canonical Cloudflare Artifacts repo. Use this to inspect durable operating files, skills, memory files, and daily logs. This is not the scratch workspace and not a shell.",
				inputSchema: z.object({
					prefix: z
						.string()
						.optional()
						.describe(
							"Optional repo path prefix, e.g. memory/ or workspace/daily/.",
						),
					limit: z.number().int().positive().max(500).optional(),
				}),
				execute: async (input) => this.listArtifactFilesTool(input),
			}),
			artifact_read_file: tool({
				description:
					"Read one UTF-8 text file from your canonical Cloudflare Artifacts repo, for example SOUL.md, AGENTS.md, TOOLS.md, or memory/MEMORY.md. Also resolves a run artifact recorded in the ledger by its name (workstation_process/<id>/stdout.log, deliverable/<file>) or artifact id, reading its stored body.",
				inputSchema: z.object({
					path: z.string().min(1),
					maxChars: z
						.number()
						.int()
						.positive()
						.max(ARTIFACT_READ_MAX_CHARS)
						.optional(),
				}),
				execute: async (input) => this.readArtifactFileTool(input),
			}),
			artifact_write_file: tool({
				description:
					"Write one UTF-8 text file to your canonical Cloudflare Artifacts repo. Use this for durable small state that should survive between turns/runs and be git-diffable — e.g. skill-workflow ingestion data, config, or cursors. Not a scratch workspace and not a shell.",
				inputSchema: z.object({
					path: z.string().min(1),
					content: z.string(),
					message: z
						.string()
						.max(200)
						.optional()
						.describe("Optional commit message subject."),
				}),
				execute: async (input) => this.writeArtifactFileTool(input, runId),
			}),
			workspace_snapshot: tool({
				description:
					"Commit a versioned snapshot of your scratch workspace to your canonical Cloudflare Artifacts repo under the workspace/ prefix (git history = restore points). " +
					"Deletions are honored; repo/ clones and the .r2/ mount are excluded. " +
					"Use the exact prefix returned by this snapshot with artifact_list_files; restore individual files with artifact_read_file and workspace write.",
				inputSchema: z.object({
					message: z
						.string()
						.max(200)
						.optional()
						.describe("Optional commit message subject."),
				}),
				execute: async (input) =>
					this.workspaceSnapshotTool(input, computer, runId),
			}),
		};
	},
	async recordArtifactTool(
		this: RuntimeRepositoryHost,
		input: {
			name?: string;
			content?: string;
			mimeType?: string;
			kind?: string;
			description?: string;
		},
		turnCtx?: { runId?: string; conversationId?: string },
	): Promise<unknown> {
		await this.ensureIdentity();
		const tediId = identityValue(this.state.tediId);
		if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
		if (typeof input.name !== "string" || !input.name.trim()) {
			return { ok: false, error: "name is required" };
		}
		if (typeof input.content !== "string" || !input.content) {
			return { ok: false, error: "content is required" };
		}
		const active = this.activeTurnBinding;
		const platform = active?.platform ?? (await this.getPlatformClient());
		if (!platform) return { ok: false, error: "platform client unavailable" };
		return recordDeliverableArtifact({
			platform,
			bucket: this.env.TEDI_STORAGE,
			tediId,
			conversationId: turnCtx?.conversationId ?? active?.conversationId,
			runId: turnCtx?.runId ?? active?.runId,
			name: input.name,
			content: input.content,
			mimeType: typeof input.mimeType === "string" ? input.mimeType : undefined,
			kind: typeof input.kind === "string" ? input.kind : undefined,
			description:
				typeof input.description === "string" ? input.description : undefined,
		});
	},
	/** Clone into the captured workspace using governed repository configuration. */
	async repoCloneTool(
		this: RuntimeRepositoryHost,
		input: {
			ref?: unknown;
			paths?: unknown;
			depth?: unknown;
		},
		computer: ScopedComputerWorkspace,
	): Promise<unknown> {
		try {
			await this.ensureIdentity();
			const tediId = identityValue(this.state.tediId);
			if (!tediId) return { ok: false, error: "identity_not_resolved" };
			return await runRepoClone(
				{
					db: this.env.DB,
					masterKey: (this.env as { SECRETS_MASTER_KEY?: string })
						.SECRETS_MASTER_KEY,
					clone: (options) => computer.git.clone(options),
					// Clean a failed/partial clone so a retry re-clones into a
					// fresh tree instead of colliding with a half-written copy (P2).
					removeCloneDir: async () => {
						await computer.workspace.rm("repo", {
							recursive: true,
							force: true,
						});
					},
					loadFilesFallback: async ({ ref, paths }) => {
						const result = await this.repoLoadTool({ ref, paths }, computer);
						return result && typeof result === "object"
							? (result as Record<string, unknown>)
							: { ok: false, error: "repo_load_fallback_failed" };
					},
					replaceFallbackSnapshot: (files) =>
						replaceRepoFallbackSnapshot(
							{
								readFile: (path) => computer.workspace.readFile(path),
								writeFile: (path, content) =>
									computer.workspace.writeFile(path, content),
								removeRepoDir: () =>
									computer.workspace.rm("repo", {
										recursive: true,
										force: true,
									}),
							},
							files,
						),
				},
				{
					tediId,
					ref: typeof input.ref === "string" ? input.ref : undefined,
					paths: Array.isArray(input.paths)
						? (input.paths as string[])
						: undefined,
					depth: typeof input.depth === "number" ? input.depth : undefined,
				},
			);
		} catch (err) {
			logTediRuntimeFailure("tedi.workstation.repo_clone_failed", err);
			return { ok: false, error: "clone_failed" };
		}
	},
	async gitCliTool(
		this: RuntimeRepositoryHost,
		input: {
			args?: unknown;
			cwd?: unknown;
		},
		computer: ScopedComputerWorkspace,
	): Promise<unknown> {
		try {
			const validated = validateGitCliArgs(input.args);
			if (!validated.ok) return validated;
			// P1: confine caller cwd under the repo root (reject escapes).
			const confinedCwd = confineGitCwd(input.cwd);
			if (!confinedCwd.ok) return confinedCwd;
			await this.ensureIdentity();
			const identity =
				identityValue(this.state.slug) ??
				identityValue(this.state.tediId) ??
				"tedi";
			const result = await computer.git.cli({
				argv: validated.argv,
				cwd: confinedCwd.cwd,
				env: {
					GIT_AUTHOR_NAME: identity,
					GIT_AUTHOR_EMAIL: `${identity}@tedix.tech`,
					GIT_COMMITTER_NAME: identity,
					GIT_COMMITTER_EMAIL: `${identity}@tedix.tech`,
				},
			});
			// P1: bound buffered stdout/stderr before returning.
			return boundGitCliOutput({ ok: result.exitCode === 0, ...result });
		} catch (err) {
			logTediRuntimeFailure("tedi.workstation.git_cli_failed", err);
			return { ok: false, error: "git_cli_failed" };
		}
	},
	async repoLoadTool(
		this: RuntimeRepositoryHost,
		input: {
			paths?: unknown;
			ref?: unknown;
			maxFiles?: unknown;
		},
		computer: ScopedComputerWorkspace,
	): Promise<unknown> {
		try {
			await this.ensureIdentity();
			const tediId = identityValue(this.state.tediId);
			if (!tediId) return { ok: false, error: "identity_not_resolved" };

			const paths = Array.isArray(input.paths) ? (input.paths as string[]) : [];
			return await runRepoLoad(
				{
					db: this.env.DB,
					masterKey: (this.env as { SECRETS_MASTER_KEY?: string })
						.SECRETS_MASTER_KEY,
					writeFile: (path: string, content: string) =>
						computer.workspace.writeFile(path, content),
				},
				{
					tediId,
					paths,
					ref: typeof input.ref === "string" ? input.ref : undefined,
					maxFiles:
						typeof input.maxFiles === "number" ? input.maxFiles : undefined,
				},
			);
		} catch (err) {
			logTediRuntimeFailure("tedi.workstation.repo_load_failed", err);
			return { ok: false, error: "repo_load_failed" };
		}
	},
	// ── Hybrid-coding Phase 2b-iii: repo_commit PROPOSE ──────────────────────

	/**
	 * Propose a repo_commit: read workspace files, build changeset, park in
	 * DO-SQLite, call proposeRepoCommit on the kernel API, store the returned
	 * approvalRequestId. Never commits or decrypts the PAT here. Fail-soft.
	 */
	async repoCommitProposeTool(
		this: RuntimeRepositoryHost,
		input: {
			branch: string;
			message: string;
			paths: string[];
			deletePaths?: string[];
			baseRef?: string;
			openPr?: boolean;
			prBase?: string;
		},
		computer: {
			turnContext: WorkstationTurnContext | null;
			workspace: Pick<ScopedComputerWorkspace["workspace"], "readFile">;
		},
	): Promise<unknown> {
		try {
			// Capture before the first await; approval and drain must keep these exact bytes.
			const message = stampWorkProvenance(
				input.message,
				nativeWorkProvenance(computer.turnContext),
			);
			await this.ensureIdentity();
			const tediId = identityValue(this.state.tediId);
			const orgId = identityValue(this.state.orgId);
			if (!tediId || !orgId)
				return { ok: false, error: "identity_not_resolved" };

			// Load repo_config
			let repoConfig: string | null = null;
			try {
				repoConfig = await getTediRuntimeRepoConfig(this.env.DB, tediId);
			} catch {
				return { ok: false, error: "repo_config_read_failed" };
			}

			if (!repoConfig) return { ok: false, error: "no_repo_config" };

			let cfg: { repoUrl: string; branch?: string } | null = null;
			try {
				const parsed: unknown = JSON.parse(repoConfig);
				if (parsed && typeof parsed === "object") {
					const c = parsed as Record<string, unknown>;
					if (typeof c.repoUrl === "string" && c.repoUrl.trim()) {
						cfg = {
							repoUrl: c.repoUrl,
							branch: typeof c.branch === "string" ? c.branch : undefined,
						};
					}
				}
			} catch {
				return { ok: false, error: "repo_config_read_failed" };
			}
			if (!cfg) return { ok: false, error: "no_repo_config" };

			const parsed = parseRepoUrl(cfg.repoUrl);
			if (!parsed) return { ok: false, error: "invalid_repo_url" };
			const { owner, repo } = parsed;

			const baseRef =
				typeof input.baseRef === "string" && input.baseRef.trim()
					? input.baseRef.trim()
					: (cfg.branch ?? "main");

			// Read workspace files to build changeset
			const changes: { path: string; content: string | null }[] = [];

			const REPO_PREFIX = "repo/";

			/** Validate a git path derived from a workspace path input.
			 * Must be non-empty, must not start with '/', and must contain no
			 * dot-segment ("." / "..") components — mirrors repo-load.ts.
			 */
			function validateGitPath(
				wsPath: string,
			): { gitPath: string } | { ok: false; error: string; path: string } {
				const gitPath = wsPath.startsWith(REPO_PREFIX)
					? wsPath.slice(REPO_PREFIX.length)
					: wsPath;
				if (
					gitPath === "" ||
					gitPath.startsWith("/") ||
					gitPath
						.split("/")
						.some((seg) => seg === "" || seg === "." || seg === "..")
				) {
					return { ok: false, error: "invalid_path", path: wsPath };
				}
				return { gitPath };
			}

			for (const wsPath of input.paths) {
				const validated = validateGitPath(wsPath);
				if ("ok" in validated) return validated;
				const { gitPath } = validated;
				let content: string | null = null;
				try {
					content = await computer.workspace.readFile(`repo/${gitPath}`);
				} catch {
					return { ok: false, error: "workspace_read_failed", path: wsPath };
				}
				changes.push({ path: gitPath, content });
			}

			for (const wsPath of input.deletePaths ?? []) {
				const validated = validateGitPath(wsPath);
				if ("ok" in validated) return validated;
				changes.push({ path: validated.gitPath, content: null });
			}

			if (changes.length === 0) return { ok: false, error: "no_changes" };

			// The gate a human push gets. Refuse the proposal on a failure, and
			// hand back the gate's own output as the reason.
			const gate = await this.runRepoCommitGate(changes.map((c) => c.path));
			if (!gate.ok)
				return {
					ok: false,
					error: "push_gate_failed",
					gateOutput: gate.output,
					instruction: gate.ran
						? "The repo gates refused these changes. Fix the cause and propose again; do not retry unchanged."
						: "The repo gate did not run. Restore the validation surface or use native Git with its pre-push hook; do not retry unchanged.",
				};

			const riskTier = classifyRepoCommitRisk({
				baseRef,
				branch: input.branch,
			});

			// A direct operator MCP call has no cognitive turn. Give it a distinct
			// explicit owner; never borrow another concurrent chat's binding.
			const ownerContext = computer.turnContext
				? { ...computer.turnContext }
				: null;
			if (ownerContext && (!ownerContext.conversationId || !ownerContext.runId))
				return { ok: false, error: "repo_commit_owner_missing" };
			const conversationId =
				ownerContext?.conversationId ??
				buildTediConversationId({
					tediRef: this.state.slug || tediId,
					sessionKey: "__operator:repo",
				});
			const executionLedgerId = crypto.randomUUID();
			await this.ctx.storage.put(`repo-commit-owner:${executionLedgerId}`, {
				conversationId,
				runId:
					ownerContext?.runId ?? `system:${tediId}:repo:${executionLedgerId}`,
			});

			// Declare exactly what this proposal asks to publish — an exact
			// content fingerprint over the ordered changeset plus the full push
			// target — BEFORE parking the changeset it constrains. The publish
			// fence refuses any push that does not match this declaration, so a
			// row that is parked without one can never be published.
			//
			// This is the ONLY place the fingerprint is computed. The same value
			// goes into the tedi's own DO store AND onto the operator approval in
			// D1, so the two can never drift apart into a "valid here, invalid
			// there" disagreement that would strand every publish.
			const fenceStore = new RepoCommitFenceStore(this.getSqlRunner());
			const declaration = await buildRepoCommitDeclaration({
				target: {
					owner,
					repo,
					baseRef,
					branch: input.branch,
					message,
					openPr: input.openPr ?? false,
					prBase: input.prBase ?? null,
				},
				changes,
			});
			fenceStore.declare(executionLedgerId, declaration);

			const payload = buildRepoCommitPayload({
				organizationId: orgId,
				tediId,
				conversationId,
				homeRunId: null,
				owner,
				repo,
				baseRef,
				branch: input.branch,
				message,
				openPr: input.openPr ?? false,
				prBase: input.prBase ?? null,
				changeSet: { changes },
				changeFingerprint: declaration.fingerprint,
				executionLedgerId,
			});

			// Park full changeset in DO-SQLite (never surfaces in proposal)
			const store = new RepoCommitStore(this.getSqlRunner());
			store.park({
				id: executionLedgerId,
				owner,
				repo,
				baseRef,
				branch: input.branch,
				message,
				changesJson: JSON.stringify({ changes }),
				openPr: input.openPr ?? false,
				prBase: input.prBase ?? null,
				riskTier,
			});

			// Propose to kernel
			if (!this.env.API_SERVICE) {
				store.markError(executionLedgerId, "API_SERVICE binding unavailable");
				return { ok: false, error: "api_service_unavailable" };
			}

			let proposeData: {
				approvalRequestId?: string;
				status?: string;
				autoResolved?: boolean;
			};
			try {
				proposeData = await callRpc(
					"kernelRuntime/proposeRepoCommit",
					{
						tediId,
						orgId,
						conversationId,
						owner,
						repo,
						baseRef,
						branch: input.branch,
						message,
						openPr: input.openPr ?? false,
						prBase: input.prBase ?? null,
						changeSummary: payload.changeSummary,
						changeFingerprint: payload.changeFingerprint,
						executionLedgerId,
						riskTier,
					},
					{
						apiUrl: "https://api",
						fetch: serviceBindingFetch(this.env.API_SERVICE),
						headers: {
							"X-Service-Binding": "true",
							"X-Tedix-Org-Id": orgId,
						},
					},
				);
			} catch (error) {
				if (error instanceof RpcCallError) {
					store.markError(
						executionLedgerId,
						`propose_api_error:${error.status}`,
					);
					return {
						ok: false,
						error: "propose_api_error",
						status: error.status,
						detail: error.detail.slice(0, 200),
					};
				}
				store.markError(executionLedgerId, "propose_fetch_failed");
				return { ok: false, error: "propose_fetch_failed" };
			}
			const approvalRequestId =
				typeof proposeData.approvalRequestId === "string"
					? proposeData.approvalRequestId
					: null;
			const approvalStatus =
				typeof proposeData.status === "string" ? proposeData.status : "pending";

			if (approvalRequestId) {
				store.updateApprovalId(executionLedgerId, approvalRequestId);
			}

			if (approvalStatus === "approved") {
				const beforeDrain = store.get(executionLedgerId);
				await this.drainPendingRepoCommits();
				const afterDrain = store.get(executionLedgerId);
				const evidenceEvent = afterDrain
					? await this.recordRepoCommitDrainedEvent(afterDrain)
					: { status: "skipped" as const };
				// A fence refusal is NOT a commit that happened to fail: it is the
				// gate declining to publish. Return it in a shape the model cannot
				// read as success — ok:false, no commitSha, an explicit denial
				// reason.
				const denial = parseRepoCommitFenceDenial(afterDrain?.error);
				if (denial) {
					return {
						ok: false,
						denied: true,
						published: false,
						status: "denied",
						error: "repo_commit_publish_denied",
						deniedBy: "repo_commit_publish_fence",
						deniedCode: denial.code,
						deniedReason: denial.reason,
						approvalRequestId,
						executionLedgerId,
						branch: input.branch,
						riskTier,
						declaredFingerprint: declaration.fingerprint,
						before: repoCommitStatusSnapshot(beforeDrain),
						after: repoCommitStatusSnapshot(afterDrain),
					};
				}
				return {
					ok: true,
					denied: false,
					published: afterDrain?.status === "committed",
					declaredFingerprint: declaration.fingerprint,
					status:
						afterDrain?.status === "committed"
							? "committed"
							: afterDrain?.status === "error"
								? "error"
								: "approved",
					approvalRequestId,
					executionLedgerId,
					branch: input.branch,
					riskTier,
					fileCount: changes.length,
					autoDrained: true,
					before: repoCommitStatusSnapshot(beforeDrain),
					after: repoCommitStatusSnapshot(afterDrain),
					...(afterDrain?.commitSha ? { commitSha: afterDrain.commitSha } : {}),
					...(afterDrain?.prUrl ? { prUrl: afterDrain.prUrl } : {}),
					evidenceEventStatus: evidenceEvent.status,
					...(evidenceEvent.eventId
						? { evidenceEventId: evidenceEvent.eventId }
						: {}),
					...(evidenceEvent.error
						? { evidenceEventError: evidenceEvent.error }
						: {}),
				};
			}

			return {
				ok: true,
				denied: false,
				published: false,
				status:
					approvalStatus === "approved" ? "approved" : "awaiting_approval",
				approvalRequestId,
				executionLedgerId,
				branch: input.branch,
				riskTier,
				fileCount: changes.length,
				declaredFingerprint: declaration.fingerprint,
			};
		} catch (err) {
			console.warn(
				"[repo_commit] unexpected error in propose:",
				err instanceof Error ? err.message : String(err),
			);
			return { ok: false, error: "repo_commit_propose_failed" };
		}
	},
	/**
	 * Drain pending repo_commit approvals at the start of each turn.
	 * Fail-soft — never throws out of beforeTurn.
	 */
	async drainPendingRepoCommits(this: RuntimeRepositoryHost): Promise<void> {
		// beforeTurn runs before message identity hints are applied; for a DO
		// addressed by its isolateAgentId, this.state.tediId can still be empty
		// here. Discover its unique canonical physical owner from D1.
		let tediId = identityValue(this.state.tediId);
		if (!tediId) {
			const resolved = await this.resolveIdentityFromD1();
			tediId = resolved?.tediId;
		}
		if (!tediId) return;

		const store = new RepoCommitStore(this.getSqlRunner());
		const masterKey = (this.env as { SECRETS_MASTER_KEY?: string })
			.SECRETS_MASTER_KEY;
		const db = this.env.DB;

		await drainRepoCommits({
			store,
			tediId,
			getStatus: async ({ approvalRequestId, tediId: tid }) => {
				// Read the approval status directly from D1. The DO already reads
				// main D1 (tedi_secrets); a direct read avoids a fragile
				// beforeTurn service-binding subrequest that does not reliably
				// resolve outside an active request context.
				try {
					const r = await getTediRuntimeApproval(db, approvalRequestId);
					if (!r || r.tediId !== tid) return { status: "pending" };
					let kind: unknown;
					try {
						kind = (JSON.parse(r.payload) as { kind?: unknown })?.kind;
					} catch {
						return { status: "pending" };
					}
					if (kind !== REPO_COMMIT_WRITE_KIND) return { status: "pending" };
					return { status: r.status, resolution: r.resolution };
				} catch {
					return { status: "pending" };
				}
			},
			executeRow: async (row) => {
				// ── Publish fence ────────────────────────────────────────────
				// The approved action and the bytes that move must be the same
				// thing. Re-read the operator approval from D1 HERE, at publish
				// time, and check it against the changeset this row is about to
				// push and the declaration recorded when it was proposed.
				// Fail-closed: undeclared, mismatched or unverifiable is refused
				// before any byte reaches GitHub, and the row goes terminal.
				const fenceStore = new RepoCommitFenceStore(this.getSqlRunner());
				let approvalPayloadJson: string | null = null;
				if (row.approvalRequestId) {
					try {
						const approvalRow = await getTediRuntimeApproval(
							db,
							row.approvalRequestId,
						);
						approvalPayloadJson =
							approvalRow && approvalRow.tediId === tediId
								? approvalRow.payload
								: null;
					} catch {
						approvalPayloadJson = null;
					}
				}
				const verdict = await authorizeRepoCommitPublish({
					ledgerId: row.id,
					approvalRequestId: row.approvalRequestId,
					approvalPayloadJson,
					declarationJson: fenceStore.getDeclarationJson(row.id),
					target: {
						owner: row.owner,
						repo: row.repo,
						baseRef: row.baseRef,
						branch: row.branch,
						message: row.message,
						openPr: row.openPr === 1,
						prBase: row.prBase,
					},
					changesJson: row.changesJson,
				});

				let __r: RepoCommitExecuteResult;
				if (!verdict.authorized) {
					console.warn(
						`[repo_commit_fence] publish REFUSED row=${row.id} code=${verdict.code}`,
					);
					__r = {
						ok: false,
						error: verdict.reason,
						code: repoCommitFenceDenialError(verdict.code),
					};
				} else {
					__r = await executeRepoCommitFromLedger({
						deps: {
							decryptPat: async () => {
								if (!masterKey) return null;
								try {
									const encryptedValue = await getTediRuntimeEncryptedSecret(
										db,
										tediId,
										"GITHUB_PAT",
									);
									if (!encryptedValue) return null;
									return decryptTediSecret(masterKey, tediId, encryptedValue);
								} catch {
									return null;
								}
							},
							commitRepoChanges: repoApiCommitChanges,
							openPullRequest: repoApiOpenPullRequest,
						},
						row,
					});
					if (__r.ok) {
						// Bind the declaration to the commit it actually produced.
						try {
							fenceStore.recordPublishedCommit(row.id, __r.commitSha);
						} catch (err) {
							console.warn(
								"[repo_commit_fence] recordPublishedCommit failed:",
								err instanceof Error ? err.message : String(err),
							);
						}
					}
				}
				if (row.approvalRequestId) {
					// ONE typed final-outcome write (adoption-review backlog #12): the
					// human-readable disposition for the approval row — this string is
					// surfaced verbatim in approval notifications (approval-workflow.ts
					// renders `resolution` as the "Note"), so no debug prefix soup.
					// Full drain detail rides the recordRepoCommitDrainedEvent
					// runtime-event channel, not this column.
					const note = __r.ok
						? `repo_commit committed: ${__r.commitSha ?? "(sha pending)"}`
						: `repo_commit failed (${__r.code ?? "unknown"}): ${__r.error ?? "unrecoverable error"}`;
					await updateTediRuntimeApprovalResolution(
						db,
						row.approvalRequestId,
						note.slice(0, 300),
					).catch(() => {});
				}
				return __r;
			},
		});
	},
	async recordRepoCommitDrainedEvent(
		this: RuntimeRepositoryHost,
		row: RepoCommitRow,
	): Promise<{
		error?: string;
		eventId?: string;
		status: "recorded" | "failed" | "skipped";
	}> {
		if (row.status !== "committed" || !row.commitSha)
			return { status: "skipped" };
		const tediId = identityValue(this.state.tediId);
		if (!tediId) return { status: "skipped" };
		const platform = await this.getPlatformClient();
		if (!platform) return { status: "skipped" };
		const owner = await this.ctx.storage.get<{
			conversationId: string;
			runId: string;
		}>(`repo-commit-owner:${row.id}`);
		if (!owner?.conversationId || !owner.runId)
			return { status: "failed", error: "repo_commit_owner_missing" };
		const conversationId = owner.conversationId;
		const runId = buildRunId(tediId, `repo_commit_${row.id}`, "repo");
		const event = buildRepoCommitDrainedEvent({
			conversationId,
			createdAt: new Date().toISOString(),
			drainedAt: new Date().toISOString(),
			row: row as RepoCommitRow & { commitSha: string },
			runId,
			tediId,
		});
		try {
			await platform.recordRuntimeEvent(event as RepoCommitDrainedEvent);
			return { eventId: event.id, status: "recorded" };
		} catch (error) {
			return {
				eventId: event.id,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
	async repoCommitDrainTool(
		this: RuntimeRepositoryHost,
		input: {
			approvalRequestId?: string;
			executionLedgerId?: string;
		},
	): Promise<unknown> {
		await this.ensureIdentity();
		const store = new RepoCommitStore(this.getSqlRunner());
		const before = input.executionLedgerId
			? store.get(input.executionLedgerId)
			: input.approvalRequestId
				? store.getByApprovalRequestId(input.approvalRequestId)
				: null;
		await this.drainPendingRepoCommits();
		const after = input.executionLedgerId
			? store.get(input.executionLedgerId)
			: input.approvalRequestId
				? store.getByApprovalRequestId(input.approvalRequestId)
				: before
					? store.get(before.id)
					: null;
		const evidenceEvent = after
			? await this.recordRepoCommitDrainedEvent(after)
			: { status: "skipped" as const };
		// A publish refused by the fence must never resolve like a publish that
		// happened: ok:false and an explicit denial.
		const denial = parseRepoCommitFenceDenial(after?.error);
		return {
			ok: denial ? false : after !== null || before !== null,
			denied: denial !== null,
			published: after?.status === "committed",
			drained: true,
			before: repoCommitStatusSnapshot(before),
			after: repoCommitStatusSnapshot(after),
			evidenceEventStatus: evidenceEvent.status,
			...(evidenceEvent.eventId
				? { evidenceEventId: evidenceEvent.eventId }
				: {}),
			...(evidenceEvent.error
				? { evidenceEventError: evidenceEvent.error }
				: {}),
			...(after === null && before === null
				? { error: "repo_commit_execution_not_found" }
				: {}),
			...(denial
				? {
						error: "repo_commit_publish_denied",
						deniedBy: "repo_commit_publish_fence",
						deniedCode: denial.code,
						deniedReason: denial.reason,
					}
				: {}),
		};
	},
	async repoCommitStatusTool(
		this: RuntimeRepositoryHost,
		input: {
			approvalRequestId?: string;
			executionLedgerId?: string;
		},
	): Promise<unknown> {
		await this.ensureIdentity();
		const store = new RepoCommitStore(this.getSqlRunner());
		const row = input.executionLedgerId
			? store.get(input.executionLedgerId)
			: input.approvalRequestId
				? store.getByApprovalRequestId(input.approvalRequestId)
				: null;
		const status = row?.status ?? null;
		const denial = parseRepoCommitFenceDenial(row?.error);
		const fence = row
			? new RepoCommitFenceStore(this.getSqlRunner()).get(row.id)
			: null;
		return {
			ok: row !== null,
			status: denial ? "denied" : status,
			committed: status === "committed",
			denied: denial !== null,
			declared: fence !== null,
			...(fence?.publishedCommitSha
				? { publishedCommitSha: fence.publishedCommitSha }
				: {}),
			terminal:
				status === "committed" || status === "error" || status === "abandoned",
			row: repoCommitStatusSnapshot(row),
			...(row === null ? { error: "repo_commit_execution_not_found" } : {}),
			...(denial
				? {
						error: "repo_commit_publish_denied",
						deniedBy: "repo_commit_publish_fence",
						deniedCode: denial.code,
						deniedReason: denial.reason,
					}
				: {}),
		};
	},
};
