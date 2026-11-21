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
import { fileGatewayCooldown } from "../gateway-cooldown";
import { harnessOf } from "./agent-status";
import { readCache, readRecallCache, writeCache } from "./context-cache";
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
		/** Never read the catalog live; recall from a fresh shared copy or not at all. */
		cacheOnly?: boolean;
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
	const principal = external
		? auth.externalAgent.principalId
		: auth.storedLogin?.loginId;
	if (!principal) throw new Error("Recall principal unavailable");
	const key = JSON.stringify([
		command,
		binding.mcpUrl,
		auth.wouldUse,
		principal,
		binding.org,
		binding.credentialOrganizationId,
		external ? auth.externalAgent.organizationId : undefined,
		options.expectedOrganizationId,
		harness,
		repo,
	]);
	const now = deps.now ?? (() => new Date());
	// A live read now would only queue behind the machine-wide gateway cooldown.
	const coolingDown =
		fileGatewayCooldown(
			deps.env.TEDIX_CONFIG_DIR
				? { configDir: deps.env.TEDIX_CONFIG_DIR }
				: undefined,
		).read(String(binding.mcpUrl)) > now().getTime();
	const catalog = await readRecallCache(
		deps.env,
		key,
		async () => {
			const result = GetAgentSessionLessonsResultSchema.parse(
				await deps.read(
					[
						...command,
						"code",
						`async () => await agent.get_agent_session_lessons(${codeModeLiteral({ harness, repo, catalog: true })})`,
					],
					5000,
				),
			);
			if (
				(binding.credentialOrganizationId &&
					result.organizationId !== binding.credentialOrganizationId) ||
				(options.expectedOrganizationId &&
					result.organizationId !== options.expectedOrganizationId)
			)
				throw new Error("Recall organization differs from dispatch");
			return result;
		},
		now,
		{ cacheOnly: options.cacheOnly || coolingDown },
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
/**
 * Shell commands that only look around (`ls`, `git status`, `grep … | head`).
 * They still get lessons from the shared catalog copy, but never cause a live
 * catalog read of their own.
 */
const LOOK_ONLY =
	/^(?:cd|ls|pwd|cat|head|tail|wc|grep|rg|echo|which|tree|stat|file|du|sort|uniq|cut|tr|jq|sed -n|git (?:status|log|diff|show|branch|rev-parse|ls-files|grep|blame))(?:\s|$)/;
export function lookOnlyCommand(command: string | undefined): boolean {
	if (!command?.trim() || /[`$<>]|\n/.test(command)) return false;
	return command
		.split(/\|\|?|&&|;/)
		.map((part) => part.trim())
		.every((part) => LOOK_ONLY.test(part));
}

/** PreToolUse is advisory: stdout contains context only; no permission decision. */
export async function runSituationalRecall(deps: HookDeps): Promise<void> {
	try {
		const { event, session } = hostEvent(deps.stdin, deps.env, 1_048_576);
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
		const now = deps.now ?? (() => new Date());
		// The same session repeating the same situation (a re-run test, a second
		// edit to one file) reuses its answer without any CLI or gateway read.
		const last = session
			? JSON.stringify([
					session,
					deps.cwd,
					[...new Set(paths)].sort(),
					command?.trim().replace(/\s+/g, " "),
				])
			: undefined;
		const previous = last
			? readCache(deps.env, "recall-last", `session:${session}`, now())
			: undefined;
		let context: string;
		if (last && previous && previous.value.situation === last)
			context = String(previous.value.context ?? "");
		else {
			context = await recallForSituation(
				deps,
				{ paths, command },
				{ cacheOnly: !paths.length && lookOnlyCommand(command) },
			);
			if (last)
				writeCache(
					deps.env,
					"recall-last",
					`session:${session}`,
					{ situation: last, context },
					now(),
				);
		}
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
