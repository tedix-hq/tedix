import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	credentialDirectory,
	getCurrentWorkspace,
	readWorkspaceCredentials,
	type CredentialStoreOpts,
} from "./credential-store";
import { withFileLockSync } from "./local-file-lock";
import { looksLikeUuid } from "./shared";
import { decodeJwtPayload } from "./jwt-payload";
import { isMultiOrganizationMcpUrl } from "./oauth-provider";

interface Selection {
	root: string;
	branch: string;
	workItemId: string;
}
interface OutputSelection {
	root: string;
	branch: string;
	osWorkspaceId: string;
	contextOutputId: string;
}
interface ContextTarget {
	/** Exact consent-selected tenant ID for the shared Connect gateway. */
	organization?: string;
	workspace: string;
	org: string;
	mcpUrl: string;
	projectId: string;
}
interface ChatSelection {
	target?: ContextTarget;
	root: string;
	branch: string;
	sessionId: string;
	workItemId?: string;
	osWorkspaceId?: string;
	contextOutputId?: string;
}
interface Binding extends ContextTarget {
	commonDir: string;
	origin: string;
	workspace: string;
	org: string;
	mcpUrl: string;
	projectId: string;
	selections: Selection[];
	outputs?: OutputSelection[];
	chats?: ChatSelection[];
}
interface PreferenceSelection {
	workspace: string;
	org: string;
	mcpUrl: string;
	osWorkspaceId: string;
	contextOutputId: string;
}
interface Store {
	version: 1;
	repositories: Binding[];
	preferences?: PreferenceSelection[];
	/**
	 * Legacy "Team lessons" document selections. Lessons now come from the
	 * organization's approved brain facts; an old entry is kept but ignored.
	 */
	lessons?: unknown;
	/** Explicit per-organization opt-in for recording turn ends and replies. */
	decisionCapture?: CaptureOptIn[];
}
interface CaptureOptIn extends Omit<
	PreferenceSelection,
	"osWorkspaceId" | "contextOutputId"
> {
	/**
	 * Project inbox for sessions outside a bound repository. Unset: the one
	 * project this organization's repository bindings share, if exactly one.
	 */
	projectId?: string;
}
interface Repo {
	root: string;
	commonDir: string;
	origin: string;
	branch: string;
}
export interface AgentContextOptions extends CredentialStoreOpts {
	cwd?: string;
	/** null explicitly selects legacy checkout context for non-host callers. */
	sessionId?: string | null;
	/**
	 * Outside a bound repository, resolve the default organization context
	 * (see `defaultContext`). Only the prompt and decision-capture hooks ask.
	 */
	allowDefault?: boolean;
	/** Environment for TEDIX_WORKSPACE / TEDIX_ORGANIZATION (tests). */
	env?: NodeJS.ProcessEnv;
}
export interface AgentContextResult {
	organization?: string;
	mcpUrl?: string;
	status: "bound" | "unbound" | "invalid";
	workspace?: string;
	org?: string;
	projectId?: string;
	root?: string;
	workItemId?: string;
	/** `default`: no bound repository; the profile's one organization. */
	contextSource?: "selection" | "worktree" | "chat" | "default";
	contextSessionId?: string;
	preferencesWorkspaceId?: string;
	preferencesOutputId?: string;
	/** Git origin of the bound repository, for repo-scoped team lessons. */
	origin?: string;
	/** Current branch, whose words hint the task to team lessons. */
	branch?: string;
	osWorkspaceId?: string;
	contextOutputId?: string;
	decisionCapture?: boolean;
	message?: string;
}

