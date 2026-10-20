import { relative, isAbsolute } from "node:path";
import {
	LessonTriggersSchema,
	GetAgentSessionLessonsResultSchema,
} from "@tedix/api-contract/schemas/agent-session-lessons";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import {
	briefRepository,
	recallLessons,
	renderRecall,
	type RecallSituation,
} from "@tedix/context-core/situational-recall";
import { harnessOf } from "./agent-status";
import { hostEvent, insideRoot, PROFILE, type HookDeps } from "./hook-io";
import { repoSlug } from "./prompt-context";

/** No path, command or brief text leaves the local matcher. */
export async function recallForSituation(
	deps: HookDeps,
	situation: RecallSituation,
	options: {
		harness?: string;
		scope?: string[];
		expectedOrganizationId?: string;
	} = {},
): Promise<string> {
	const { event, session } = hostEvent(deps.stdin, deps.env, 1_048_576);
	const harness = options.harness ?? harnessOf(event, deps.env);
	const binding = await deps.read(
		[
			"setup",
			"agents",
			"context",
			"show",
			"--json",
			"--allow-default",
			...(session ? ["--session", session] : []),
		],
		2000,
		undefined,
		{ cwd: deps.cwd },
	);
	if (
		binding.status !== "bound" ||
		(binding.contextSessionId && binding.contextSessionId !== session)
	)
		throw new Error("Recall context unavailable");
	if (
		binding.contextSource !== "default" &&
		!insideRoot(binding.root, deps.cwd)
	)
		throw new Error("Recall context unavailable");
	if (!PROFILE.test(String(binding.workspace ?? "")))
		throw new Error("Recall context unavailable");
	if (
		deps.env.TEDIX_WORKSPACE &&
		deps.env.TEDIX_WORKSPACE !== binding.workspace
	)
		throw new Error("Recall context unavailable");
	const command = options.scope ?? [
		"-w",
		binding.workspace,
		...(binding.organization ? ["--organization", binding.organization] : []),
	];
	const selectedOrg = command[command.indexOf("--organization") + 1];
	if (
		command.includes("--organization") &&
		selectedOrg !== (binding.organization ?? binding.org)
	)
		throw new Error("Recall context unavailable");
	const auth = await deps.read([...command, "auth", "status", "--json"], 3000);
	if (auth.workspace !== binding.workspace || auth.mcpUrl !== binding.mcpUrl)
		throw new Error("Recall context unavailable");
	const external = String(auth.wouldUse ?? "").startsWith("external-agent:");
	if (external) {
		if (
			!auth.externalAgent?.configured ||
			auth.externalAgent.mcpUrl !== binding.mcpUrl ||
			!auth.externalAgent.organizationId
		)
			throw new Error("Recall context unavailable");
		if (
			binding.credentialOrganizationId &&
			binding.credentialOrganizationId !== auth.externalAgent.organizationId
		)
			throw new Error("Recall context unavailable");
	} else {
		if (auth.wouldUse !== "stored-login")
			throw new Error("Recall context unavailable");
		if (
			binding.organization &&
			!binding.scopeRoutingHint &&
			!auth.storedLogin?.accessToken?.selectedOrganizations?.includes(
				binding.organization,
			)
		)
			throw new Error("Recall context unavailable");
		if (!binding.organization && auth.storedLogin?.org !== binding.org)
			throw new Error("Recall context unavailable");
	}
	const repo =
		repoSlug(binding.origin) ?? briefRepository(situation.text ?? "");
	const catalog = await deps.read(
		[
			...command,
			"code",
			`async () => await agent.get_agent_session_lessons(${codeModeLiteral({ harness, repo, catalog: true })})`,
		],
		5000,
	);
	const parsed = GetAgentSessionLessonsResultSchema.parse(catalog);
	if (
		binding.credentialOrganizationId &&
		parsed.organizationId !== binding.credentialOrganizationId
	)
		throw new Error("Recall context unavailable");
	if (
		options.expectedOrganizationId &&
		parsed.organizationId !== options.expectedOrganizationId
	)
		throw new Error("Recall organization differs from dispatch");
	const paths = (situation.paths ?? [])
		.map((p) => (isAbsolute(p) ? relative(binding.root ?? deps.cwd, p) : p))
		.filter((p) => p !== ".." && !p.startsWith("../"));
	const lessons = recallLessons(
		parsed.lessons.map((l) => ({
			...l,
			triggers: LessonTriggersSchema.parse(l.triggers ?? {}),
		})),
		{ ...situation, paths, repo, organization: parsed.organizationId },
	);
	return renderRecall(lessons);
}
/** PreToolUse is advisory: stdout contains context only; no permission decision. */
export async function runSituationalRecall(deps: HookDeps): Promise<void> {
	try {
		const { event } = hostEvent(deps.stdin, deps.env, 1_048_576);
		const input = event.tool_input ?? {};
		const tool = String(event.tool_name ?? "");
		if (
			!/(?:^|__)(?:Edit|Write|Bash|apply_patch|exec_command|shell_command|shell)$/i.test(
				tool,
			)
		)
			return;
		const paths: string[] = [];
		if (typeof input.file_path === "string") paths.push(input.file_path);
		if (typeof input.path === "string") paths.push(input.path);
		const patch =
			typeof input.patch === "string"
				? input.patch
				: typeof input.input === "string"
					? input.input
					: typeof input.command === "string"
						? input.command
						: "";
		for (const match of patch.matchAll(
			/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm,
		))
			paths.push(match[1]!);
		const command =
			typeof input.command === "string"
				? input.command
				: typeof input.cmd === "string"
					? input.cmd
					: undefined;
		const context = await recallForSituation(deps, { paths, command });
		if (context)
			deps.write(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						additionalContext: context,
					},
				}),
			);
	} catch {
		/* A cache, network or parsing fault never blocks the action. */
	}
}
