import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { REPO_LOAD_MAX_FILES } from "./repo-load";

interface ComputerRepoActions {
	load(input: {
		paths: string[];
		ref?: string;
		maxFiles?: number;
	}): Promise<unknown>;
	clone(input: {
		ref?: string;
		paths?: string[];
		depth?: number;
	}): Promise<unknown>;
	git(input: { args: string[]; cwd?: string }): Promise<unknown>;
	commit(input: {
		branch: string;
		message: string;
		paths: string[];
		deletePaths?: string[];
		baseRef?: string;
		openPr?: boolean;
		prBase?: string;
	}): Promise<unknown>;
}

/** Schemas are shared; each caller supplies actions bound to its own Computer workspace. */
export function createComputerRepoTools(actions: ComputerRepoActions): ToolSet {
	return {
		repo_load: tool({
			description:
				"Read a few explicitly selected repository files into scratch repo/. For repository-wide documentation, coding, Git history, or validation, use open_computer({ repository: true }) and its native file/exec tools instead. This additive read does not clear unrelated repo/ paths; use clone_repo for one coherent ref/path snapshot. " +
				"Requires the tedi to have a repo_config (repoUrl, optional branch) set in D1 and a GITHUB_PAT tedi secret. " +
				"Use repo_commit for approval-gated writes.",
			inputSchema: z.object({
				paths: z
					.array(z.string().min(1))
					.min(1)
					.describe(
						"One or more file paths or path prefixes to load from the repo (e.g. ['src/index.ts', 'src/utils/']).",
					),
				ref: z
					.string()
					.optional()
					.describe(
						"Git ref (branch, tag, or commit SHA) to load from. Defaults to the repo_config branch or 'main'.",
					),
				maxFiles: z
					.number()
					.int()
					.positive()
					.max(REPO_LOAD_MAX_FILES)
					.optional()
					.describe(
						`Maximum files to load (default and cap: ${REPO_LOAD_MAX_FILES}).`,
					),
			}),
			execute: async (input) => actions.load(input),
		}),
		clone_repo: tool({
			description:
				"Scratch-only shallow clone for a small repository. Replaces repo/ and can fall back to selected files without .git. For repository-wide documentation, coding, Git history, installs, tests or builds, use open_computer({ repository: true }) instead, then native files and exec in its returned cwd. Use run_git here only when gitAvailable=true.",
			inputSchema: z.object({
				ref: z
					.string()
					.optional()
					.describe(
						"Branch, tag, or commit (defaults to the configured branch).",
					),
				paths: z
					.array(z.string().min(1))
					.optional()
					.describe("Sparse working-tree paths (directories or files)."),
				depth: z
					.number()
					.int()
					.positive()
					.max(50)
					.optional()
					.describe("Shallow depth (default 1)."),
			}),
			execute: async (input) => actions.clone(input),
		}),
		run_git: tool({
			description:
				"Run a bounded LOCAL Git operation against the durable repo/ working tree after clone_repo: status, diff, log, branch, show, cat-file, add, commit, checkout, and other worktree operations. Use ['help', '<command>'] to discover the native workspace Git options. Network subcommands are rejected; use clone_repo to fetch and repo_commit for approval-gated pushes.",
			inputSchema: z.object({
				args: z
					.array(z.string())
					.min(1)
					.max(64)
					.describe('Git argv, e.g. ["status"] or ["diff", "--stat"].'),
				cwd: z
					.string()
					.optional()
					.describe(
						"Working directory (defaults to the repo/ workspace root).",
					),
			}),
			execute: async (input) => actions.git(input),
		}),
		repo_commit: tool({
			description:
				"Commit your workspace repo/ edits to a branch of your configured GitHub repository. " +
				"Reads the specified workspace paths (repo/<path>), builds a changeset, and submits it for approval. " +
				"Low-risk auto-approved commits drain immediately and return commit proof; human-approved commits can be inspected with repo_commit_status or explicitly drained with repo_commit_drain. " +
				"WRITE tool: approval-gated. Protected branches (main, master, release/*, etc.) always require operator approval. " +
				"The proposal DECLARES an exact content fingerprint of this changeset and target; the publish step refuses anything that does not match it. " +
				"A refused publish returns ok=false with denied=true, published=false, error='repo_commit_publish_denied' and a deniedCode — nothing was pushed, and retrying the same mismatch will be refused again. " +
				"Requires GITHUB_PAT tedi secret and repo_config set on this tedi.",
			inputSchema: z.object({
				branch: z
					.string()
					.min(1)
					.describe("Target branch name for the commit."),
				message: z.string().min(1).describe("Commit message."),
				paths: z
					.array(z.string().min(1))
					.min(1)
					.describe(
						"Workspace repo/ paths whose current content becomes the committed changeset (e.g. ['repo/src/foo.ts']).",
					),
				deletePaths: z
					.array(z.string().min(1))
					.optional()
					.describe("Workspace repo/ paths to delete from the repo."),
				baseRef: z
					.string()
					.optional()
					.describe(
						"Base ref to branch from. Defaults to repo_config branch or 'main'.",
					),
				openPr: z
					.boolean()
					.optional()
					.describe("Open a pull request after committing."),
				prBase: z
					.string()
					.optional()
					.describe("PR base branch (required when openPr=true)."),
			}),
			execute: async (input) => actions.commit(input),
		}),
	};
}