const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,62}$/;
function storePath(options?: AgentContextOptions): string {
	return join(credentialDirectory(options), "agent-contexts.json");
}
function readStore(options?: AgentContextOptions): Store {
	const path = storePath(options);
	if (!existsSync(path)) return { version: 1, repositories: [] };
	const value = JSON.parse(readFileSync(path, "utf8")) as Store;
	if (value.version !== 1 || !Array.isArray(value.repositories))
		throw new Error(
			"Invalid local agent-context store; inspect setup agents context before enabling reads",
		);
	return value;
}
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 2000,
	}).trim();
}
function repoAt(options?: AgentContextOptions): Repo {
	const cwd = resolve(options?.cwd ?? process.cwd());
	const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
	let origin = "";
	try {
		origin = git(root, ["remote", "get-url", "origin"]);
	} catch {
		/* Missing origin is checked against any binding. */
	}
	return {
		root,
		commonDir: realpathSync(
			resolve(root, git(root, ["rev-parse", "--git-common-dir"])),
		),
		origin,
		branch: git(root, ["branch", "--show-current"]),
	};
}
function checkedBinding(
	binding: Binding,
	repo: Repo,
	options?: AgentContextOptions,
): void {
	if (
		!WORKSPACE.test(binding.workspace) ||
		!looksLikeUuid(binding.projectId) ||
		!Array.isArray(binding.selections) ||
		(binding.outputs !== undefined && !Array.isArray(binding.outputs)) ||
		(binding.chats !== undefined && !Array.isArray(binding.chats))
	)
		throw new Error("Invalid local repository binding");
	if (binding.origin !== repo.origin)
		throw new Error(
			"Repository origin changed; bind the intended repository explicitly",
		);
	const target = contextTarget(
		binding.workspace,
		binding.organization,
		options,
	);
	if (target.org !== binding.org || target.mcpUrl !== binding.mcpUrl)
		throw new Error(
			"Bound organization profile changed or disappeared; bind the intended profile explicitly",
		);
}
function contextTarget(
	workspace: string,
	organization: string | undefined,
	options?: AgentContextOptions,
): Pick<ContextTarget, "org" | "mcpUrl" | "organization"> {
	const profile = readWorkspaceCredentials(workspace, options);
	if (!profile?.mcpUrl)
		throw new Error("Choose a saved profile; run tedix auth status first");
	const url = new URL(profile.mcpUrl);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		url.pathname !== "/mcp"
	)
		throw new Error("The profile must name an authenticated HTTPS MCP gateway");
	if (isMultiOrganizationMcpUrl(profile.mcpUrl)) {
		const selected = decodeJwtPayload(
			profile.oauthTokens?.access_token ?? "",
		)?.tedixSelectedOrganizations;
		if (
			!organization ||
			!Array.isArray(selected) ||
			selected.length < 1 ||
			selected.length > 10 ||
			selected.some((id) => typeof id !== "string" || !id || id.length > 256) ||
			new Set(selected).size !== selected.length ||
			!selected.includes(organization)
		)
			throw new Error(
				"Connect context requires --organization <selected ID> from tedix auth status; renew login if the organization is unavailable",
			);
		return { org: organization, organization, mcpUrl: profile.mcpUrl };
	}
	if (organization)
		throw new Error(
			"--organization requires a Connect profile; choose the tenant profile with --workspace",
		);
	if (!profile.org)
		throw new Error(
			"Choose a saved organization profile; run tedix auth status first",
		);
	return { org: profile.org, mcpUrl: profile.mcpUrl };
}

function selectedWork(
	binding: Binding,
	repo: Repo,
): Pick<AgentContextResult, "workItemId" | "contextSource"> {
	const selected = binding.selections.find((row) => row.root === repo.root);
	if (
		selected &&
		(!repo.branch ||
			selected.branch !== repo.branch ||
			!looksLikeUuid(selected.workItemId))
	)
		throw new Error(
			"Selected Work branch changed; clear or select the intended Work explicitly",
		);
	const path = `${repo.root}.tedix.json`;
	if (existsSync(path)) {
		const marker = JSON.parse(readFileSync(path, "utf8")) as {
			version?: number;
			branch?: string;
			workItemId?: string;
		};
		if (
			marker.version !== 1 ||
			!repo.branch ||
			marker.branch !== repo.branch ||
			!marker.workItemId ||
			!looksLikeUuid(marker.workItemId)
		)
			throw new Error(
				"Worktree marker does not match the current branch; inspect it before selecting Work",
			);
		if (selected && selected.workItemId !== marker.workItemId)
			throw new Error(
				"Selected Work conflicts with the governed worktree marker",
			);
		return { workItemId: marker.workItemId, contextSource: "worktree" };
	}
	return selected
		? { workItemId: selected.workItemId, contextSource: "selection" }
		: {};
}

