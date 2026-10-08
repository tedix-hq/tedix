#!/usr/bin/env bun
import { decodeJwtPayload } from "./jwt-payload";

import { runWhoCommand } from "./who";
import { readFileSync } from "node:fs";
import { LOCAL_TEDIX_MCP_URL, parseOptions } from "./options";
import { type AvailableWorkspace, listAvailableWorkspaces } from "./account";
import { selectWorkspaceInBrowser } from "./browser-workspace-selection";
import {
	printAuthStatus,
	requireExplicitTedixLoginTenant,
	resolveAuth,
	resolveLoginWorkspaceName,
	resolveStoredLoginAuth,
	resolveWorkspaceName,
	workspaceNameFromGateway,
	workspaceNameFromOrg,
} from "./auth-resolve";
import {
	codeDiscoveryErrorMessage,
	codeOutputValue,
	formatCodeValue,
	normalizeCodeResult,
} from "./code-result";
import {
	findCommand,
	firstWord,
	interactiveSlashCommands,
	reportSendResult,
} from "./commands";
import {
	commandMap,
	exitCodeHelp,
	findTopLevelCommand,
	machineHelp,
	rootHelp,
	topLevelHelp,
} from "./command-registry";
import {
	clearAllCredentials,
	DEFAULT_WORKSPACE,
	getCurrentWorkspace,
	listWorkspaces,
	readWorkspaceCredentials,
	removeWorkspace,
	setCurrentWorkspace,
	type WorkspaceCredential,
	writeWorkspaceCredentials,
} from "./credential-store";
import {
	checkpointExternalAgentKnowledge,
	externalAgentStatus,
	finishExternalAgentSession,
	listStaleExternalAgentKnowledgeSessions,
	renameExternalAgentPrincipal,
	startExternalAgentSession,
} from "./external-agent";
import { runFlowCommand } from "./flow";
import { errorText, resolveColorMode } from "./format";
import { DEFAULT_TEDIX_MCP_URL, TedixHomeClient } from "./home-client";
import { runLocalInstallation } from "./local-installation";
import { resetTerminalModes } from "./interrupt";
import {
	beginSdkOAuthLogin,
	issuedOAuthScopes,
	TEDIX_CONNECT_MCP_URL,
	isMultiOrganizationMcpUrl,
	isTedixHostedMcpUrl,
	openBrowser,
	TEDIX_OAUTH_CLIENT_ID,
	WorkspaceOAuthProvider,
} from "./oauth-provider";
import { CLI_VERSION, looksLikeUuid, type CliOptions } from "./shared";
import { runSkillCommand } from "./skill";
import { buildStatusReport, renderStatusReport } from "./status";
import { runTediCommand } from "./tedi";
import { listThreads, resolveThread, setThread } from "./thread-store";
import { buildContext, buildOps } from "./turn";
import { runRollbackCommand, runUpdateCommand } from "./update";
import { runWork } from "./work";
import { createFileWorkAttemptStore } from "./work-attempt-store";
import {
	organizationScopedAttemptStore,
	resolveOrganizationTarget,
} from "./organization-target";
import { runWorkflowCommand } from "./workflow";
import { resolvePublicCliWorkspace } from "./workspace-resolver";

/** Parse `--org <tenant>` from argv for `tedix login` (`tedix` → `org_tedix`). */
function readOrgFlag(argv: string[]): string | undefined {
	const i = argv.indexOf("--org");
	const v = i >= 0 ? argv[i + 1] : undefined;
	return v && !v.startsWith("-") ? v : undefined;
}

/**
 * Split a one-shot prompt that is really a slash command into its name and
 * remaining arguments. Returns undefined for ordinary prose, and for bare "/"
 * or a leading path like "/Users/..." so real prompts are never hijacked.
 */
export function parseSlashPrompt(
	prompt: string,
): { name: string; rest: string } | undefined {
	const trimmed = prompt.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [name, rest] = firstWord(trimmed.slice(1));
	if (!name || !/^[a-z][a-z0-9-]*$/i.test(name)) return undefined;
	return { name: name.toLowerCase(), rest: rest.trim() };
}

/**
 * Explain an unresolved slash command instead of delegating its text. REPL-only
 * verbs get named as such so the caller knows the command exists but the
 * surface does not.
 */
export function slashCommandError(name: string): string {
	const replOnly = interactiveSlashCommands().some(
		(command) => command.name === name && command.source === "interactive",
	);
	if (replOnly) {
		return `"/${name}" is an interactive-only command. Run \`tedix\` and use /${name} there. It was NOT sent to Home as a message.`;
	}
	return `Unknown command "/${name}". Run \`tedix --help\` for available commands, or drop the leading "/" to send it to Home as a message.`;
}

/**
 * Resolve the JS source for `tedix code`: the positional argument, else piped
 * stdin (so `tedix code < script.js` works). Empty when neither is present.
 */
function readCodeSource(options: CliOptions): string {
	const inline = options.prompt?.trim();
	if (inline) return inline;
	if (!process.stdin.isTTY) {
		try {
			return readFileSync(0, "utf8").trim();
		} catch {
			return "";
		}
	}
	return "";
}

function improveCliErrorMessage(error: unknown): string {
	const message = errorText(error);
	if (message.includes("tenant_mismatch")) {
		return `${message}\n\nAuth tenant mismatch: run \`tedix auth status --json\` to inspect the selected organization and credential. Select the matching workspace profile with \`-w <workspace>\`, or run \`tedix login\` to authorize the intended organization.`;
	}
	return message;
}

