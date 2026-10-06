/**
 * Opt-in decision capture for Claude Code and Codex.
 *
 * `capture-stop` runs when an agent turn ends: it opens an Interaction addressed
 * to the signed-in user in the bound project inbox, carrying the turn's final
 * message. `capture-reply` runs when the user submits the next prompt: it
 * answers that Interaction with the reply, so the pair becomes one durable
 * decision record.
 *
 * Recording happens only after `tedix setup agents context
 * enable-decision-capture` for the bound organization. Text is redacted and
 * bounded before it leaves this machine and goes only to that organization.
 * Failures are silent: capture never blocks, delays or changes the session.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { harnessOf } from "./agent-status";
import { basename, join } from "node:path";
import {
	type HookDeps,
	type JsonObject,
	hostEvent,
	insideRoot,
	isObject,
	isoSeconds,
	PROFILE,
	UUID,
} from "./hook-io";

const SCHEMA = "tedix.decision-capture.v1";
const MESSAGE_LIMIT = 6000;
const REPLY_LIMIT = 6000;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const EVENT_LIMIT = 4_194_304;

/** Credentials an exported agent identity would use instead of the signed-in user. */
export const AGENT_IDENTITY_ENV = [
	"TEDIX_EXTERNAL_AGENT",
	"TEDIX_AGENT_SESSION",
	"TEDIX_MCP_BEARER_TOKEN",
	"TEDIX_MCP_API_KEY",
] as const;