function chatIdentity(options?: AgentContextOptions): string | undefined {
	if (options?.sessionId === null) return undefined;
	if (options?.sessionId !== undefined) {
		if (!looksLikeUuid(options.sessionId))
			throw new Error("--session requires a full chat UUID");
		return options.sessionId.toLowerCase();
	}
	// One chat per process: a Codex chat id and a Claude Code session id that
	// disagree mean the environment leaked from another host, so fail closed.
	const ids = [
		process.env.CODEX_SESSION_ID,
		process.env.CODEX_THREAD_ID,
		process.env.CLAUDE_CODE_SESSION_ID,
	]
		.map((id) => id?.trim())
		.filter((id): id is string => Boolean(id))
		.map((id) => id.toLowerCase());
	if (ids.some((id) => !looksLikeUuid(id)) || new Set(ids).size > 1)
		throw new Error(
			"Chat identity is invalid or conflicting; verify the current chat before selecting context",
		);
	return ids[0];
}
function chatBinding(
	binding: Binding,
	repo: Repo,
	options?: AgentContextOptions,
): { binding: Binding; sessionId?: string } {
	const sessionId = chatIdentity(options);
	const rows = (binding.chats ?? []).filter((row) => row.root === repo.root);
	if (!rows.length) return { binding };
	if (!sessionId)
		throw new Error(
			"Chat-scoped context requires the current chat identity (Codex chat or Claude Code session); no checkout selection was inherited",
		);
	const matches = rows.filter(
		(row) => row.sessionId.toLowerCase() === sessionId,
	);
	if (matches.length > 1)
		throw new Error("Duplicate chat context; inspect the local context store");
	const row = matches[0];
	if (
		row &&
		(row.branch !== repo.branch ||
			(row.target !== undefined &&
				(!row.target ||
					!WORKSPACE.test(row.target.workspace ?? "") ||
					!looksLikeUuid(row.target.projectId ?? "") ||
					typeof row.target.org !== "string" ||
					!row.target.org ||
					typeof row.target.mcpUrl !== "string" ||
					!row.target.mcpUrl)) ||
			!looksLikeUuid(row.sessionId) ||
			(row.workItemId !== undefined && !looksLikeUuid(row.workItemId)) ||
			Boolean(row.osWorkspaceId) !== Boolean(row.contextOutputId) ||
			(row.osWorkspaceId !== undefined &&
				(!looksLikeUuid(row.osWorkspaceId) ||
					!looksLikeUuid(row.contextOutputId!))))
	)
		throw new Error(
			"Chat context branch or identifiers changed; select the intended context explicitly",
		);
	return {
		sessionId,
		binding: {
			...binding,
			...row?.target,
			organization: row?.target
				? row.target.organization
				: binding.organization,
			selections: row?.workItemId
				? [{ root: repo.root, branch: repo.branch, workItemId: row.workItemId }]
				: [],
			outputs: row?.contextOutputId
				? [
						{
							root: repo.root,
							branch: repo.branch,
							osWorkspaceId: row.osWorkspaceId!,
							contextOutputId: row.contextOutputId,
						},
					]
				: [],
		},
	};
}

/** The one organization-wide document of a kind for this profile, if selected. */
function organizationDocument(
	rows: PreferenceSelection[] | undefined,
	active: ContextTarget,
): PreferenceSelection | undefined {
	const matches = (rows ?? []).filter(
		(row) =>
			row.workspace === active.workspace &&
			row.org === active.org &&
			row.mcpUrl === active.mcpUrl,
	);
	if (
		matches.length > 1 ||
		matches.some(
			(row) =>
				!looksLikeUuid(row.osWorkspaceId) ||
				!looksLikeUuid(row.contextOutputId),
		)
	)
		throw new Error(
			"Invalid organization document selection; reconnect preferences explicitly",
		);
	return matches[0];
}

/**
 * The profile and organization a session outside any bound repository works
 * in: TEDIX_WORKSPACE or the current profile, and TEDIX_ORGANIZATION or the
 * profile's only organization. Several selectable organizations and none
 * chosen, or a choice the profile cannot serve, is no target: never a guess.
 */
function defaultTarget(
	options?: AgentContextOptions,
): Omit<ContextTarget, "projectId"> | undefined {
	const env = options?.env ?? process.env;
	const workspace =
		env.TEDIX_WORKSPACE?.trim() || getCurrentWorkspace(options) || "";
	if (!WORKSPACE.test(workspace)) return undefined;
	const profile = readWorkspaceCredentials(workspace, options);
	if (!profile?.mcpUrl) return undefined;
	const requested = env.TEDIX_ORGANIZATION?.trim() || undefined;
	let organization: string | undefined;
	if (isMultiOrganizationMcpUrl(profile.mcpUrl)) {
		const selected = decodeJwtPayload(
			profile.oauthTokens?.access_token ?? "",
		)?.tedixSelectedOrganizations;
		if (!Array.isArray(selected)) return undefined;
		organization =
			requested ?? (selected.length === 1 ? String(selected[0]) : undefined);
		if (!organization) return undefined;
	} else if (requested && requested !== profile.org) return undefined;
	try {
		return { workspace, ...contextTarget(workspace, organization, options) };
	} catch {
		return undefined;
	}
}

/**
 * Default context for a session outside a bound repository: lessons for the
 * organization (no repository), and decision capture when this profile and
 * organization opted in and a project inbox is unambiguous.
 */