export async function runDirectCode(
	client: Pick<TedixHomeClient, "runCode" | "runCodeWithDestructiveApproval">,
	source: string,
	destructiveApprovalReason?: string,
	target?: { workspace?: string; organization?: string; url?: string },
): Promise<unknown> {
	try {
		return destructiveApprovalReason
			? await client.runCodeWithDestructiveApproval(
					source,
					destructiveApprovalReason,
				)
			: await client.runCode(source);
	} catch (error) {
		throw new Error(codeDiscoveryErrorMessage(errorText(error), target), {
			cause: error,
		});
	}
}

async function main() {
	// Installation lifecycle commands are local and never resolve gateway auth.
	const localCommand = process.argv[2];
	if (localCommand === "setup" || localCommand === "dev") {
		process.exitCode = await runLocalInstallation(
			localCommand,
			process.argv.slice(3),
		);
		return;
	}
	// Agent-host hooks write one JSON line to stdout and must stay silent otherwise.
	if (localCommand === "hooks") {
		const { runHooksCommand } = await import("./hooks/command");
		process.exitCode = await runHooksCommand(process.argv.slice(3));
		return;
	}
	// Local extraction; each organization call runs as its own `tedix code` child.
	if (localCommand === "learn") {
		const { runLearnCommand } = await import("./learn-import");
		process.exitCode = await runLearnCommand(process.argv.slice(3));
		return;
	}
	// P4 BONUS: reset terminal modes on startup and on exit so a crash never
	// leaves the parent shell with mouse-tracking / bracketed-paste / alt-screen
	// escape garbage. Only write to stdout if it's a real TTY.
	if (process.stdout.isTTY) {
		const write = process.stdout.write.bind(process.stdout);
		resetTerminalModes(write);
		process.on("exit", () => resetTerminalModes(write));
	}

	const { command, options } = parseOptions(process.argv.slice(2));
	if (options.version) {
		console.log(CLI_VERSION);
		return;
	}
	if (options.help) {
		console.log(options.commandExplicit ? topLevelHelp(command) : rootHelp());
		return;
	}
	if (command === "help") {
		const topic = options.prompt?.trim();
		if (options.json) {
			console.log(JSON.stringify(machineHelp(topic || undefined)));
			return;
		}
		if (topic === "exit-codes") {
			console.log(exitCodeHelp());
			return;
		}
		if (topic) {
			const commandSpec = findTopLevelCommand(topic);
			if (!commandSpec && !findCommand(topic)) {
				throw new Error(
					`Unknown help topic "${topic}". Run \`tedix help --all\` for the command map.`,
				);
			}
			console.log(topLevelHelp(topic));
			return;
		}
		console.log(commandMap());
		return;
	}
	if (command === "setup" || command === "dev" || command === "hooks") {
		throw new Error(
			`Put local options after the command: tedix ${command} --help. Workspace and gateway options do not apply to local installations.`,
		);
	}
	const spec = findCommand(command);
	if (!spec && !findTopLevelCommand(command)) {
		throw new Error(
			`Unknown command "${command}". Run \`tedix help --all\` for the command map.`,
		);
	}
	if (command === "update") {
		process.exitCode = await runUpdateCommand({
			check: options.updateCheck ?? false,
			force: options.updateForce ?? false,
			json: options.json,
			version: options.prompt?.trim() || undefined,
		});
		return;
	}
	if (command === "rollback") {
		if (options.prompt?.trim()) {
			throw new Error(
				"rollback does not accept a version; use `tedix update <version> --force` for an exact downgrade",
			);
		}
		process.exitCode = await runRollbackCommand({ json: options.json });
		return;
	}
	// `auth`, `agent`, `logout`, `login`, `workspaces`, and `use` run BEFORE resolveAuth:
	// logout removes stored credentials; login OBTAINS auth via the Descope OAuth
	// browser flow; auth status / workspaces inspect local state without printing
	// secrets; use switches the current workspace.
	if (command === "auth") {
		if ((options.prompt ?? "status").trim() !== "status") {
			throw new Error(
				`Unknown auth command "${options.prompt}". Usage: tedix auth status`,
			);
		}
		await printAuthStatus(options);
		return;
	}
	if (command === "agent") {
		const [subcommand = "status", ...agentArgs] = (options.prompt ?? "status")
			.trim()
			.split(/\s+/);
		const workspace = resolveWorkspaceName(options);
		if (subcommand === "status") {
			const status = externalAgentStatus(workspace);
			if (options.json) console.log(JSON.stringify(status, null, 2));
			else if (status.configured !== true) {
				console.log(
					`No external-agent principal is configured for workspace "${workspace}".`,
				);
			} else {
				console.log(`External agent: ${status.key} (${status.principalId})`);
				console.log(`  workspace: ${workspace}`);
				console.log(`  gateway: ${status.mcpUrl}`);
				console.log(
					`  current session: ${status.currentSession ? "started" : "not started"}`,
				);
				console.log(`  stored sessions: ${status.sessionCount}`);
				console.log("  credential: stored (redacted)");
			}
			return;
		}
		if (subcommand === "start") {
			const configured = externalAgentStatus(workspace).configured === true;
			const { auth, loginError } = configured
				? { auth: null, loginError: undefined }
				: await resolveStoredLoginAuth(workspace);
			const oauthTokens = await auth?.oauthProvider?.tokens();
			const bearer =
				auth?.headers.Authorization?.replace(/^Bearer /, "") ??
				oauthTokens?.access_token;
			const workspaceCredential = configured
				? undefined
				: (readWorkspaceCredentials(workspace) ?? undefined);
			if (!configured && (!bearer || !workspaceCredential)) {
				throw new Error(
					loginError ??
						`A signed-in owner is required to bootstrap external-agent identity. Run \`tedix login --workspace ${workspace}\`.`,
				);
			}
			const started = await startExternalAgentSession({
				workspace,
				workspaceCredential,
				organization: options.organization,
				mcpUrl: workspaceCredential?.mcpUrl ?? options.url,
				oauthBearer: bearer,
				agentKey: options.agentKey,
				displayName: options.agentDisplayName,
				harness: options.agentHarness,
				harnessVersion: options.agentHarnessVersion,
				modelProvider: options.agentModelProvider,
				modelId: options.agentModelId,
				modelVersion: options.agentModelVersion,
				scopes: options.agentScopes,
			});
			const result = {
				workspace,
				principalId: started.profile.principalId,
				principalKey: started.profile.key,
				session: started.session,
				mcpUrl: started.profile.mcpUrl,
				scopes: started.profile.scopes,
				credentialStored: true,
				activation: `TEDIX_EXTERNAL_AGENT=${started.profile.key}`,
			};
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else {
				console.log(
					`Started external Agent-Session ${started.session.externalSessionKey} for ${started.profile.key}.`,
				);
				// Surface the granted scopes so the operator can see the privilege
				// level (least-privilege visibility). Pass --agent-scopes to change it.
				console.log(
					`  Granted scopes: ${started.profile.scopes.join(", ")}${options.agentScopes ? "" : " (default; override with --agent-scopes)"}`,
				);
				console.log(
					`  Activate it for subsequent calls: export TEDIX_EXTERNAL_AGENT=${started.profile.key}`,
				);
				console.log(
					"  Dedicated credential saved with mode 0600 (secret redacted).",
				);
			}
			return;
		}
		if (subcommand === "checkpoint") {
			const workItemId = agentArgs[0];
			if (!workItemId || !looksLikeUuid(workItemId)) {
				throw new Error(
					"Usage: tedix agent checkpoint <work-item-uuid> --note <summary> --idempotency-key <key> [--evidence <ref,ref>] [--artifact-ref <ref>]",
				);
			}
			if (!options.workNote?.trim() || !options.idempotencyKey?.trim()) {
				throw new Error(
					"agent checkpoint requires --note <summary> and --idempotency-key <key>.",
				);
			}
			const checkpoint = await checkpointExternalAgentKnowledge({
				workspace,
				workItemId,
				summary: options.workNote.trim(),
				idempotencyKey: options.idempotencyKey.trim(),
				evidenceRefs:
					options.workEvidence
						?.split(",")
						.map((value) => value.trim())
						.filter(Boolean) ?? [],
				artifactRef: options.agentArtifactRef,
			});
			if (options.json) console.log(JSON.stringify(checkpoint, null, 2));
			else
				console.log(
					`Recorded knowledge checkpoint for Work Item ${workItemId}.`,
				);
			return;
		}
		if (subcommand === "finish") {
			const workItemId = agentArgs[0];
			if (workItemId && !looksLikeUuid(workItemId)) {
				throw new Error("agent finish Work Item must be a UUID when provided.");
			}
			if (options.agentNoHandoffReason && options.agentZeroWorkReason) {
				throw new Error(
					"agent finish accepts either --no-handoff-reason or --zero-work-reason, not both.",
				);
			}
			if (options.agentNoHandoffReason && !workItemId) {
				throw new Error(
					"Explicit no-handoff finish requires a Work Item UUID.",
				);
			}
			if (options.agentZeroWorkReason && workItemId) {
				throw new Error(
					"Zero-work finish must not name a Work Item; use --no-handoff-reason for governed work.",
				);
			}
			const ended = await finishExternalAgentSession({
				workspace,
				workItemId,
				idempotencyKey: options.idempotencyKey,
				noHandoffReason: options.agentNoHandoffReason,
				zeroWorkReason: options.agentZeroWorkReason,
			});
			if (options.json)
				console.log(JSON.stringify({ finished: true, session: ended }));
			else
				console.log(
					`Finished external Agent-Session ${ended.externalSessionKey}; knowledge disposition is durable.`,
				);
			return;
		}
		if (subcommand === "rename") {
			const { auth, loginError } = await resolveStoredLoginAuth(workspace);
			const oauthTokens = await auth?.oauthProvider?.tokens();
			const bearer =
				auth?.headers.Authorization?.replace(/^Bearer /, "") ??
				oauthTokens?.access_token;
			if (!bearer) {
				throw new Error(
					loginError ??
						"agent rename requires a signed-in owner/admin workspace.",
				);
			}
			const renamed = await renameExternalAgentPrincipal({
				workspace,
				oauthBearer: bearer,
				displayName: options.agentDisplayName,
			});
			if (options.json) console.log(JSON.stringify(renamed, null, 2));
			else
				console.log(
					`Renamed external-agent principal ${renamed.key}: "${renamed.previous}" -> "${renamed.displayName}". The key is unchanged.`,
				);
			return;
		}
		if (subcommand === "reconcile") {
			const { auth, loginError } = await resolveStoredLoginAuth(workspace);
			const oauthTokens = await auth?.oauthProvider?.tokens();
			const bearer =
				auth?.headers.Authorization?.replace(/^Bearer /, "") ??
				oauthTokens?.access_token;
			if (!bearer) {
				throw new Error(
					loginError ??
						"agent reconcile requires a signed-in owner/admin workspace.",
				);
			}
			const staleBefore =
				options.agentStaleBefore ??
				new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
			const sessions = await listStaleExternalAgentKnowledgeSessions({
				workspace,
				oauthBearer: bearer,
				staleBefore,
				limit: options.limit,
			});
			if (options.json) console.log(JSON.stringify(sessions, null, 2));
			else if (sessions.length === 0) {
				console.log(
					`No unresolved stale Agent-Sessions before ${staleBefore}.`,
				);
			} else {
				console.log(
					`${sessions.length} unresolved stale Agent-Session(s) before ${staleBefore}:`,
				);
				for (const session of sessions) {
					console.log(
						`  ${String(session.externalSessionKey)}  last seen ${String(session.lastSeenAt)}`,
					);
				}
			}
			return;
		}
		throw new Error(
			`Unknown agent command "${subcommand}". Usage: tedix agent start|status|rename|checkpoint|finish|reconcile|end`,
		);
	}
	if (command === "workspaces" || command === "workspace") {
		const sub = options.prompt?.trim();
		if (command === "workspace" && sub && sub !== "list") {
			throw new Error(
				`Unknown workspace command "${sub}". Usage: tedix workspaces`,
			);
		}
		const list = listWorkspaces();
		if (options.json) {
			console.log(JSON.stringify(list, null, 2));
			return;
		}
		if (list.length === 0) {
			console.log(
				"No workspaces yet. Run `tedix login --workspace <name> --url <gateway-mcp-url>`.",
			);
			return;
		}
		for (const w of list) {
			const mark = w.current ? "*" : " ";
			const exp = w.accessTokenExpiresAtSeconds
				? new Date(w.accessTokenExpiresAtSeconds * 1000).toISOString()
				: "";
			console.log(
				`${mark} ${w.name}\t${w.mcpUrl ?? ""}\t${w.loginId || "(unknown)"}${exp ? `\t${exp}` : ""}`,
			);
		}
		return;
	}
	if (command === "use") {
		const name = options.prompt?.trim();
		if (!name) throw new Error("Usage: tedix use <workspace>");
		try {
			setCurrentWorkspace(name);
		} catch {
			const names = listWorkspaces().map((w) => w.name);
			throw new Error(
				`No stored workspace "${name}". Available: ${names.length ? names.join(", ") : "(none)"}. Log in with \`tedix login --workspace ${name} --url <gateway-mcp-url>\`.`,
			);
		}
		console.log(`Now using workspace "${name}".`);
		return;
	}
	if (command === "orgs") {
		// Any tenant gateway login can enumerate this user's own D1 memberships;
		// first-run users never need a platform-wide operator grant.
		const ws = options.workspace?.trim() || getCurrentWorkspace();
		if (!ws) {
			throw new Error(
				"A stored organization login is required. Run `tedix login` first.",
			);
		}
		const { auth } = await resolveStoredLoginAuth(ws);
		if (!auth) {
			throw new Error(
				`No stored login for workspace "${ws}". Run \`tedix login\` first.`,
			);
		}
		let available: AvailableWorkspace[];
		const stored = readWorkspaceCredentials(ws);
		const accountClient = new TedixHomeClient({
			headers: {
				...auth.headers,
				...resolveOrganizationTarget({
					url: stored?.mcpUrl ?? options.url,
					command: "code",
					organization: options.organization,
					workspace: ws,
					accessToken:
						(await auth.oauthProvider?.tokens())?.access_token ??
						auth.headers.Authorization?.replace(/^Bearer\s+/i, ""),
				}).headers,
			},
			oauthProvider: auth.oauthProvider,
			url: stored?.mcpUrl ?? options.url,
		});
		try {
			available = await listAvailableWorkspaces({ client: accountClient });
		} catch (error) {
			throw new Error(`Could not list your orgs: ${errorText(error)}`);
		} finally {
			await accountClient.close();
		}
		const claims = decodeJwtPayload(
			(await auth.oauthProvider?.tokens())?.access_token ??
				auth.headers.Authorization?.replace(/^Bearer\s+/i, "") ??
				"",
		);
		const selected = Array.isArray(claims?.tedixSelectedOrganizations)
			? claims.tedixSelectedOrganizations
			: [];
		const approved = (o: AvailableWorkspace) =>
			(!isMultiOrganizationMcpUrl(stored?.mcpUrl ?? options.url) &&
				claims?.dct === o.descopeTenantId) ||
			selected.includes(o.org) ||
			(o.descopeTenantId !== null && selected.includes(o.descopeTenantId));
		const loggedInAs = (o: AvailableWorkspace): string | null =>
			approved(o) ? ws : null;
		if (options.json) {
			console.log(
				JSON.stringify(
					available.map((o) => ({
						...o,
						approved: approved(o),
						loggedInAs: loggedInAs(o),
					})),
					null,
					2,
				),
			);
			return;
		}
		if (available.length === 0) {
			console.log("You are not a member of any organizations.");
			return;
		}
		console.log("Organizations you belong to:");
		for (const o of available) {
			const have = loggedInAs(o);
			if (have) {
				console.log(`  ✓ ${o.slug}\t${o.name} (approved in "${have}")`);
			} else if (o.gatewayUrl) {
				console.log(
					`    ${o.slug}\t${o.name} (not approved; run tedix login to review access)`,
				);
			} else {
				console.log(`    ${o.slug}\t${o.name} (no MCP gateway provisioned)`);
			}
		}
		return;
	}
	if (command === "logout") {
		if (options.all) {
			clearAllCredentials();
			console.log("Logged out of all workspaces — credentials cleared.");
			return;
		}
		const workspace = options.workspace?.trim() || getCurrentWorkspace();
		if (!workspace) {
			console.log("No stored login to clear.");
			return;
		}
		removeWorkspace(workspace);
		console.log(`Logged out of workspace "${workspace}".`);
		return;
	}
	if (command === "login") {
		const rawOrg = readOrgFlag(process.argv);
		// Tedix Cloud's own tenant key; an own-account installation never matches this branch.
		const tenant = rawOrg === "tedix" ? "org_tedix" : rawOrg;
		// Ordinary first-run login goes directly to the organization's own OAuth
		// resource. No platform-wide operator grant is required first.
		let orgSlugArg = options.prompt?.trim();
		const multiOrganizationLogin =
			!tenant &&
			!orgSlugArg &&
			(!options.urlExplicit || isMultiOrganizationMcpUrl(options.url));
		if (multiOrganizationLogin) {
			options.url = TEDIX_CONNECT_MCP_URL;
			options.urlExplicit = true;
			console.error(
				"Opening Tedix Connect to choose permissions and organizations…",
			);
		}
		let selectedOrganizations: Array<{ organization: string; tenant: string }> =
			[];
		let selectedScopes: string[] | undefined;
		let continueLoginInBrowser:
			| ((authorizationUrl: string) => void)
			| undefined;
		if (!tenant && !options.urlExplicit) {
			console.error(
				orgSlugArg
					? `Opening Tedix OS to authorize organization "${orgSlugArg}"…`
					: "Opening Tedix OS to choose an organization…",
			);
			const selection = await selectWorkspaceInBrowser({
				openBrowser,
				...(orgSlugArg ? { organization: orgSlugArg } : {}),
			});
			orgSlugArg = selection.organization;
			selectedOrganizations = selection.organizations;
			selectedScopes = selection.scopes;
			continueLoginInBrowser = selection.continueInBrowser;
		}
		const requestedWorkspace = options.workspace;
		const targets = selectedOrganizations.length
			? selectedOrganizations
			: [{ organization: orgSlugArg ?? "", tenant: tenant ?? "" }];
		for (const [index, target] of targets.entries()) {
			if (selectedOrganizations.length) {
				console.error(
					`Resolving the gateway for organization "${target.organization}"…`,
				);
				const match = await resolvePublicCliWorkspace({
					slug: target.organization,
				});
				options.url = match.gatewayUrl;
				options.urlExplicit = true;
				options.workspace = requestedWorkspace
					? index === 0
						? requestedWorkspace
						: `${requestedWorkspace}-${match.slug}`
					: match.slug;
			}
			const selectedTenant = target.tenant || undefined;
			const authorizationInExistingTab =
				index === 0 ? continueLoginInBrowser : undefined;
			const selectedProfile = multiOrganizationLogin
				? (options.oauthScopeProfile ?? "read")
				: selectedScopes
					? selectedScopes.includes("platform:admin")
						? "platform-admin"
						: selectedScopes.some((scope) => scope.endsWith(".admin"))
							? "admin"
							: selectedScopes.some(
										(scope) =>
											scope.endsWith(".write") ||
											scope === "connections.execute",
								  )
								? "member"
								: "read"
					: options.oauthScopeProfile;
			const isDefaultGateway =
				options.url === DEFAULT_TEDIX_MCP_URL ||
				options.url === LOCAL_TEDIX_MCP_URL;
			const tedixHosted = isTedixHostedMcpUrl(options.url);
			const expectedTenant = tenant ?? selectedTenant;
			if (!multiOrganizationLogin)
				requireExplicitTedixLoginTenant({
					isTedixHosted: tedixHosted,
					urlExplicit: Boolean(options.urlExplicit),
					expectedTenant,
				});
			// Provisional label for the OAuth/discovery step only. The FINAL slot name
			// is derived from the token below (`resolveLoginWorkspaceName`), so we
			// never persist a slot literally named "default": the tenant a bare login
			// resolves to isn't known until the operator finishes the Descope consent.
			const provisionalWorkspace =
				options.workspace?.trim() ||
				(!isDefaultGateway
					? workspaceNameFromGateway(options.url)
					: tenant
						? workspaceNameFromOrg(tenant)
						: DEFAULT_WORKSPACE);
			const provider = new WorkspaceOAuthProvider({
				loadStored: false,
				scopeProfile: selectedProfile,
				offerConsentChoices:
					multiOrganizationLogin &&
					!options.oauthScopeProfile &&
					!selectedScopes,
				...(selectedScopes ? { requestedScopes: selectedScopes } : {}),
				mcpUrl: options.url,
				workspace: provisionalWorkspace,
				...(expectedTenant ? { tenant: expectedTenant } : {}),
				...(authorizationInExistingTab
					? { openAuthorization: authorizationInExistingTab }
					: {}),
				...(tedixHosted
					? {
							staticClientId:
								process.env.TEDIX_OAUTH_CLIENT_ID ?? TEDIX_OAUTH_CLIENT_ID,
						}
					: {}),
			});
			console.error(
				authorizationInExistingTab
					? "Continuing authorization in the same browser tab…"
					: "Opening your browser to sign in to Tedix…",
			);
			let credential!: WorkspaceCredential;
			let tokenTenant: string | undefined;
			let workspace = provisionalWorkspace;
			try {
				await beginSdkOAuthLogin(provider, options.url, {
					commit: (validatedCredential) => {
						credential = validatedCredential;
						tokenTenant = credential.org;
						// Name the slot from the login's ACTUAL tenant (the token's `dct`), not
						// from a pre-consent guess. Every login lands in a slot named for its own
						// tenant, so two tenants can never collide in one "default" slot — the root
						// of the wrong-tenant-in-default footgun. Explicit --workspace still wins.
						workspace = resolveLoginWorkspaceName({
							explicit: options.workspace,
							gatewayUrl: options.url,
							isDefaultGateway,
							tokenTenant,
						});
						// Two different identities can derive the same name (e.g. every
						// `personal_*` org → "personal"). Warn before a blind upsert discards a
						// prior, different grant.
						const existing = readWorkspaceCredentials(workspace);
						if (
							existing &&
							tokenTenant &&
							existing.org &&
							existing.org !== tokenTenant
						) {
							console.error(
								`Warning: workspace "${workspace}" already holds a login for ${existing.org}; replacing it with ${tokenTenant}. Pass --workspace <name> to keep both.`,
							);
						}
						writeWorkspaceCredentials(workspace, {
							...credential,
							...(tokenTenant ? { org: tokenTenant } : {}),
						});
						setCurrentWorkspace(workspace);
					},
				});
			} catch (error) {
				if (targets.length > 1)
					console.error(
						`Authorization stopped at "${target.organization}". ${index} earlier ${index === 1 ? "organization was" : "organizations were"} saved; run \`tedix workspaces\` to inspect them.`,
					);
				throw error;
			}
			console.log(
				`Granted scopes: ${issuedOAuthScopes(credential)?.join(", ") ?? "(not reported by issuer)"}`,
			);
			if (multiOrganizationLogin) {
				const selected = decodeJwtPayload(
					credential.oauthTokens?.access_token ?? "",
				)?.tedixSelectedOrganizations;
				if (Array.isArray(selected))
					console.log(`Selected organizations: ${selected.join(", ")}`);
			}
			// When the tenant has no friendly slug (an auto-generated Descope key), the
			// derived name is the raw key — usable but ugly; nudge toward --workspace.
			const rawKeyName =
				!options.workspace?.trim() && workspace === tokenTenant;
			console.log(
				`Logged in${credential.loginId ? ` as ${credential.loginId}` : ""} to workspace "${workspace}" (${credential.mcpUrl ?? options.url}). Credentials saved.${
					rawKeyName
						? `\nTip: this org has no friendly slug, so the workspace is named after its tenant id. Pass \`--workspace <name>\` next time for a nicer label.`
						: ""
				}`,
			);
		}
		if (targets.length > 1)
			console.log(
				`Authorized ${targets.length} organizations. Use \`tedix workspaces\` to switch between them.`,
			);
		return;
	}
	const workspaceName = resolveWorkspaceName(options);
	const auth = await resolveAuth(options);

	// `who` runs AFTER the credential and BEFORE any workspace or gateway call.
	// Both halves are deliberate. It needs an account because the point of
	// shipping it is to meet the person running it — but it must never need an
	// organization, because a new account has none, and this is the only command
	// with something true to say before one exists. It calls no gateway: the
	// answer comes from the git history already on the caller's disk.
	if (command === "who" || command === "neighbours") {
		const hours = Number(options.whoHours);
		process.exitCode = await runWhoCommand({
			paths: (options.whoPaths ?? "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
			// A nonsense window must not silently widen to everything.
			hours: Number.isFinite(hours) && hours > 0 ? hours : 24,
			json: options.json ?? false,
		});
		return;
	}
	// Couple the MCP target to the credential source: only retarget the URL to
	// the selected workspace's gateway when we ACTUALLY authenticated with THAT
	// workspace's stored login. Explicit env tokens stay on their configured
	// target, so leaving the URL as-is
	// for them prevents sending a Tedix-Unified credential to a workspace gateway
	// (the grant belongs to its saved resource, so the CLI must keep them aligned).
	if (!options.urlExplicit && auth.mcpUrl) {
		options.url = auth.mcpUrl;
	} else if (
		!options.urlExplicit &&
		auth.source === `stored-login:${workspaceName}`
	) {
		const ws = readWorkspaceCredentials(workspaceName);
		if (ws?.mcpUrl) options.url = ws.mcpUrl;
	} else if (
		options.workspace?.trim() &&
		auth.source !== `stored-login:${workspaceName}` &&
		!auth.source.startsWith("external-agent:")
	) {
		// An explicit --workspace/TEDIX_WORKSPACE was requested but did not resolve
		// to that workspace's stored login (missing/expired grant, or an env
		// token took precedence). Surface the divergence.
		console.error(
			`Warning: workspace "${workspaceName}" has no active stored login; using ${auth.source} against ${options.url}. Run \`tedix login --workspace ${workspaceName} --url <gateway-mcp-url>\` to sign in.`,
		);
	}
	let client: TedixHomeClient | undefined;
	let cleanedUp = false;
	// Single teardown: close the shared connection and revoke an external-agent
	// session credential when applicable.
	const teardown = async (): Promise<void> => {
		if (cleanedUp) return;
		cleanedUp = true;
		await client?.close().catch(() => {});
		await auth.cleanup?.().catch((error) => {
			console.error(
				`Warning: failed to revoke external-agent MCP credential: ${errorText(error)}`,
			);
		});
	};
	const commandAbort = new AbortController();
	const onSignal = () => {
		commandAbort.abort(new DOMException("Command interrupted", "AbortError"));
		void teardown().finally(() => process.exit(130));
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		// External-agent auth has already checked the exact organization against
		// its pinned profile before choosing the direct tenant gateway.
		const organizationContext = auth.source.startsWith("external-agent:")
			? {
					headers: {},
					workspace: workspaceName,
					organization: options.organization,
				}
			: resolveOrganizationTarget({
					url: options.url,
					command,
					organization: options.organization,
					workspace: workspaceName,
					accessToken:
						(await auth.oauthProvider?.tokens())?.access_token ??
						auth.headers.Authorization?.replace(/^Bearer\s+/i, ""),
				});
		client = new TedixHomeClient({
			headers: { ...auth.headers, ...organizationContext.headers },
			oauthProvider: auth.oauthProvider,
			url: options.url,
		});
		options.organization = organizationContext.organization;
		if (options.thread || command === "threads") {
			const runtime = normalizeCodeResult(
				await client.runCode(
					"async () => ({organizationId: codemode.__runtime().organizationId})",
				),
			).value;
			if (
				!runtime ||
				typeof runtime !== "object" ||
				!("organizationId" in runtime) ||
				typeof runtime.organizationId !== "string" ||
				!looksLikeUuid(runtime.organizationId)
			)
				throw new Error(
					"Could not verify the organization for saved conversation names.",
				);
			const threadOptions = { organizationId: runtime.organizationId };
			if (command === "threads") {
				const threads = listThreads(threadOptions);
				if (options.json) console.log(JSON.stringify(threads, null, 2));
				else if (!threads.length)
					console.log(
						"No saved conversations in this organization. Use `tedix chat --thread <name>` to create one.",
					);
				else
					for (const t of threads)
						console.log(`  ${t.name}\t${t.conversationId}`);
				return;
			}
			const name = options.thread!.trim();
			if (!name) throw new Error("--thread needs a conversation name.");
			options.conversationId =
				resolveThread(name, threadOptions) ??
				`home:cli:thread:${crypto.randomUUID()}`;
			setThread(name, options.conversationId, threadOptions);
		}
		const color = resolveColorMode({
			json: options.json,
			noColor: options.noColor,
		});
		const ops = buildOps(client, options, color);
		const ctx = buildContext(client, ops, options, color);
		if (command === "status") {
			// Compact operator dashboard for the current conversation: in-flight
			// runs, pending approvals, recent delegations — one read instead of
			// stitching runs/messages/child-tree by hand.
			const [runSet, childTree] = await Promise.allSettled([
				client.readHomeRunSet({
					conversationId: options.conversationId,
					limit: options.limit ?? 20,
				}),
				client.readChildRunTree({ conversationId: options.conversationId }),
			]);
			const errors = [
				runSet.status === "rejected"
					? `Runs: ${errorText(runSet.reason)}`
					: null,
				childTree.status === "rejected"
					? `Delegations: ${errorText(childTree.reason)}`
					: null,
			].filter((v): v is string => v !== null);
			const report = buildStatusReport({
				conversationId: options.conversationId,
				runSet: runSet.status === "fulfilled" ? runSet.value : null,
				childTree:
					childTree.status === "fulfilled" ? childTree.value : undefined,
				errors,
			});
			if (errors.length) process.exitCode = 2;
			console.log(renderStatusReport(report, { json: options.json }));
			return;
		}
		if (command === "code") {
			// Direct Code Mode call against the selected workspace's gateway — the
			// gateway's single `code` tool reaches the org's full app surface in its
			// sandbox. Bypasses the kernel (no Home turn / rationale / audit), so it
			// is an explicit power-user escape hatch, gated only by gateway scopes.
			const source = readCodeSource(options);
			if (!source) {
				throw new Error(
					'Usage: tedix code "<js>"  e.g.  tedix code \'async () => await discover.search({ query: "firecrawl" })\'  (or pipe the snippet via stdin)',
				);
			}
			const normalized = normalizeCodeResult(
				await runDirectCode(
					client,
					source,
					options.codeDestructiveApprovalReason,
					{
						workspace: resolveWorkspaceName(options),
						organization: options.organization,
						...(options.urlExplicit ? { url: options.url } : {}),
					},
				),
			);
			console.log(
				formatCodeValue(codeOutputValue(normalized, !!options.codeMetadata), {
					json: options.json,
				}),
			);
			const { truncationHint } = normalized;
			if (truncationHint) console.error(`\n[tedix] ${truncationHint}`);
			return;
		}
		if (command === "flow") {
			// Ephemeral skill workflows — author a draft, run it, return only the
			// bounded result. Same gateway transport as `work`/`code`; the point is
			// that the workflow's steps never enter the caller's context window.
			process.exitCode = await runFlowCommand(options.prompt?.trim() ?? "", {
				client,
				color,
				json: options.json,
				workspace: workspaceName,
				flow: {
					...(options.flowFile ? { file: options.flowFile } : {}),
					...(options.flowSkill ? { skill: options.flowSkill } : {}),
					...(options.flowWatch ? { watch: options.flowWatch } : {}),
					...(options.workAs ? { as: options.workAs } : {}),
					...(options.flowParam ? { param: options.flowParam } : {}),
					...(options.flowParams ? { params: options.flowParams } : {}),
					...(options.flowTitle ? { title: options.flowTitle } : {}),
					...(options.workReason ? { reason: options.workReason } : {}),
					...(options.limit ? { limit: options.limit } : {}),
				},
			});
			return;
		}
		if (command === "skill") {
			process.exitCode = await runSkillCommand(options.prompt?.trim() ?? "", {
				client,
				color,
				json: options.json,
				workspace: workspaceName,
				...(options.limit ? { limit: options.limit } : {}),
				flow: {
					...(options.flowWatch ? { watch: options.flowWatch } : {}),
					...(options.workAs ? { as: options.workAs } : {}),
					...(options.flowParam ? { param: options.flowParam } : {}),
					...(options.flowParams ? { params: options.flowParams } : {}),
					...(options.workReason ? { reason: options.workReason } : {}),
				},
			});
			return;
		}
		if (command === "workflow") {
			process.exitCode = await runWorkflowCommand(
				options.prompt?.trim() ?? "",
				{
					client,
					color,
					json: options.json,
					...(options.limit ? { limit: options.limit } : {}),
				},
			);
			return;
		}
		if (command === "work") {
			// Typed Work calls use the authenticated gateway's configured native
			// catalog. The selected organization headers are already attached.
			process.exitCode = await runWork(options.prompt?.trim() ?? "", {
				client,
				color,
				json: options.json,
				workspace: workspaceName,
				authSource: auth.source,
				mcpUrl: options.url,
				signal: commandAbort.signal,
				attemptStore: organizationScopedAttemptStore(
					createFileWorkAttemptStore(),
					organizationContext.workspace,
				),
				work: {
					...(options.flowWatch !== undefined
						? { watch: options.flowWatch }
						: {}),
					...(options.workAs ? { as: options.workAs } : {}),
					...(options.workHost ? { host: options.workHost } : {}),
					...(options.workLaunch ? { launch: true } : {}),
					...(options.workRepoKey !== undefined
						? { repoKey: options.workRepoKey }
						: {}),
					...(options.workPaths !== undefined
						? { paths: options.workPaths }
						: {}),
					...(options.workProject ? { project: options.workProject } : {}),
					...(options.workDisposition
						? { disposition: options.workDisposition }
						: {}),
					...(options.workMine ? { mine: true } : {}),
					...(options.workReason ? { reason: options.workReason } : {}),
					...(options.workNote ? { note: options.workNote } : {}),
					...(options.workEvent ? { event: options.workEvent } : {}),
					...(options.workCampaign ? { campaign: options.workCampaign } : {}),
					...(options.workContentIds
						? { contentIds: options.workContentIds }
						: {}),
					...(options.workValidUntil
						? { validUntil: options.workValidUntil }
						: {}),
					...(options.workEvidence ? { evidence: options.workEvidence } : {}),
					...(options.workDoneWhen ? { doneWhen: options.workDoneWhen } : {}),
					...(options.workInput ? { input: options.workInput } : {}),
					...(options.workOutcome ? { outcome: options.workOutcome } : {}),
					...(options.workCommits?.length
						? { commit: options.workCommits }
						: {}),
					...(options.workClaimKey ? { claimKey: options.workClaimKey } : {}),
					...(options.workEvidenceKind
						? { evidenceKind: options.workEvidenceKind }
						: {}),
					...(options.workEvidenceMediaType
						? { evidenceMediaType: options.workEvidenceMediaType }
						: {}),
					...(options.workEvidenceLabel
						? { evidenceLabel: options.workEvidenceLabel }
						: {}),
					...(options.workEvidenceMetadata
						? { evidenceMetadata: options.workEvidenceMetadata }
						: {}),
					...(options.idempotencyKey
						? { idempotencyKey: options.idempotencyKey }
						: {}),
					...(options.workDesc ? { desc: options.workDesc } : {}),
					...(options.workKind ? { kind: options.workKind } : {}),
					...(options.workPriority ? { priority: options.workPriority } : {}),
					...(options.workObjective
						? { objective: options.workObjective }
						: {}),
					...(options.workClass ? { workClass: options.workClass } : {}),
					...(options.workExpires ? { expires: options.workExpires } : {}),
					...(options.workExecutorTedi
						? { executorTedi: options.workExecutorTedi }
						: {}),
					...(options.workWorktree ? { worktree: true } : {}),
					...(options.workWorktreeRoot
						? { worktreeRoot: options.workWorktreeRoot }
						: {}),
					...(options.workSession ? { session: options.workSession } : {}),
					...(options.workOperatorOverride ? { operatorOverride: true } : {}),
					...(options.workContradicts ? { contradicts: true } : {}),
					...(options.limit ? { limit: options.limit } : {}),
				},
			});
			return;
		}
		if (command === "tedi") {
			process.exitCode = await runTediCommand(
				options.prompt,
				ctx,
				options,
				auth,
			);
			return;
		}
		if (spec) {
			process.exitCode = await spec.handler(options.prompt?.trim() ?? "", ctx);
			return;
		}
		if (options.prompt) {
			// A slash-prefixed one-shot prompt is a command the caller expected to
			// execute, not prose to hand the kernel. Sending it verbatim delegates
			// the command text — plus any pasted terminal context — as a fresh
			// objective, which is how `tedix ask "/retry <id>"` minted a bogus work
			// item and stranded the real one. Resolve it or refuse; never send it.
			const slash = parseSlashPrompt(options.prompt);
			if (slash) {
				const slashSpec = findCommand(slash.name);
				if (slashSpec) {
					process.exitCode = await slashSpec.handler(slash.rest, ctx);
					return;
				}
				throw new Error(slashCommandError(slash.name));
			}
			process.exitCode = reportSendResult(await ops.send(options.prompt), ctx);
			return;
		}
		const { runInteractive } = await import("./interactive");
		await runInteractive(ctx, options.conversationId, options);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await teardown();
	}
}

if (import.meta.main) {
	// Parsing can fail before options exist; literal arguments cannot choose output.
	const argv = process.argv.slice(2);
	const separator = argv.indexOf("--");
	const flags = separator < 0 ? argv : argv.slice(0, separator);
	const jsonMode = flags.includes("--json") || flags.includes("--json=true");
	main().catch((error) => {
		const message = improveCliErrorMessage(error);
		if (jsonMode) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(message);
		}
		process.exit(1);
	});
}