const SECRETS: Array<[RegExp, string]> = [
	[
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		"[redacted private key]",
	],
	[
		/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
		"[redacted jwt]",
	],
	[/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted key]"],
	[/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted token]"],
	[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted key]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted token]"],
	[/\b(bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
	[
		/\b([A-Z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)[A-Z0-9_]*)\s*([=:])\s*["']?[^\s"']{6,}/gi,
		"$1$2[redacted]",
	],
];

/** Host re-entries that arrive through the prompt hook but were not typed by the user. */
const SYSTEM_PROMPT =
	/^\s*(?:<heartbeat|<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION|<local-command-|<command-name>|<bash-(?:input|stdout)>|<codex_internal_context)/;

/** Coarse first-pass labels mined from historic replies; the learning pass re-reads the full pair. */
const CLASSES: Array<[string, RegExp]> = [
	[
		"frustration",
		/\b(wtf|babysit|i told you|you keep|i have been repeating|still (?:not|broken|failing|wrong))\b/i,
	],
	[
		"correction",
		/^\s*(no[,.! ]|nope|wrong|incorrect|that'?s not|not what i)|\b(is wrong|instead of the real)\b/i,
	],
	[
		"challenge",
		/\b(are you sure|really\?|already done, right|why (?:are we|do we|did you|is that not)|are all .* shipped|doubt|not true)\b/i,
	],
	[
		"verify",
		/\b(recheck|verify|validate|prove|evidence|logs?|live (?:call|check|test)|in the browser|double.?check)\b/i,
	],
	[
		"plain-english",
		/\b(plain english|simple (?:terms|user stories)|user stor(?:y|ies)|explain (?:me|it|in))\b/i,
	],
	[
		"simplify",
		/\b(aggressive(?:ly)?|refactor|simplif|clean ?up|legacy|remove (?:dead|unused|it|this|legacy)|delete (?:it|this|dead)|leaner|less is more)\b/i,
	],
	[
		"fan-out",
		/\b(sub-?agents?|fan ?out|in parallel|parallel sessions|goal loop|set a (?:codex )?goal|sprint)\b/i,
	],
	["ship", /\b(commit|push|deploy|ship|release)\b/i],
	[
		"approve",
		/^\s*(make it happen|approved?|authori[sz]ed|confirmed|go ahead|ok,? lets? do it|do it|yes\b)/i,
	],
	[
		"status",
		/^\s*(status|what'?s next|whats next|how do we proceed|next priorit)/i,
	],
	[
		"continue",
		/^\s*(continue|proceed|keep going|carry on|go on|next|retry|ok(?:ay)?|yep|yeah|sure|\d+)\b/i,
	],
	["question", /\?\s*$/],
];

export function classify(reply: string): string {
	for (const [label, pattern] of CLASSES) if (pattern.test(reply)) return label;
	return "instruction";
}

export function redact(
	input: string,
	limit: number,
	keep: "head" | "tail" = "head",
): [string, boolean] {
	let text = input;
	for (const [pattern, replacement] of SECRETS)
		text = text.replace(pattern, replacement);
	text = text.trim();
	if (text.length <= limit) return [text, true];
	if (keep === "tail") return [`…${text.slice(-(limit - 1))}`, false];
	return [`${text.slice(0, limit - 1)}…`, false];
}

function stateDir(env: NodeJS.ProcessEnv): string {
	const path = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"decision-capture",
	);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

interface Binding extends JsonObject {
	command: string[];
	user: string;
}

async function bindingFor(
	deps: HookDeps,
	session: string,
): Promise<Binding | undefined> {
	const binding = await deps.read(
		["setup", "agents", "context", "show", "--json", "--session", session],
		5000,
	);
	if (binding.status !== "bound" || binding.decisionCapture !== true)
		return undefined;
	if (binding.contextSessionId && binding.contextSessionId !== session)
		throw new Error("resolved chat mismatch");
	if (
		!PROFILE.test(String(binding.workspace ?? "")) ||
		!UUID.test(String(binding.projectId ?? ""))
	)
		throw new Error("invalid profile or project");
	if (
		binding.workItemId !== undefined &&
		binding.workItemId !== null &&
		!UUID.test(String(binding.workItemId))
	)
		throw new Error("invalid Work identifier");
	if (!insideRoot(binding.root, deps.cwd)) throw new Error("wrong checkout");
	const command = ["-w", binding.workspace];
	if (binding.organization)
		command.push("--organization", binding.organization);
	const auth = await deps.read(
		["-w", binding.workspace, "auth", "status", "--json"],
		5000,
	);
	const login = isObject(auth.storedLogin) ? auth.storedLogin : {};
	if (auth.wouldUse !== "stored-login" || auth.mcpUrl !== binding.mcpUrl)
		throw new Error("decision capture requires the bound stored login");
	const selected = login.accessToken?.selectedOrganizations ?? [];
	if (
		binding.organization &&
		!(Array.isArray(selected) && selected.includes(binding.organization))
	)
		throw new Error("organization no longer selected");
	const user = login.loginId;
	if (typeof user !== "string" || !user || user.length > 300)
		throw new Error("missing signed-in user");
	return { ...binding, command, user };
}

async function call(
	deps: HookDeps,
	binding: Binding,
	verb: string,
	payload: JsonObject,
	pathId?: string,
): Promise<JsonObject> {
	const directory = mkdtempSync(join(stateDir(deps.env), "tedix-decision-"));
	const file = join(directory, "input.json");
	try {
		writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
		return await deps.read(
			[
				...binding.command,
				"work",
				verb,
				...(pathId ? [pathId] : []),
				"--input",
				`@${file}`,
				"--json",
			],
			15000,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function requestOf(result: JsonObject): { id: string; version: number } {
	const request = isObject(result.request) ? result.request : result;
	if (
		!UUID.test(String(request.id ?? "")) ||
		!Number.isInteger(request.version)
	)
		throw new Error("unexpected Interaction response");
	return request as { id: string; version: number };
}

function gitBranch(cwd: string): string {
	try {
		return execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		})
			.trim()
			.slice(0, 200);
	} catch {
		return "";
	}
}

interface TurnState extends JsonObject {
	requestId?: string;
	version?: number;
	token?: string;
	pending?: string;
	host?: string;
}

function writeState(path: string, value: JsonObject): void {
	const temporary = `${path}.${randomUUID().replaceAll("-", "")}.tmp`;
	writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	renameSync(temporary, path);
}

/** Atomic rename: exactly one hook process owns whatever the file held. */
export function claim(path: string): TurnState | undefined {
	const claimed = `${path.replace(/\.[^./]*$/, "")}.${randomUUID().replaceAll("-", "")}.claimed`;
	try {
		renameSync(path, claimed);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(readFileSync(claimed, "utf8"));
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(claimed, { force: true });
	}
}

function early(state: string): string {
	return state.replace(/\.json$/, ".early");
}

async function onReply(
	deps: HookDeps,
	session: string,
	binding: Binding,
	prompt: string,
	previous: TurnState,
): Promise<void> {
	const [text, complete] = redact(prompt, REPLY_LIMIT);
	await call(
		deps,
		binding,
		"interaction-respond",
		{
			expectedRequestVersion: previous.version,
			responseKind: "answer",
			body: text,
			resolvesRequest: true,
			metadata: {
				schema: SCHEMA,
				source: "user-reply",
				host: previous.host ?? harnessOf({}, deps.env),
				sessionId: session,
				replyClass: classify(prompt),
				replyComplete: complete,
			},
		},
		previous.requestId,
	);
}

/**
 * A reply that arrived while this turn's question was being created waits in
 * the early file. Whoever claims the finished question answers it, once.
 */
async function answerEarlyReply(
	deps: HookDeps,
	session: string,
	binding: Binding,
	state: string,
): Promise<void> {
	const stored = early(state);
	if (!existsSync(stored)) return;
	const current = claim(state);
	if (!current) return;
	const reply = claim(stored);
	if (!reply || reply.token !== current.token) {
		writeState(state, current);
		return;
	}
	await onReply(deps, session, binding, reply.prompt, current);
}

async function onStop(
	deps: HookDeps,
	event: JsonObject,
	session: string,
	binding: Binding,
	state: string,
): Promise<void> {
	const message = event.last_assistant_message;
	// Automated heartbeat turns are not decisions for the user.
	if (
		typeof message !== "string" ||
		!message.trim() ||
		/^\s*<heartbeat/.test(message)
	)
		return;
	// A pending background turn will resume on its own; it is not waiting on the user yet.
	const background = event.background_tasks;
	if (
		background &&
		!(Array.isArray(background) && !background.length) &&
		!(isObject(background) && !Object.keys(background).length)
	)
		return;
	// Codex hooks configured globally carry no Codex environment; its turn_id does.
	const host = harnessOf(event, deps.env);
	const previous = claim(state);
	const kept = previous?.requestId ? claim(early(state)) : undefined;
	if (kept && kept.token === previous!.token) {
		// A reply whose upload failed earlier: deliver it now instead of closing.
		try {
			await onReply(deps, session, binding, kept.prompt, previous!);
		} catch {
			// Best effort; the new turn still opens below.
		}
	}
	// An earlier turn the agent moved past without a reply is left to expire.
	// No close is possible from a hook: a question accepts only an answer, which
	// would put words in the user's name, and cancel needs interactive approval.
	// Mark the turn as waiting before any network call, so a reply typed while
	// the question is still being created is kept instead of lost.
	const token = randomUUID().replaceAll("-", "");
	rmSync(early(state), { force: true });
	writeState(state, { pending: token });
	const [text, complete] = redact(message, MESSAGE_LIMIT, "tail");
	const cwd = typeof event.cwd === "string" ? event.cwd : deps.cwd;
	const repository = basename(String(binding.root)).slice(0, 80);
	const firstLine =
		message
			.trim()
			.split(/\r\n|\r|\n/)
			.map((line) => line.replace(/^[ #*>-]+|[ #*>-]+$/g, ""))
			.find(Boolean) ?? "Agent turn ended";
	const [first] = redact(firstLine, 160);
	const now = (deps.now ?? (() => new Date()))();
	const payload: JsonObject = {
		kind: "question",
		subject: `${repository} · ${host} waiting: ${first}`.slice(0, 300),
		prompt: text,
		requestedFrom: { type: "user", id: binding.user },
		expiresAt: isoSeconds(new Date(now.getTime() + EXPIRY_MS), true),
		metadata: {
			schema: SCHEMA,
			source: "agent-turn-end",
			host,
			sessionId: session,
			turnId: String(event.turn_id || "").slice(0, 100) || null,
			repository,
			branch: (deps.branch ?? gitBranch)(cwd),
			messageComplete: complete,
		},
	};
	if (binding.workItemId) payload.workItemId = binding.workItemId;
	else payload.projectId = binding.projectId;
	const request = requestOf(
		await call(deps, binding, "interaction-create", payload),
	);
	writeState(state, {
		requestId: request.id,
		version: request.version,
		token,
		host,
	});
	await answerEarlyReply(deps, session, binding, state);
}

/**
 * Claim the open turn before any network call, so a fast next Stop cannot
 * close the request this reply is about to answer. Returns "early" when the
 * question is still being created and the reply was kept for the turn end.
 */
export function claimReply(
	event: JsonObject,
	state: string,
): "early" | [string, TurnState] | undefined {
	const prompt = event.prompt;
	if (
		typeof prompt !== "string" ||
		!prompt.trim() ||
		SYSTEM_PROMPT.test(prompt)
	)
		return undefined;
	const current = claim(state);
	if (!current) return undefined;
	if (current.pending) {
		writeState(early(state), { token: current.pending, prompt });
		return "early";
	}
	return [prompt, current];
}

/** The state file for one chat; exported so tests can drive a concurrent reply. */
export function captureStatePath(
	env: NodeJS.ProcessEnv,
	session: string,
): string {
	return join(stateDir(env), `${session}.json`);
}

export async function runDecisionCapture(
	mode: "stop" | "reply",
	deps: HookDeps,
): Promise<void> {
	// Interactions are addressed to the signed-in user, who alone may answer them.
	// An exported external-agent identity would create rows the user cannot resolve.
	for (const key of AGENT_IDENTITY_ENV) delete deps.env[key];
	try {
		const { event, session } = hostEvent(deps.stdin, deps.env, EVENT_LIMIT, {
			requireIdentity: true,
		});
		const id = session!;
		const state = captureStatePath(deps.env, id);
		const claimed = mode === "reply" ? claimReply(event, state) : undefined;
		if (mode === "reply" && !claimed) return;
		const binding = await bindingFor(deps, id);
		if (!binding) return;
		if (mode === "stop") {
			await onStop(deps, event, id, binding, state);
		} else if (claimed === "early") {
			// The turn end may have finished creating the question meanwhile.
			await answerEarlyReply(deps, id, binding, state);
		} else {
			const [prompt, current] = claimed!;
			try {
				await onReply(deps, id, binding, prompt, current);
			} catch (error) {
				// Keep the reply so the next turn end retries it.
				writeState(early(state), { token: current.token, prompt });
				writeState(state, current);
				throw error;
			}
		}
	} catch {
		// Capture is best effort and never surfaces in the session.
	}
}