function defaultContext(
	store: Store,
	options?: AgentContextOptions,
): AgentContextResult {
	const target = defaultTarget(options);
	if (!target) return { status: "unbound" };
	const same = (row: { workspace: string; org: string; mcpUrl: string }) =>
		row.workspace === target.workspace &&
		row.org === target.org &&
		row.mcpUrl === target.mcpUrl;
	const optIn = (store.decisionCapture ?? []).find(same);
	const projects = new Set(
		store.repositories
			.filter(same)
			.map((row) => row.projectId)
			.filter(looksLikeUuid),
	);
	const projectId =
		optIn?.projectId && looksLikeUuid(optIn.projectId)
			? optIn.projectId
			: projects.size === 1
				? [...projects][0]
				: undefined;
	const sessionId = chatIdentity(options);
	return {
		status: "bound",
		contextSource: "default",
		workspace: target.workspace,
		org: target.org,
		...(target.organization ? { organization: target.organization } : {}),
		mcpUrl: target.mcpUrl,
		...(projectId ? { projectId } : {}),
		...(optIn && projectId ? { decisionCapture: true } : {}),
		...(sessionId ? { contextSessionId: sessionId } : {}),
	};
}

/** The profile and organization a Tedix call for some context goes to. */
export type OrganizationTarget = Omit<ContextTarget, "projectId">;

