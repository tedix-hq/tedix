/**
 * Opt-in decision capture for Claude Code and Codex.
 *
 * `capture-stop` runs when an agent turn ends: it opens an Interaction addressed
 * to the signed-in user in the bound project inbox, carrying the turn's final
 * message. `capture-reply` runs when the user submits the next prompt: it
 * answers that Interaction with the reply, so the pair becomes one durable
 * decision record.
 *
 * Before the question is created, the redacted turn is triaged by
 * `agent.triage_agent_turn` (bounded, silent fallback) and the result travels in
 * the create payload as `metadata.triage`. While capture is enabled for the
 * chat, this hook also owns the Stop turn status (`applyTriagedStop`): urgent
 * turns notify, others do not, and `tedix hooks status` skips Stop.
 *
 * A "later" question also asks `agent.request_agent_reply_draft` for a
 * tedi-drafted reply. The server marks each draft `delivery: "review"` (shown
 * in Tedix OS for the user to accept or edit) or `"auto"` (reversible,
 * non-urgent and within the session's auto-reply budget). An auto draft is
 * handed to the waiting agent by `await-reply` (Claude Code) or `await-draft`
 * (Codex); the question itself stays open for the user, and the user's
 * eventual chat reply to it cites the draft as `draftOutcome: "auto-sent"`.
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
import { basename, join } from "node:path";
import { GetWorkInteractionResultSchema } from "@tedix/api-contract/schemas/work-interactions";
import { markdownLineToPlainText } from "@tedix/api-contract/utils/markdown-plain-text";
import {
	applyTriagedStop,
	asciiJson,
	harnessOf,
	type StatusDeps,
	type TriageResult,
} from "./agent-status";
import {
	CAPTURE_EVENT_LIMIT,
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
const EVENT_LIMIT = CAPTURE_EVENT_LIMIT;
const TRIAGE_TIMEOUT_MS = 4000;
const LABEL_TIMEOUT_MS = 3000;
const DRAFT_TIMEOUT_MS = 3000;
const DETAIL_TIMEOUT_MS = 3000;
export const TRIAGE_CALLABLE = "agent.triage_agent_turn";
export const LABEL_CALLABLE = "agent.label_agent_reply";
export const REQUEST_DRAFT_CALLABLE = "agent.request_agent_reply_draft";

/** Test seams: status side effects and gateway-call timeouts. */
export interface CaptureOptions {
	status?: Pick<StatusDeps, "spawn" | "platform" | "which" | "label" | "now">;
	triageTimeoutMs?: number;
	labelTimeoutMs?: number;
	draftTimeoutMs?: number;
	detailTimeoutMs?: number;
}

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
	/^\s*(?:<heartbeat|<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION|<local-command-|<command-name>|<bash-(?:input|stdout)>|<codex_internal_context|Tedix [^\n]{1,120}? replied for the user \(auto,)/;

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

export interface Binding extends JsonObject {
	command: string[];
	user: string;
}

export async function bindingFor(
	deps: HookDeps,
	session: string,
	onOptedIn?: () => void,
): Promise<Binding | undefined> {
	const binding = await deps.read(
		["setup", "agents", "context", "show", "--json", "--session", session],
		5000,
	);
	if (binding.status !== "bound" || binding.decisionCapture !== true)
		return undefined;
	// The same local opt-in `captureOwnsStop` reads, before any check that may fail.
	onOptedIn?.();
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

/**
 * One bounded Code Mode call through `tedix code`. The source, which carries
 * redacted turn text, goes over stdin, never into a process argument.
 */
async function gatewayCall(
	deps: HookDeps,
	binding: Binding,
	callable: string,
	input: JsonObject,
	timeoutMs: number,
	source = `async () => await ${callable}(${asciiJson(input)})`,
): Promise<JsonObject> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			deps.read([...binding.command, "code"], timeoutMs, source),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("gateway call timed out")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/** Validate and bound a triage result; anything unexpected is unavailable. */
export function triageOf(value: unknown, latencyMs: number): TriageResult {
	const unavailable: TriageResult = {
		status: "unavailable",
		urgency: "later",
		labels: {},
		urgentLabels: [],
		model: "",
		policyVersion: 0,
		latencyMs,
	};
	if (
		!isObject(value) ||
		value.status !== "ok" ||
		!["now", "later"].includes(value.urgency) ||
		!isObject(value.labels) ||
		!Array.isArray(value.urgentLabels) ||
		typeof value.model !== "string" ||
		!finite(value.policyVersion)
	)
		return unavailable;
	const labels = Object.entries(value.labels).filter(
		([key, score]) => key.length <= 100 && finite(score),
	);
	const urgentLabels = value.urgentLabels.filter(
		(label: unknown): label is string =>
			typeof label === "string" && label.length <= 100,
	);
	if (labels.length > 64 || urgentLabels.length > 64) return unavailable;
	return {
		status: "ok",
		urgency: value.urgency,
		labels: Object.fromEntries(labels),
		urgentLabels,
		model: value.model.slice(0, 200),
		policyVersion: value.policyVersion,
		latencyMs: finite(value.latencyMs) ? value.latencyMs : latencyMs,
	};
}

async function triageTurn(
	deps: HookDeps,
	binding: Binding,
	text: string,
	timeoutMs: number,
): Promise<TriageResult> {
	const started = Date.now();
	let value: unknown;
	try {
		value = await gatewayCall(
			deps,
			binding,
			TRIAGE_CALLABLE,
			{ text },
			timeoutMs,
		);
	} catch {
		// Not deployed, not granted, offline or slow: the regex classifier decides.
	}
	return triageOf(value, Date.now() - started);
}

/** The Clef label for a reply, or undefined on any failure. */
async function labelReply(
	deps: HookDeps,
	binding: Binding,
	turnText: string,
	replyText: string,
	timeoutMs: number,
): Promise<{ label: string; p: number } | undefined> {
	try {
		const value = await gatewayCall(
			deps,
			binding,
			LABEL_CALLABLE,
			{ turnText, replyText },
			timeoutMs,
		);
		if (
			value.status === "ok" &&
			typeof value.label === "string" &&
			value.label &&
			value.label.length <= 100 &&
			finite(value.p) &&
			value.p >= 0 &&
			value.p <= 1
		)
			return { label: value.label, p: value.p };
	} catch {
		// Silent: the regex reply class still travels.
	}
	return undefined;
}

/** The parts of an Interaction decision capture needs, projected locally. */
export interface InteractionDetail {
	requestId: string;
	version: number;
	state: "open" | "resolved" | "cancelled" | "expired";
	expiresAt: string | null;
	resolution: {
		body: string;
		complete: boolean;
		byType: string;
		byId: string;
		source: string | null;
		sessionId: string | null;
	} | null;
	/** The request's newest tedi draft and its current delivery policy. */
	draft: {
		id: string;
		body: string;
		complete: boolean;
		drafterId: string;
		drafterName: string | null;
		delivery: "review" | "auto" | null;
	} | null;
}

/** Project only validated native Interaction fields needed by these hooks. */
function nativeDetail(
	value: unknown,
	requestId: string,
): InteractionDetail | undefined {
	const parsed = GetWorkInteractionResultSchema.safeParse(value);
	if (!parsed.success || parsed.data.request.id !== requestId) return undefined;
	const r = parsed.data;
	const x = r.responses.data.find((e) => e.resolvesRequest) ?? null;
	const d = r.latestDraft ?? null;
	const bounded = (v: unknown, n: number) =>
		typeof v === "string" ? v.slice(0, n) : null;
	return detailOf(
		{
			requestId: r.request.id,
			version: r.request.version,
			state: r.effectiveState,
			expiresAt: r.request.expiresAt,
			resolution: x
				? {
						body: bounded(x.body, REPLY_LIMIT),
						complete: x.body.length <= REPLY_LIMIT,
						byType: bounded(x.respondedByType, 50),
						byId: bounded(x.respondedById, 300),
						source: bounded(x.metadata?.source, 100),
						sessionId: bounded(x.metadata?.sessionId, 100),
					}
				: null,
			draft: d
				? {
						id: bounded(d.id, 100),
						body: bounded(d.body, REPLY_LIMIT),
						complete: d.body.length <= REPLY_LIMIT,
						drafterId: bounded(d.drafterId, 300),
						drafterName: bounded(d.drafterName, 100),
						delivery: d.delivery,
					}
				: null,
		},
		requestId,
	);
}

/** Validate a projected detail; anything unexpected is undefined. */
function detailOf(
	value: unknown,
	requestId: string,
): InteractionDetail | undefined {
	if (
		!isObject(value) ||
		value.requestId !== requestId ||
		!Number.isInteger(value.version) ||
		!["open", "resolved", "cancelled", "expired"].includes(value.state)
	)
		return undefined;
	const resolved = value.resolution;
	const resolution =
		isObject(resolved) &&
		typeof resolved.body === "string" &&
		typeof resolved.byType === "string" &&
		typeof resolved.byId === "string"
			? {
					body: resolved.body,
					complete: resolved.complete === true,
					byType: resolved.byType,
					byId: resolved.byId,
					source: typeof resolved.source === "string" ? resolved.source : null,
					sessionId:
						typeof resolved.sessionId === "string" ? resolved.sessionId : null,
				}
			: null;
	const drafted = value.draft;
	const draft =
		isObject(drafted) &&
		typeof drafted.id === "string" &&
		UUID.test(drafted.id) &&
		typeof drafted.body === "string" &&
		drafted.body.trim() &&
		typeof drafted.drafterId === "string" &&
		drafted.drafterId
			? {
					id: drafted.id,
					body: drafted.body,
					complete: drafted.complete === true,
					drafterId: drafted.drafterId,
					drafterName:
						typeof drafted.drafterName === "string" && drafted.drafterName
							? drafted.drafterName
							: null,
					delivery:
						drafted.delivery === "auto" || drafted.delivery === "review"
							? (drafted.delivery as "auto" | "review")
							: null,
				}
			: null;
	return {
		requestId,
		version: value.version,
		state: value.state,
		expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
		resolution,
		draft,
	};
}

/** One bounded Interaction read, or undefined on any failure. */
export async function interactionDetail(
	deps: HookDeps,
	binding: Binding,
	requestId: string,
	timeoutMs: number,
): Promise<InteractionDetail | undefined> {
	try {
		if (!UUID.test(requestId)) return undefined;
		return nativeDetail(
			await deps.read(
				[
					...binding.command,
					"work",
					"interaction-get",
					requestId,
					"--input",
					JSON.stringify({ responseLimit: 5 }),
				],
				timeoutMs,
			),
			requestId,
		);
	} catch {
		return undefined;
	}
}

/**
 * True when the user answered in Tedix OS (or elsewhere) rather than through
 * this chat's own reply capture, so the answer is news to the session.
 */
export function answeredElsewhere(
	detail: InteractionDetail,
	user: string,
	session: string,
): boolean {
	const resolution = detail.resolution;
	return Boolean(
		detail.state === "resolved" &&
		resolution &&
		resolution.byType === "user" &&
		resolution.byId === user &&
		!(resolution.source === "user-reply" && resolution.sessionId === session),
	);
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
	/** The question's redacted message tail, for labelling the reply. */
	turnText?: string;
}

export function writeState(path: string, value: JsonObject): void {
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

/**
 * The chat's latest open question ({requestId, token, host}), kept beside the
 * claimable turn state so the prompt hook and the wake hook can find it
 * without claiming it.
 */
export function questionPath(state: string): string {
	return state.replace(/\.json$/, ".question.json");
}

/**
 * Whether this chat's newest question had a tedi draft queued:
 * {requestId, status: "queued" | "none"}. Codex's `await-draft` waits on it.
 */
export function draftStatusPath(state: string): string {
	return state.replace(/\.json$/, ".draft.json");
}

/**
 * The last question whose auto-delivered draft was handed to the agent, by ID
 * only: {requestId, draftId, count}. `count` is the consecutive auto
 * deliveries since the user last typed a reply; a typed reply clears it.
 */
export function autoDeliveryPath(state: string): string {
	return state.replace(/\.json$/, ".auto.json");
}

/** Read a small local JSON object without claiming it; undefined when absent or malformed. */
export function peek(path: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function onReply(
	deps: HookDeps,
	session: string,
	binding: Binding,
	prompt: string,
	previous: TurnState,
	options: CaptureOptions,
	autoSent?: JsonObject,
): Promise<void> {
	const requestId = String(previous.requestId);
	const timeout = options.detailTimeoutMs ?? DETAIL_TIMEOUT_MS;
	const detail = await interactionDetail(deps, binding, requestId, timeout);
	// Answered in Tedix OS, cancelled or expired: never answer it twice.
	if (detail && detail.state !== "open") return;
	// A reply typed in the chat answers as typed. It cites a draft only when
	// that draft was auto-delivered to this agent for this same question.
	const cited =
		autoSent?.requestId === requestId &&
		typeof autoSent.draftId === "string" &&
		UUID.test(autoSent.draftId)
			? { draftId: autoSent.draftId, draftOutcome: "auto-sent" }
			: {};
	const [text, complete] = redact(prompt, REPLY_LIMIT);
	const clef =
		typeof previous.turnText === "string" && previous.turnText
			? await labelReply(
					deps,
					binding,
					previous.turnText,
					text,
					options.labelTimeoutMs ?? LABEL_TIMEOUT_MS,
				)
			: undefined;
	try {
		await call(
			deps,
			binding,
			"interaction-respond",
			{
				expectedRequestVersion: detail?.version ?? previous.version,
				responseKind: "answer",
				body: text,
				resolvesRequest: true,
				metadata: {
					schema: SCHEMA,
					source: "user-reply",
					host: previous.host ?? harnessOf({}, deps.env),
					sessionId: session,
					replyClass: classify(prompt),
					...(clef ? { replyClassClef: clef } : {}),
					replyComplete: complete,
					...cited,
				},
			},
			requestId,
		);
	} catch (error) {
		// A conflict because it was answered meanwhile is settled, not retried.
		const after = await interactionDetail(deps, binding, requestId, timeout);
		if (after && after.state !== "open") return;
		throw error;
	}
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
	options: CaptureOptions,
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
	await onReply(deps, session, binding, reply.prompt, current, options);
}

async function onStop(
	deps: HookDeps,
	event: JsonObject,
	session: string,
	binding: Binding,
	state: string,
	options: CaptureOptions,
	settle: (triage: TriageResult) => Promise<void>,
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
			await onReply(deps, session, binding, kept.prompt, previous!, options);
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
	rmSync(questionPath(state), { force: true });
	rmSync(draftStatusPath(state), { force: true });
	writeState(state, { pending: token });
	const [text, complete] = redact(message, MESSAGE_LIMIT, "tail");
	// Triage only the redacted text, then settle the turn status before the
	// slower create so an urgent turn notifies without waiting on it.
	const triage = await triageTurn(
		deps,
		binding,
		text,
		options.triageTimeoutMs ?? TRIAGE_TIMEOUT_MS,
	);
	await settle(triage);
	const cwd = typeof event.cwd === "string" ? event.cwd : deps.cwd;
	const repository = basename(String(binding.root)).slice(0, 80);
	const firstLine =
		message
			.trim()
			.split(/\r\n|\r|\n/)
			.map(markdownLineToPlainText)
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
			triage,
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
		turnText: text,
	});
	writeState(questionPath(state), { requestId: request.id, token, host });
	await answerEarlyReply(deps, session, binding, state, options);
	// Only a question still waiting on the user gets a tedi-drafted reply.
	const queued =
		triage.urgency === "later" &&
		peek(state)?.requestId === request.id &&
		(await requestDraft(deps, binding, request.id, options));
	writeState(draftStatusPath(state), {
		requestId: request.id,
		status: queued ? "queued" : "none",
	});
}

/**
 * Ask a tedi to draft a reply; true when one was queued. The server decides
 * whether the draft is reviewed in Tedix OS or auto-delivered to the agent.
 * Not deployed, ineligible or slow: nothing happens.
 */
async function requestDraft(
	deps: HookDeps,
	binding: Binding,
	requestId: string,
	options: CaptureOptions,
): Promise<boolean> {
	try {
		const result = await gatewayCall(
			deps,
			binding,
			REQUEST_DRAFT_CALLABLE,
			{ requestId },
			options.draftTimeoutMs ?? DRAFT_TIMEOUT_MS,
		);
		return result.status === "queued";
	} catch {
		// Silent: the question stands without a draft.
		return false;
	}
}

/** True for a prompt the user typed, not a host re-entry or a Tedix auto reply. */
function typedPrompt(prompt: unknown): prompt is string {
	return (
		typeof prompt === "string" && !!prompt.trim() && !SYSTEM_PROMPT.test(prompt)
	);
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
	if (!typedPrompt(prompt)) return undefined;
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
	options: CaptureOptions = {},
): Promise<void> {
	// The status report keeps the host's own environment, as `tedix hooks status` does.
	const hostEnv = { ...deps.env };
	// Interactions are addressed to the signed-in user, who alone may answer them.
	// An exported external-agent identity would create rows the user cannot resolve.
	for (const key of AGENT_IDENTITY_ENV) delete deps.env[key];
	let owned: JsonObject | undefined;
	let settled = false;
	const settle = async (triage?: TriageResult): Promise<void> => {
		if (!owned || settled) return;
		settled = true;
		try {
			await applyTriagedStop(
				{ env: hostEnv, stdin: deps.stdin, cwd: deps.cwd, ...options.status },
				owned,
				triage,
			);
		} catch {
			// Status is best effort, like the status hook.
		}
	};
	try {
		const { event, session } = hostEvent(deps.stdin, deps.env, EVENT_LIMIT, {
			requireIdentity: true,
		});
		const id = session!;
		const state = captureStatePath(deps.env, id);
		// A typed reply ends the run of consecutive auto replies.
		const autoSent =
			mode === "reply" && typedPrompt(event.prompt)
				? claim(autoDeliveryPath(state))
				: undefined;
		const claimed = mode === "reply" ? claimReply(event, state) : undefined;
		if (mode === "reply" && !claimed) return;
		const binding = await bindingFor(
			deps,
			id,
			mode === "stop"
				? () => {
						owned = event;
					}
				: undefined,
		);
		if (!binding) return;
		if (mode === "stop") {
			await onStop(deps, event, id, binding, state, options, settle);
		} else if (claimed === "early") {
			// The turn end may have finished creating the question meanwhile.
			await answerEarlyReply(deps, id, binding, state, options);
		} else {
			const [prompt, current] = claimed!;
			try {
				await onReply(deps, id, binding, prompt, current, options, autoSent);
			} catch (error) {
				// Keep the reply so the next turn end retries it.
				writeState(early(state), { token: current.token, prompt });
				writeState(state, current);
				if (autoSent) writeState(autoDeliveryPath(state), autoSent);
				throw error;
			}
		}
	} catch {
		// Capture is best effort and never surfaces in the session.
	} finally {
		// An owned Stop always gets exactly one status, from the regex classifier
		// when triage never ran (skipped turn, failed check or failed read).
		await settle();
	}
}
