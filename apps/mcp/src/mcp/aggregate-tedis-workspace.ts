// Durable workspace, repo, and Artifacts-repo tool specs (Agent runtime).
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import {
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

const REPO_LOAD_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		paths: {
			type: "array",
			items: { type: "string", minLength: 1 },
			minItems: 1,
			description: "Repository-relative file paths to load.",
		},
		ref: {
			type: "string",
			description: "Optional branch, tag, or commit SHA to read.",
		},
		maxFiles: { type: "integer", minimum: 1, maximum: 200 },
	},
	required: ["paths"],
	additionalProperties: false,
};

const REPO_CLONE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		ref: {
			type: "string",
			description: "Branch, tag, or commit; defaults to the configured branch.",
		},
		paths: {
			type: "array",
			items: { type: "string", minLength: 1 },
			description: "Sparse working-tree paths (directories or files).",
		},
		depth: {
			type: "integer",
			minimum: 1,
			maximum: 50,
			description: "Shallow depth; defaults to 1.",
		},
	},
	additionalProperties: false,
};

const RUN_GIT_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		args: {
			type: "array",
			items: { type: "string" },
			minItems: 1,
			maxItems: 64,
			description: 'Git argv, e.g. ["status"] or ["diff", "--stat"].',
		},
		cwd: {
			type: "string",
			description: "Working directory; defaults to the repo/ workspace root.",
		},
	},
	required: ["args"],
	additionalProperties: false,
};

const REPO_COMMIT_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		baseRef: { type: "string" },
		branch: { type: "string", minLength: 1 },
		deletePaths: { type: "array", items: { type: "string", minLength: 1 } },
		message: { type: "string", minLength: 1 },
		openPr: { type: "boolean" },
		paths: {
			type: "array",
			items: { type: "string", minLength: 1 },
			minItems: 1,
			description: "Workspace repo/ paths or repo-relative paths to include.",
		},
		prBase: { type: "string" },
	},
	required: ["branch", "message", "paths"],
	additionalProperties: false,
};

const REPO_COMMIT_DRAIN_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		approvalRequestId: { type: "string" },
		executionLedgerId: { type: "string" },
	},
	additionalProperties: false,
};

const REPO_COMMIT_STATUS_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		approvalRequestId: { type: "string" },
		executionLedgerId: { type: "string" },
	},
	additionalProperties: false,
};

export const WORKSPACE_TOOLS: TediToolSpec[] = [
	{
		name: "repo_load",
		remoteName: "repo_load",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Add selected files from this tedi's configured GitHub repository to the durable repo/ workspace without leasing a workstation. This direct file fetch does not clear unrelated repo/ paths; use clone_repo when the repo/ view must be replaced by one coherent ref/path snapshot. Read-only; use repo_commit for approval-gated writes.",
		inputSchema: REPO_LOAD_SCHEMA,
		annotations: READ_ONLY,
	},
	{
		name: "clone_repo",
		remoteName: "clone_repo",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Replace the durable repo/ workspace with a coherent shallow clone of this tedi's configured GitHub repository, including a real .git (isomorphic-git over the DO filesystem) — no workstation lease. Pass exact paths when possible: oversized repositories replace repo/ with exactly the repo_load file set and return mode=repo_load_fallback, gitAvailable=false, snapshotIsolated=true. Use run_git only when gitAvailable=true; use open_computer for full checkout/Git CLI, installs, builds, or full validation.",
		inputSchema: REPO_CLONE_SCHEMA,
		annotations: MUTATING,
	},
	{
		name: "run_git",
		remoteName: "run_git",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Run a LOCAL git subcommand against the durable repo/ working tree after clone_repo. Network subcommands are rejected: use clone_repo for the bounded authenticated clone and repo_commit for approval-gated pushes.",
		inputSchema: RUN_GIT_SCHEMA,
		annotations: MUTATING,
	},
	{
		name: "repo_commit",
		remoteName: "repo_commit",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Propose committing durable repo/ workspace edits through the approval-gated GitHub API path. Returns an approval/execution id; it does not directly push from the MCP call.",
		inputSchema: REPO_COMMIT_SCHEMA,
		annotations: MUTATING,
	},
	{
		name: "repo_commit_drain",
		remoteName: "repo_commit_drain",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Drain approved/rejected repo_commit approvals and report the DO-local execution ledger status. Use after approving a repo_commit to get commit SHA, PR URL, or execution error.",
		inputSchema: REPO_COMMIT_DRAIN_SCHEMA,
		annotations: MUTATING,
	},
	{
		name: "repo_commit_status",
		remoteName: "repo_commit_status",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Read sanitized repo_commit execution status without draining or executing it. Use after approval to prove whether the approval-triggered drain already committed, failed, or stayed pending.",
		inputSchema: REPO_COMMIT_STATUS_SCHEMA,
		annotations: READ_ONLY,
	},
	// Canonical Cloudflare Artifacts repo (git-backed, tenant-owned) — the
	// durable small-state store for skill workflows and automation. Distinct
	// from the scratch workspace above: state that must survive across skill
	// runs belongs here.
	{
		name: "artifact_list_files",
		remoteName: "artifact_list_files",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"List files in this tedi's canonical Cloudflare Artifacts repo (durable operating files, skills, memory, daily logs, skill-workflow state). Not the scratch workspace and not a shell.",
		inputSchema: {
			type: "object",
			properties: {
				prefix: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 500 },
			},
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "artifact_read_file",
		remoteName: "artifact_read_file",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Read one UTF-8 text file from this tedi's canonical Cloudflare Artifacts repo, e.g. SOUL.md or a skill-workflow's durable state file.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", minLength: 1 },
				maxChars: { type: "integer", minimum: 1 },
			},
			required: ["path"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "artifact_write_file",
		remoteName: "artifact_write_file",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 300_000,
		description:
			"Write one UTF-8 text file to this tedi's canonical Cloudflare Artifacts repo (git-committed and pushed). Use for durable small state that survives between skill-workflow runs — ingestion data, config, cursors.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", minLength: 1 },
				content: { type: "string" },
				message: { type: "string", maxLength: 200 },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
];