/** `git@host:a/b.git`, `https://host/a/b/` → `host/a/b` (lowercase). */
export function normalizeGitOrigin(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^[a-z+]+:\/\//, "")
		.replace(/^[^@/]+@([^:/]+):/, "$1/")
		.replace(/^[^@/]+@/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
}

/** Default organization outside any bound repository (see `defaultTarget`). */
export function defaultOrganizationTarget(
	options?: AgentContextOptions,
): OrganizationTarget | undefined {
	return defaultTarget(options);
}

/**
 * The organization each bound repository works in, keyed by normalized Git
 * origin. A binding whose profile no longer serves it is left out, and an
 * origin bound to two different targets is left out: never a guess.
 */
export function repositoryTargetsByOrigin(
	options?: AgentContextOptions,
): Map<string, OrganizationTarget> {
	const targets = new Map<string, OrganizationTarget>();
	const ambiguous = new Set<string>();
	let store: Store;
	try {
		store = readStore(options);
	} catch {
		return targets;
	}
	for (const binding of store.repositories) {
		if (!binding.origin || !WORKSPACE.test(binding.workspace)) continue;
		let target: OrganizationTarget;
		try {
			const resolved = contextTarget(
				binding.workspace,
				binding.organization,
				options,
			);
			if (resolved.org !== binding.org || resolved.mcpUrl !== binding.mcpUrl)
				continue;
			target = { workspace: binding.workspace, ...resolved };
		} catch {
			continue;
		}
		const origin = normalizeGitOrigin(binding.origin);
		const existing = targets.get(origin);
		if (
			existing &&
			(existing.workspace !== target.workspace || existing.org !== target.org)
		)
			ambiguous.add(origin);
		targets.set(origin, target);
	}
	for (const origin of ambiguous) targets.delete(origin);
	return targets;
}

/** Local correlation only. Does not read the gateway or restore an Attempt credential. */
export function resolveAgentContext(
	options?: AgentContextOptions,
): AgentContextResult {
	try {
		const store = readStore(options);
		const unbound = (): AgentContextResult =>
			options?.allowDefault
				? defaultContext(store, options)
				: { status: "unbound" };
		if (!store.repositories.length) return unbound();
		let repo: Repo;
		try {
			repo = repoAt(options);
		} catch {
			return unbound();
		}
		const binding = store.repositories.find(
			(row) => row.commonDir === repo.commonDir,
		);
		if (!binding) return unbound();
		const scoped = chatBinding(binding, repo, options);
		const active = scoped.binding;
		checkedBinding(active, repo, options);
		const preference = organizationDocument(store.preferences, active);
		const capture = (store.decisionCapture ?? []).some(
			(row) =>
				row.workspace === active.workspace &&
				row.org === active.org &&
				row.mcpUrl === active.mcpUrl,
		);
		const output = active.outputs?.find((row) => row.root === repo.root);
		if (
			output &&
			(output.branch !== repo.branch ||
				!looksLikeUuid(output.osWorkspaceId) ||
				!looksLikeUuid(output.contextOutputId))
		)
			throw new Error(
				"Selected shared Output branch or identifiers changed; disconnect-output or connect-output explicitly",
			);
		return {
			status: "bound",
			workspace: active.workspace,
			org: active.org,
			...(active.organization ? { organization: active.organization } : {}),
			mcpUrl: active.mcpUrl,
			projectId: active.projectId,
			root: repo.root,
			...(repo.origin ? { origin: repo.origin } : {}),
			...(repo.branch ? { branch: repo.branch } : {}),
			...(preference
				? {
						preferencesWorkspaceId: preference.osWorkspaceId,
						preferencesOutputId: preference.contextOutputId,
					}
				: {}),
			...selectedWork(active, repo),
			...(capture ? { decisionCapture: true } : {}),
			...(scoped.sessionId
				? {
						contextSessionId: scoped.sessionId,
						...(active.selections.length
							? { contextSource: "chat" as const }
							: {}),
					}
				: {}),
			...(output
				? {
						osWorkspaceId: output.osWorkspaceId,
						contextOutputId: output.contextOutputId,
					}
				: {}),
		};
	} catch (error) {
		return {
			status: "invalid",
			message:
				error instanceof Error
					? error.message
					: "Local context could not be read",
		};
	}
}

export function changeAgentContext(
	action:
		| "bind"
		| "connect"
		| "select"
		| "clear"
		| "unbind"
		| "connect-output"
		| "disconnect-output"
		| "connect-preferences"
		| "disconnect-preferences"
		| "enable-decision-capture"
		| "disable-decision-capture",
	input: {
		workspace?: string;
		organization?: string;
		projectId?: string;
		workItemId?: string;
		osWorkspaceId?: string;
		contextOutputId?: string;
	},
	options?: AgentContextOptions,
): AgentContextResult {
	if (
		(action === "enable-decision-capture" ||
			action === "disable-decision-capture") &&
		!insideBoundRepository(options)
	)
		return changeDefaultCapture(
			action === "enable-decision-capture",
			input.projectId,
			options,
		);
	const repo = repoAt(options);
	const sessionId = chatIdentity(options);
	const directory = credentialDirectory(options);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	withFileLockSync(join(directory, "locks", "agent-contexts"), () => {
		const store = readStore(options);
		let binding = store.repositories.find(
			(row) => row.commonDir === repo.commonDir,
		);
		if (action === "bind") {
			if (
				!input.workspace ||
				!WORKSPACE.test(input.workspace) ||
				!input.projectId ||
				!looksLikeUuid(input.projectId)
			)
				throw new Error(
					"bind requires --workspace <profile> and --project <UUID>",
				);
			const selectedTarget = contextTarget(
				input.workspace,
				input.organization,
				options,
			);
			if (!repo.origin)
				throw new Error("Bind a repository with an explicit origin remote");
			if (
				binding &&
				(binding.workspace !== input.workspace ||
					binding.org !== selectedTarget.org ||
					binding.projectId !== input.projectId ||
					binding.mcpUrl !== selectedTarget.mcpUrl ||
					binding.origin !== repo.origin)
			)
				throw new Error(
					"A different binding exists; unbind it explicitly before choosing another target",
				);
			binding ??= {
				commonDir: repo.commonDir,
				origin: repo.origin,
				workspace: input.workspace,
				...selectedTarget,
				projectId: input.projectId,
				selections: [],
			};
			if (!store.repositories.includes(binding))
				store.repositories.push(binding);
		} else if (action === "connect") {
			if (!binding)
				throw new Error("This repository is not bound; use context bind first");
			if (!sessionId || !repo.branch)
				throw new Error(
					"connect requires a chat identity (Codex chat or Claude Code session) and named branch",
				);
			if (binding.origin !== repo.origin)
				throw new Error(
					"Repository origin changed; bind the intended repository explicitly",
				);
			if (
				!input.workspace ||
				!WORKSPACE.test(input.workspace) ||
				!input.projectId ||
				!looksLikeUuid(input.projectId)
			)
				throw new Error(
					"connect requires --workspace <profile> and --project <UUID>",
				);
			const selectedTarget = contextTarget(
				input.workspace,
				input.organization,
				options,
			);
			const rows = (binding.chats ?? []).filter(
				(row) =>
					row.root === repo.root && row.sessionId.toLowerCase() === sessionId,
			);
			if (rows.length > 1)
				throw new Error(
					"Duplicate chat context; inspect the local context store",
				);
			const row = rows[0];
			if (row && row.branch !== repo.branch)
				throw new Error(
					"Chat branch changed; clear and disconnect-output before connecting",
				);
			const target = {
				workspace: input.workspace,
				...selectedTarget,
				projectId: input.projectId,
			};
			const old = row?.target ?? binding;
			const changed =
				old.workspace !== target.workspace ||
				old.org !== target.org ||
				old.mcpUrl !== target.mcpUrl ||
				old.projectId !== target.projectId;
			if (changed && (row?.workItemId || row?.contextOutputId))
				throw new Error(
					"Clear Work and disconnect-output before changing the chat target",
				);
			binding.chats = (binding.chats ?? []).filter(
				(r) => r.root !== repo.root || r.sessionId.toLowerCase() !== sessionId,
			);
			binding.chats.push({
				...row,
				root: repo.root,
				branch: repo.branch,
				sessionId,
				target,
			});
		} else if (action === "unbind") {
			store.repositories = store.repositories.filter(
				(row) => row.commonDir !== repo.commonDir,
			);
		} else if (
			action === "enable-decision-capture" ||
			action === "disable-decision-capture"
		) {
			if (!binding)
				throw new Error("This repository is not bound; use context bind first");
			const active = chatBinding(binding, repo, options).binding;
			checkedBinding(active, repo, options);
			const same = (row: CaptureOptIn) =>
				row.workspace === active.workspace &&
				row.org === active.org &&
				row.mcpUrl === active.mcpUrl;
			const pinned = (store.decisionCapture ?? []).find(same)?.projectId;
			store.decisionCapture = (store.decisionCapture ?? []).filter(
				(row) => !same(row),
			);
			if (action === "enable-decision-capture")
				store.decisionCapture.push({
					workspace: active.workspace,
					org: active.org,
					mcpUrl: active.mcpUrl,
					...(pinned ? { projectId: pinned } : {}),
				});
		} else if (
			action === "connect-preferences" ||
			action === "disconnect-preferences"
		) {
			if (!binding)
				throw new Error("This repository is not bound; use context bind first");
			const active = chatBinding(binding, repo, options).binding;
			checkedBinding(active, repo, options);
			const connect = action.startsWith("connect-");
			if (
				connect &&
				(!input.osWorkspaceId ||
					!looksLikeUuid(input.osWorkspaceId) ||
					!input.contextOutputId ||
					!looksLikeUuid(input.contextOutputId))
			)
				throw new Error(
					"connect-preferences requires --os-workspace <UUID> and --output <UUID>",
				);
			const rows = (store.preferences ?? []).filter(
				(row) =>
					row.workspace !== active.workspace ||
					row.org !== active.org ||
					row.mcpUrl !== active.mcpUrl,
			);
			store.preferences = rows;
			if (connect)
				rows.push({
					workspace: active.workspace,
					org: active.org,
					mcpUrl: active.mcpUrl,
					osWorkspaceId: input.osWorkspaceId!,
					contextOutputId: input.contextOutputId!,
				});
		} else {
			if (!binding)
				throw new Error("This repository is not bound; use context bind first");
			const original = binding;
			let chat: ChatSelection | undefined;
			let chatTarget: ContextTarget | undefined;
			if (sessionId) {
				if (!repo.branch)
					throw new Error("Select chat context on a named branch");
				chat = original.chats?.find(
					(row) =>
						row.root === repo.root && row.sessionId.toLowerCase() === sessionId,
				);
				if (
					chat &&
					chat.branch !== repo.branch &&
					action !== "clear" &&
					action !== "disconnect-output"
				)
					throw new Error(
						"Chat branch changed; clear and disconnect-output before selecting a new context",
					);
				chatTarget = chat?.target;
				if (chat && chat.branch !== repo.branch) chat = undefined;
				binding = {
					...original,
					...chatTarget,
					organization: chatTarget
						? chatTarget.organization
						: original.organization,
					selections: chat?.workItemId
						? [
								{
									root: repo.root,
									branch: repo.branch,
									workItemId: chat.workItemId,
								},
							]
						: [],
					outputs: chat?.contextOutputId
						? [
								{
									root: repo.root,
									branch: repo.branch,
									osWorkspaceId: chat.osWorkspaceId!,
									contextOutputId: chat.contextOutputId,
								},
							]
						: [],
				};
			} else if (original.chats?.some((row) => row.root === repo.root)) {
				throw new Error(
					"Chat-scoped context requires --session or the current chat identity (Codex chat or Claude Code session)",
				);
			}
			checkedBinding(binding, repo, options);
			if (action === "connect-output" || action === "disconnect-output") {
				if (
					action === "connect-output" &&
					(!repo.branch ||
						!input.osWorkspaceId ||
						!looksLikeUuid(input.osWorkspaceId) ||
						!input.contextOutputId ||
						!looksLikeUuid(input.contextOutputId))
				)
					throw new Error(
						"connect-output requires a named branch, --os-workspace <UUID> and --output <UUID>",
					);
				binding.outputs = (binding.outputs ?? []).filter(
					(row) => row.root !== repo.root,
				);
				if (action === "connect-output")
					binding.outputs.push({
						root: repo.root,
						branch: repo.branch,
						osWorkspaceId: input.osWorkspaceId!,
						contextOutputId: input.contextOutputId!,
					});
			} else {
				if (
					action === "select" &&
					(!input.workItemId || !looksLikeUuid(input.workItemId))
				)
					throw new Error("select requires a full Work Item UUID");
				binding.selections = binding.selections.filter(
					(row) => row.root !== repo.root,
				);
				if (action === "select") {
					if (!repo.branch)
						throw new Error(
							"Select Work on a named branch, or supply an explicit Work ID to the session",
						);
					binding.selections.push({
						root: repo.root,
						branch: repo.branch,
						workItemId: input.workItemId!,
					});
					selectedWork(binding, repo);
				}
			}
			if (sessionId) {
				const work = binding.selections.find((row) => row.root === repo.root);
				const output = binding.outputs?.find((row) => row.root === repo.root);
				original.chats = (original.chats ?? []).filter(
					(row) =>
						row.root !== repo.root || row.sessionId.toLowerCase() !== sessionId,
				);
				original.chats.push({
					root: repo.root,
					branch: repo.branch,
					sessionId,
					...(chatTarget ? { target: chatTarget } : {}),
					...(work ? { workItemId: work.workItemId } : {}),
					...(output
						? {
								osWorkspaceId: output.osWorkspaceId,
								contextOutputId: output.contextOutputId,
							}
						: {}),
				});
			}
		}
		writeStore(store, options);
	});
	return resolveAgentContext(options);
}

function writeStore(store: Store, options?: AgentContextOptions): void {
	const path = storePath(options);
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

function insideBoundRepository(options?: AgentContextOptions): boolean {
	try {
		const repo = repoAt(options);
		return readStore(options).repositories.some(
			(row) => row.commonDir === repo.commonDir,
		);
	} catch {
		return false;
	}
}

/**
 * Decision-capture opt-in outside a bound repository: for the default
 * organization only (see `defaultTarget`), optionally pinning the project
 * inbox its questions go to.
 */
function changeDefaultCapture(
	enable: boolean,
	projectId: string | undefined,
	options?: AgentContextOptions,
): AgentContextResult {
	const target = defaultTarget(options);
	if (!target)
		throw new Error(
			"No single organization for this folder: set TEDIX_ORGANIZATION to a selected organization ID (see tedix auth status), or run in a bound repository",
		);
	if (projectId !== undefined && (!enable || !looksLikeUuid(projectId)))
		throw new Error("--project takes a project UUID and only when enabling");
	const directory = credentialDirectory(options);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	withFileLockSync(join(directory, "locks", "agent-contexts"), () => {
		const store = readStore(options);
		const rows = store.decisionCapture ?? [];
		const old = rows.find(
			(row) =>
				row.workspace === target.workspace &&
				row.org === target.org &&
				row.mcpUrl === target.mcpUrl,
		);
		store.decisionCapture = rows.filter((row) => row !== old);
		if (enable) {
			const project = projectId ?? old?.projectId;
			store.decisionCapture.push({
				workspace: target.workspace,
				org: target.org,
				mcpUrl: target.mcpUrl,
				...(project ? { projectId: project } : {}),
			});
		}
		writeStore(store, options);
	});
	return resolveAgentContext({ ...options, allowDefault: true });
}

export const agentContextUsage = `Local opt-in Tedix session context

  tedix setup agents context bind --workspace <profile> [--organization <selected ID>] --project <UUID>
  tedix setup agents context connect --workspace <profile> [--organization <selected ID>] --project <UUID> [--session <chat UUID>]
  tedix setup agents context select <Work Item UUID>
  tedix setup agents context clear
  tedix setup agents context connect-output --os-workspace <UUID> --output <UUID>
  tedix setup agents context connect-preferences --os-workspace <UUID> --output <UUID>
  tedix setup agents context disconnect-preferences
  tedix setup agents context enable-decision-capture [--project <UUID>]
  tedix setup agents context disable-decision-capture
  tedix setup agents context disconnect-output
  tedix setup agents context show [--json] [--allow-default]
  tedix setup agents context unbind

Run in the repository, or pass --directory <path>. Select/clear/connect-output/
disconnect-output/show accept --session <chat UUID>; the Codex chat or Claude Code
session identity in the environment is used automatically. Connect profiles require an exact consent-selected
organization ID from auth status. connect pins the profile, organization and project
for this chat only; it does not retarget the repository or sibling chats. Clear Work
and disconnect-output before changing a chat target. Live ownership is checked by
the hooks, not by this local connection. Chat choices remain separate in a shared checkout.
Once a checkout has chat choices, missing identity cannot inherit checkout choices.
Binding enables read-only
context in its Git worktrees. Governed worktree markers select their Work Item;
other checkouts use an explicit selection scoped to the current branch.
connect-output selects a read-only shared document for this checkout and branch,
without changing Work selection or sibling worktrees. Its ownership is verified
by the prompt hook at read time; local selection alone verifies no live access.
connect-preferences selects one organization-wide working-preferences document
that every chat of this profile and organization reads next to its task context,
under the same checks. Team lessons need no selection: each bound chat reads the
organization's approved lessons for this repository from Tedix memory: lessons
for everyone in the organization plus your own personal ones.
Outside a bound repository (any folder, non-coding work included), the prompt
and capture hooks use the default organization: TEDIX_WORKSPACE or the current
profile, and TEDIX_ORGANIZATION or that profile's only organization. With
several selectable organizations and none chosen they stay idle; they never
guess. There, lessons carry no repository, and decision capture runs only when
the organization opted in and has one project inbox: the one its bound
repositories share, or the --project given to enable-decision-capture run
outside a repository. show --allow-default prints that resolution.
enable-decision-capture opts this profile and organization into recording each
finished agent turn and the reply that follows as an Interaction addressed to you
in its project inbox. It is the only context setting that sends conversation text;
disable-decision-capture stops it for every bound repository of that organization.
unbind revokes the local opt-in for all worktrees of this repository.
These commands do not grant execution authority; only decision capture changes Tedix records.
`;

export function runAgentContext(
	args: string[],
	options?: AgentContextOptions,
): number {
	if (!args.length || args[0] === "--help" || args[0] === "-h") {
		console.log(agentContextUsage);
		return 0;
	}
	const action = args[0];
	if (
		![
			"bind",
			"connect",
			"show",
			"select",
			"clear",
			"unbind",
			"connect-output",
			"disconnect-output",
			"connect-preferences",
			"disconnect-preferences",
			"enable-decision-capture",
			"disable-decision-capture",
		].includes(action!)
	)
		throw new Error("Unknown context action; use setup agents context --help");
	const values: Record<string, string> = {};
	let json = false;
	let allowDefault = false;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--json" && !json) {
			json = true;
			continue;
		}
		if (arg === "--allow-default" && action === "show" && !allowDefault) {
			allowDefault = true;
			continue;
		}
		if (action === "select" && i === 1 && !arg.startsWith("--")) {
			values.workItemId = arg;
			continue;
		}
		const key = (
			{
				"--workspace": "workspace",
				"--organization": "organization",
				"--project": "projectId",
				"--directory": "cwd",
				"--session": "sessionId",
				"--os-workspace": "osWorkspaceId",
				"--output": "contextOutputId",
			} as Record<string, string>
		)[arg];
		const value = args[++i];
		if (!key || values[key] || !value || value.startsWith("--"))
			throw new Error(`Unknown, duplicate or missing context option: ${arg}`);
		if (
			["osWorkspaceId", "contextOutputId"].includes(key)
				? !["connect-output", "connect-preferences"].includes(action!)
				: !["cwd", "sessionId"].includes(key) &&
					!["bind", "connect"].includes(action!) &&
					!(key === "projectId" && action === "enable-decision-capture")
		)
			throw new Error(`${arg} applies only to context bind or connect-output`);
		values[key] = value;
	}
	if (values.sessionId && ["bind", "unbind"].includes(action!))
		throw new Error(
			"--session selects chat context, not the repository binding",
		);
	const opts = {
		...options,
		...(values.cwd ? { cwd: values.cwd } : {}),
		...(values.sessionId ? { sessionId: values.sessionId } : {}),
		...(allowDefault ? { allowDefault } : {}),
	};
	const result =
		action === "show"
			? resolveAgentContext(opts)
			: changeAgentContext(
					action as
						| "bind"
						| "connect"
						| "select"
						| "clear"
						| "unbind"
						| "connect-output"
						| "disconnect-output"
						| "connect-preferences"
						| "disconnect-preferences"
						| "enable-decision-capture"
						| "disable-decision-capture",
					values,
					opts,
				);
	console.log(
		json
			? JSON.stringify(result)
			: result.status === "bound"
				? `Bound ${result.root} to ${result.workspace}, project ${result.projectId}.\n${result.workItemId ? `Selected Work: ${result.workItemId} (${result.contextSource})` : "No selected Work; use context select or a governed worktree."}`
				: (result.message ??
					"Repository context is unbound; Tedix preflight stays idle."),
	);
	return result.status === "invalid" && !json ? 1 : 0;
}
