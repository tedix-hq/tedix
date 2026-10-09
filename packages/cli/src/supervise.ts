/**
 * `tedix supervise`: a local loop that delivers a tedi auto reply to a Codex
 * session after its own Stop hook stopped waiting.
 *
 * `await-draft` holds a Codex turn for at most 5 minutes. A draft that lands
 * later reaches nobody, so the session sits idle while its owner is away.
 * Every 30 seconds this reads the decision-capture state each turn leaves in
 * `~/.tedix/decision-capture` and, for a Codex chat still waiting on a question
 * whose tedi draft the server marked `delivery: "auto"` (the same rule and
 * consecutive cap as the hooks), queues the framed draft with `codex queue`.
 * An open Codex window takes it at once, which its transcript confirms;
 * otherwise the queued copy is withdrawn and the session resumes headless with
 * `codex exec resume`, whose reported thread ID must match. The
 * delivery is recorded locally exactly as the hooks record it.
 *
 * It sends a tedi draft at most once per question. Claude Code keeps its own
 * `await-reply` wake; a draft that arrives after that wait expired is only
 * logged.
 *
 * It also drains the user's own Tedix OS answers that no hook delivered
 * (`work interaction-undelivered`) for sessions on this machine: a closed
 * Claude Code session is resumed headless with `claude -p --resume` in its
 * directory (never one open in a terminal: its hooks deliver there), a Codex
 * session gets the same queue-or-resume as a draft, and an answer still
 * undelivered after two hours is handed to the lead session (the one that
 * registers delegations) as a delegated Work Item carrying the question and
 * answer. Each delivery is recorded on the server; every skip is logged once
 * per answer. Activity goes to `~/.tedix/supervisor.log`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { pruneStatusFiles, statusEnded } from "./hooks/agent-status";
import {
	answersMessage,
	type PendingAnswer,
	questionOf,
	undeliveredAnswers,
} from "./hooks/answer-delivery";
import { AWAIT_DRAFT_MAX_MS } from "./hooks/await-draft";
import {
	AWAIT_MAX_MS,
	autoDeliverable,
	autoDraftMessage,
	deliverAutoDraft,
} from "./hooks/await-reply";
import {
	ackAnswers,
	autoDeliveryPath,
	type Binding,
	bindingFor,
	captureStatePath,
	type DeliveryVia,
	draftStatusPath,
	interactionDetail,
	peek,
	sessionPath,
} from "./hooks/decision-capture";
import {
	AGENT_IDENTITY_ENV,
	cliRead,
	isoSeconds,
	type JsonObject,
	type ReadJson,
	selfCommand,
	UUID,
} from "./hooks/hook-io";

export const SUPERVISE_INTERVAL_MS = 30_000;
/** After `await-draft` gave up, with a minute of grace for its last read. */
export const CODEX_IDLE_MS = AWAIT_DRAFT_MAX_MS + 60_000;
/** Questions expire after a day; nothing older is worth a read. */
const QUESTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long an open Codex window gets to take the queued message. */
export const QUEUE_PICKUP_MS = 45_000;
const QUEUE_POLL_MS = 3000;
const RESUME_CONFIRM_MS = 60_000;
const DETAIL_TIMEOUT_MS = 15_000;
/** Recheck a question without a deliverable draft at most this often. */
const RECHECK_MAX_MS = 10 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const LOG_LIMIT = 1024 * 1024;
export const LAUNCH_AGENT_LABEL = "dev.tedix.supervisor";

/** The Codex operations the supervisor needs; tests replace them with fakes. */
export interface CodexDriver {
	/**
	 * Queue a message for a thread: the queued item ID and the transcript size
	 * before it, or undefined on failure.
	 */
	queue(
		thread: string,
		message: string,
	): Promise<{ id: string; offset: number } | undefined>;
	/** True once the thread's transcript after `offset` holds the message. */
	received(thread: string, message: string, offset: number): boolean;
	/** Remove a still-waiting queued item; true only when this call removed it. */
	withdraw(item: string): boolean;
	/** Resume the thread headless with the message; true once the thread ID is confirmed. */
	resume(thread: string, message: string, cwd: string): Promise<boolean>;
}

/** An answer no client delivered within this long goes to the lead session. */
export const HANDOFF_AFTER_MS = 2 * 60 * 60 * 1000;
/** How long an open Claude Code session's own hooks get before it is logged. */
export const OPEN_SESSION_GRACE_MS = 15 * 60 * 1000;
/** A failed delivery is retried after this long. */
const DELIVERY_RETRY_MS = 10 * 60 * 1000;
const BINDING_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TIMEOUT_MS = 90_000;

/** The Claude Code operations the supervisor needs; tests replace them with fakes. */
export interface ClaudeDriver {
	/**
	 * True when a Claude Code process has this session open (a terminal
	 * window), false when none does, undefined when it cannot tell.
	 */
	open(session: string): boolean | undefined;
	/**
	 * Resume the session headless with the message in `cwd`. `started` is true
	 * once Claude reports this same session ID; `done` settles with whether the
	 * turn finished successfully.
	 */
	resume(
		session: string,
		message: string,
		cwd: string,
	): Promise<{ started: boolean; done: Promise<boolean> }>;
	/** The session's name ("LEARN") while it runs, if Claude Code knows one. */
	name(session: string): string | undefined;
}

export interface SuperviseDeps {
	env: NodeJS.ProcessEnv;
	read: ReadJson;
	codex: CodexDriver;
	/** Defaults to the real `claude` CLI and its session registry. */
	claude?: ClaudeDriver;
	/** The lead session's id; defaults to `leadSession`. */
	lead?: () => string | undefined;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function configDir(env: NodeJS.ProcessEnv): string {
	return env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
}

export function supervisorLog(env: NodeJS.ProcessEnv, line: string): void {
	try {
		const directory = configDir(env);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, "supervisor.log");
		if (existsSync(path) && statSync(path).size > LOG_LIMIT)
			renameSync(path, `${path}.1`);
		appendFileSync(path, `${isoSeconds(new Date(), true)} ${line}\n`, {
			mode: 0o600,
		});
	} catch {
		// Logging is best effort.
	}
}

interface Candidate {
	session: string;
	host: string;
	requestId: string;
	token: string;
	state: string;
	ageMs: number;
	cwd: string;
}

/** Chats whose newest question still waits and had a tedi draft queued. */
export function waitingQuestions(
	env: NodeJS.ProcessEnv,
	now: number,
): Candidate[] {
	const directory = join(configDir(env), "decision-capture");
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	const found: Candidate[] = [];
	for (const name of names) {
		const session = name.endsWith(".question.json")
			? name.slice(0, -".question.json".length)
			: "";
		if (!UUID.test(session)) continue;
		const state = captureStatePath(env, session);
		const questionFile = join(directory, name);
		const question = peek(questionFile);
		const current = peek(state);
		const drafted = peek(draftStatusPath(state));
		if (
			!question ||
			typeof question.requestId !== "string" ||
			!UUID.test(question.requestId) ||
			typeof question.token !== "string" ||
			// A typed reply or a newer turn claimed the question.
			current?.token !== question.token ||
			current?.requestId !== question.requestId ||
			drafted?.requestId !== question.requestId ||
			drafted?.status !== "queued" ||
			// Already delivered once.
			peek(autoDeliveryPath(state))?.requestId === question.requestId
		)
			continue;
		let ageMs: number;
		try {
			ageMs = now - statSync(questionFile).mtimeMs;
		} catch {
			continue;
		}
		if (ageMs > QUESTION_MAX_AGE_MS) continue;
		const host = question.host === "codex" ? "codex" : "claude-code";
		const status = peek(
			join(configDir(env), "agent-status", `${host}-${session}.json`),
		);
		// The session is running again (typed reply not captured, or a tool call);
		// a status silent for 12 hours belongs to a session that ended.
		if (status?.state === "working" && !statusEnded(status, now)) continue;
		found.push({
			session,
			host,
			requestId: question.requestId,
			token: question.token,
			state,
			ageMs,
			cwd:
				typeof status?.cwd === "string" && status.cwd ? status.cwd : homedir(),
		});
	}
	return found;
}

export interface LocalSession {
	session: string;
	host: "claude-code" | "codex";
	cwd: string;
	/** Its agent-status record, when status reporting is on. */
	status: JsonObject | undefined;
}

/** Sessions that ended a captured turn on this machine in the last day. */
export function localSessions(
	env: NodeJS.ProcessEnv,
	now: number,
): LocalSession[] {
	const directory = join(configDir(env), "decision-capture");
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	const found: LocalSession[] = [];
	for (const name of names) {
		if (!name.endsWith(".session.json")) continue;
		const session = name.slice(0, -".session.json".length);
		if (!UUID.test(session)) continue;
		const path = sessionPath(captureStatePath(env, session));
		try {
			if (now - statSync(path).mtimeMs > QUESTION_MAX_AGE_MS) continue;
		} catch {
			continue;
		}
		const record = peek(path);
		const host = record?.host === "codex" ? "codex" : "claude-code";
		found.push({
			session,
			host,
			cwd:
				typeof record?.cwd === "string" && record.cwd ? record.cwd : homedir(),
			status: peek(
				join(configDir(env), "agent-status", `${host}-${session}.json`),
			),
		});
	}
	return found;
}

export type AnswerAction =
	| { kind: "handoff" }
	| { kind: "claude-resume" }
	| { kind: "codex" }
	| { kind: "wait"; reason: string };

/**
 * What to do with a session's undelivered answers: hand the overdue ones to
 * the lead session, resume a closed Claude Code session, queue or resume a
 * Codex one, or wait for the session's own hooks.
 */
export function answerAction(input: {
	host: "claude-code" | "codex";
	ageMs: number;
	/** Claude Code only: whether a process has the session open. */
	open: boolean | undefined;
	/** Its status says it is running a turn right now. */
	working: boolean;
}): AnswerAction {
	if (input.ageMs >= HANDOFF_AFTER_MS) return { kind: "handoff" };
	if (input.host === "codex")
		return input.working
			? {
					kind: "wait",
					reason:
						"the Codex session is running a turn; its Stop hook delivers it",
				}
			: { kind: "codex" };
	if (input.open === undefined)
		return {
			kind: "wait",
			reason:
				"cannot tell whether the Claude Code session is open, so it is never resumed; left for the hand-off at 2 hours",
		};
	if (!input.open) return { kind: "claude-resume" };
	return {
		kind: "wait",
		reason:
			input.ageMs >= OPEN_SESSION_GRACE_MS
				? "the Claude Code session is open in a terminal but its hooks have not delivered it after 15 minutes; left for the hand-off at 2 hours"
				: "the Claude Code session is open in a terminal; its hooks deliver it",
	};
}

/**
 * The lead session: the one that most recently registered a delegation on
 * this machine (`~/.tedix/delegations/<session>.json`), so its prompt context
 * names every hand-off until it is settled.
 */
export function leadSession(env: NodeJS.ProcessEnv): string | undefined {
	const directory = join(configDir(env), "delegations");
	let best: { session: string; at: number } | undefined;
	try {
		for (const name of readdirSync(directory)) {
			const session = name.replace(/\.json$/, "");
			if (!name.endsWith(".json") || !UUID.test(session)) continue;
			const at = statSync(join(directory, name)).mtimeMs;
			if (!best || at > best.at) best = { session, at };
		}
	} catch {
		return undefined;
	}
	return best?.session;
}

/** One pass with per-question backoff; `supervise --once` runs a fresh one. */
export class Supervisor {
	private readonly recheck = new Map<string, { at: number; delay: number }>();
	private readonly logged = new Set<string>();
	private prunedAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly deps: SuperviseDeps) {}

	private log(line: string): void {
		(this.deps.log ?? ((l) => supervisorLog(this.deps.env, l)))(line);
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	/** Questions read and failed reads in the last pass. */
	lastPass = { checked: 0, failed: 0 };

	/** Returns the number of drafts delivered in this pass. */
	async tick(): Promise<number> {
		let delivered = 0;
		this.lastPass = { checked: 0, failed: 0 };
		const now = this.now();
		if (now - this.prunedAt >= PRUNE_EVERY_MS) {
			this.prunedAt = now;
			pruneStatusFiles(this.deps.env, now);
		}
		for (const candidate of waitingQuestions(this.deps.env, now)) {
			const due =
				candidate.host === "codex"
					? candidate.ageMs >= CODEX_IDLE_MS
					: candidate.ageMs >= AWAIT_MAX_MS;
			if (!due || this.logged.has(candidate.requestId)) continue;
			const backoff = this.recheck.get(candidate.requestId);
			if (backoff && backoff.at > now) continue;
			let sent = false;
			// The chat's context resolves from its own checkout, as in its hooks.
			const home = process.cwd();
			this.lastPass.checked++;
			try {
				if (existsSync(candidate.cwd)) process.chdir(candidate.cwd);
				sent = await this.consider(candidate);
			} catch (error) {
				this.lastPass.failed++;
				if (!backoff)
					this.log(
						`${candidate.host} ${candidate.session}: check failed: ${(error as Error).message?.slice(0, 200)}`,
					);
			} finally {
				process.chdir(home);
			}
			if (sent) delivered++;
			else {
				const delay = Math.min(
					(backoff?.delay ?? SUPERVISE_INTERVAL_MS / 2) * 2,
					RECHECK_MAX_MS,
				);
				this.recheck.set(candidate.requestId, { at: now + delay, delay });
			}
		}
		try {
			delivered += await this.drainAnswers(now);
		} catch (error) {
			this.log(
				`answer delivery failed: ${(error as Error).message?.slice(0, 200)}`,
			);
		}
		return delivered;
	}

	private async consider(candidate: Candidate): Promise<boolean> {
		const env = this.deps.env;
		const hookDeps = {
			env,
			stdin: "",
			cwd: candidate.cwd,
			read: this.deps.read,
			write: () => {},
		};
		const binding = await bindingFor(hookDeps, candidate.session);
		if (!binding) return false;
		const detail = await interactionDetail(
			hookDeps,
			binding,
			candidate.requestId,
			DETAIL_TIMEOUT_MS,
		);
		if (!detail) return false;
		if (detail.state !== "open") {
			this.logged.add(candidate.requestId);
			return false;
		}
		if (detail.expiresAt && Date.parse(detail.expiresAt) <= Date.now())
			return false;
		if (!autoDeliverable(detail, candidate.state)) return false;
		this.logged.add(candidate.requestId);
		if (candidate.host !== "codex") {
			this.log(
				`claude-code ${candidate.session}: auto draft ${detail.draft.id} for question ${candidate.requestId} arrived after await-reply stopped waiting; not delivered (Claude Code delivery is not supported yet)`,
			);
			return false;
		}
		const current = peek(candidate.state);
		if (current?.token !== candidate.token) return false;
		const message = autoDraftMessage(detail.draft);
		// Record before confirming, so a crash can never deliver it twice.
		const event = {
			hook_event_name: "Stop",
			session_id: candidate.session,
			turn_id: "tedix-supervisor",
			cwd: candidate.cwd,
		};
		const outcome = await this.toCodex(
			candidate.session,
			message,
			candidate.cwd,
			() =>
				deliverAutoDraft(
					{ ...env },
					{ ...hookDeps, stdin: JSON.stringify(event) },
					event,
					candidate.state,
					{ requestId: candidate.requestId },
					detail.draft,
				),
		);
		const what = `draft ${detail.draft.id}`;
		this.log(
			outcome === "codex_queue"
				? `codex ${candidate.session}: delivered ${what} for question ${candidate.requestId} to the open session`
				: outcome === "codex_resume"
					? `codex ${candidate.session}: no open window; resumed headless with ${what} for question ${candidate.requestId}`
					: outcome === "queue-failed"
						? `codex ${candidate.session}: codex queue failed; ${what} not delivered`
						: `codex ${candidate.session}: headless resume failed; ${what} not delivered`,
		);
		return outcome === "codex_queue" || outcome === "codex_resume";
	}

	/**
	 * Queue a message for a Codex thread; an open window takes it (its
	 * transcript confirms), else the queued copy is withdrawn and the thread
	 * resumes headless. `onQueued` runs once the queue accepted it.
	 */
	private async toCodex(
		session: string,
		message: string,
		cwd: string,
		onQueued?: () => void,
	): Promise<
		"codex_queue" | "codex_resume" | "queue-failed" | "resume-failed"
	> {
		const item = await this.deps.codex.queue(session, message);
		if (!item) return "queue-failed";
		onQueued?.();
		const sleep = this.deps.sleep ?? pause;
		const until = this.now() + QUEUE_PICKUP_MS;
		for (;;) {
			// Only the session transcript proves a window took it: Codex can drop a
			// queued item for a thread nobody has open without running it.
			if (this.deps.codex.received(session, message, item.offset))
				return "codex_queue";
			if (this.now() + QUEUE_POLL_MS > until) break;
			await sleep(QUEUE_POLL_MS);
		}
		// No window took it: take any queued copy back, then resume headless.
		this.deps.codex.withdraw(item.id);
		if (this.deps.codex.received(session, message, item.offset))
			return "codex_queue";
		return (await this.deps.codex.resume(session, message, cwd))
			? "codex_resume"
			: "resume-failed";
	}

	private readonly bindings = new Map<
		string,
		{ at: number; binding: Binding | undefined }
	>();
	/** The last reason logged per answer, so each is logged once. */
	private readonly noted = new Map<string, string>();
	private readonly retryAt = new Map<string, number>();
	/** Claude Code sessions with a headless resume still running. */
	private readonly resuming = new Set<string>();
	private claudeDefault: ClaudeDriver | undefined;

	private get claude(): ClaudeDriver {
		this.claudeDefault ??= this.deps.claude ?? claudeDriver(this.deps.env);
		return this.claudeDefault;
	}

	private note(answer: PendingAnswer, reason: string): void {
		if (this.noted.get(answer.responseId) === reason) return;
		this.noted.set(answer.responseId, reason);
		this.log(
			`answer ${answer.responseId} (question ${answer.requestId}, ${answer.host ?? "agent"} session ${answer.sessionId}): ${reason}`,
		);
	}

	/** Run in the session's checkout, where its context resolves, as in its hooks. */
	private async inCwd<T>(cwd: string, work: () => Promise<T>): Promise<T> {
		const home = process.cwd();
		try {
			if (existsSync(cwd)) process.chdir(cwd);
			return await work();
		} finally {
			process.chdir(home);
		}
	}

	private hookDeps(cwd: string) {
		return {
			env: this.deps.env,
			stdin: "",
			cwd,
			read: this.deps.read,
			write: () => {},
		};
	}

	private async bindingOf(
		local: LocalSession,
		now: number,
	): Promise<Binding | undefined> {
		const cached = this.bindings.get(local.session);
		if (cached && now - cached.at < BINDING_TTL_MS) return cached.binding;
		let binding: Binding | undefined;
		try {
			binding = await this.inCwd(local.cwd, () =>
				bindingFor(this.hookDeps(local.cwd), local.session),
			);
		} catch (error) {
			const reason = `${local.host} ${local.session}: no usable binding for answer delivery: ${(error as Error).message?.slice(0, 200)}`;
			if (this.noted.get(local.session) !== reason) {
				this.noted.set(local.session, reason);
				this.log(reason);
			}
		}
		this.bindings.set(local.session, { at: now, binding });
		return binding;
	}

	/**
	 * Deliver the user's undelivered answers for this machine's sessions.
	 * Returns the number of answers delivered or handed off in this pass.
	 */
	async drainAnswers(now: number): Promise<number> {
		const groups = new Map<
			string,
			{ binding: Binding; cwd: string; sessions: Map<string, LocalSession> }
		>();
		for (const local of localSessions(this.deps.env, now)) {
			const binding = await this.bindingOf(local, now);
			if (!binding) continue;
			const key = `${binding.command.join(" ")} ${binding.user}`;
			const group = groups.get(key) ?? {
				binding,
				cwd: local.cwd,
				sessions: new Map(),
			};
			group.sessions.set(local.session, local);
			groups.set(key, group);
		}
		let delivered = 0;
		for (const group of groups.values()) {
			const answers = await this.inCwd(group.cwd, () =>
				undeliveredAnswers(
					this.hookDeps(group.cwd),
					group.binding,
					{},
					DETAIL_TIMEOUT_MS,
				),
			);
			if (!answers) {
				const reason = `undelivered answers could not be read for ${group.binding.command.join(" ")}`;
				if (this.noted.get(reason) !== reason) {
					this.noted.set(reason, reason);
					this.log(reason);
				}
				continue;
			}
			const bySession = new Map<string, PendingAnswer[]>();
			for (const answer of answers) {
				const key = answer.sessionId.toLowerCase();
				bySession.set(key, [...(bySession.get(key) ?? []), answer]);
			}
			for (const [session, list] of bySession)
				delivered += await this.deliverSession(
					group.binding,
					group.cwd,
					group.sessions.get(session),
					list,
					now,
				);
		}
		return delivered;
	}

	private async deliverSession(
		binding: Binding,
		groupCwd: string,
		local: LocalSession | undefined,
		answers: PendingAnswer[],
		now: number,
	): Promise<number> {
		const ready = answers.filter(
			(answer) => (this.retryAt.get(answer.responseId) ?? 0) <= now,
		);
		for (const answer of answers)
			if (!ready.includes(answer))
				this.note(answer, "the last delivery failed; retrying later");
		const age = (answer: PendingAnswer) =>
			now - (Date.parse(answer.respondedAt) || now);
		const overdue = ready.filter((answer) => age(answer) >= HANDOFF_AFTER_MS);
		const fresh = ready.filter((answer) => age(answer) < HANDOFF_AFTER_MS);
		let delivered = 0;
		for (const answer of overdue)
			if (await this.handOff(binding, local?.cwd ?? groupCwd, answer))
				delivered++;
		if (!fresh.length) return delivered;
		if (!local) {
			for (const answer of fresh)
				this.note(
					answer,
					"its session is not on this machine; left for that machine's hooks or the hand-off at 2 hours",
				);
			return delivered;
		}
		const working =
			local.status?.state === "working" && !statusEnded(local.status, now);
		const action = answerAction({
			host: local.host,
			ageMs: Math.max(...fresh.map(age)),
			open:
				local.host === "claude-code"
					? this.claude.open(local.session)
					: undefined,
			working,
		});
		if (action.kind === "wait") {
			for (const answer of fresh) this.note(answer, action.reason);
			return delivered;
		}
		const ids = fresh.map((answer) => answer.responseId);
		const message = answersMessage(fresh);
		const record = (via: DeliveryVia, acknowledged = false) =>
			ackAnswers(this.deps, binding, ids, via, DETAIL_TIMEOUT_MS, {
				acknowledged,
			});
		const failed = (reason: string) => {
			for (const answer of fresh) {
				this.retryAt.set(answer.responseId, now + DELIVERY_RETRY_MS);
				this.note(answer, reason);
			}
			return delivered;
		};
		if (action.kind === "codex") {
			const outcome = await this.toCodex(local.session, message, local.cwd);
			if (outcome !== "codex_queue" && outcome !== "codex_resume")
				return failed(
					outcome === "queue-failed"
						? "codex queue failed; not delivered"
						: "headless codex resume failed; not delivered",
				);
			const acked = await record(outcome);
			for (const answer of fresh)
				this.note(
					answer,
					`delivered to the Codex session (${outcome === "codex_queue" ? "open window" : "headless resume"})${acked ? "" : "; recording it failed"}`,
				);
			return delivered + fresh.length;
		}
		if (action.kind === "handoff") {
			for (const answer of fresh)
				if (await this.handOff(binding, local.cwd, answer)) delivered++;
			return delivered;
		}
		if (this.resuming.has(local.session)) {
			for (const answer of fresh)
				this.note(answer, "a headless resume of this session is still running");
			return delivered;
		}
		const run = await this.claude.resume(local.session, message, local.cwd);
		if (!run.started)
			return failed(
				"claude -p --resume did not confirm this session; not delivered",
			);
		const acked = await record("supervisor_resume");
		for (const answer of fresh)
			this.note(
				answer,
				`delivered by resuming the closed Claude Code session headless${acked ? "" : "; recording it failed"}`,
			);
		this.resuming.add(local.session);
		void run.done.then(async (ok) => {
			this.resuming.delete(local.session);
			if (ok) await record("supervisor_resume", true);
			this.log(
				`claude-code ${local.session}: headless turn on ${ids.length} answer${ids.length === 1 ? "" : "s"} ${ok ? "finished (acknowledged)" : "failed"}`,
			);
		});
		return delivered + fresh.length;
	}

	/**
	 * Hand an answer no session took to the lead session: a delegated Work
	 * Item (its prompt context names it every turn until settled) with the
	 * question and the answer as a comment, then record the hand-off.
	 */
	private async handOff(
		binding: Binding,
		cwd: string,
		answer: PendingAnswer,
	): Promise<boolean> {
		const lead = this.deps.lead ? this.deps.lead() : leadSession(this.deps.env);
		if (!lead) {
			this.note(
				answer,
				"undelivered after 2 hours, but no lead session registered a delegation on this machine (tedix work delegate); left undelivered",
			);
			return false;
		}
		const question = questionOf(answer.subject);
		const host = answer.host === "codex" ? "codex" : "claude-code";
		const leadHost = existsSync(
			join(configDir(this.deps.env), "agent-status", `codex-${lead}.json`),
		)
			? "codex"
			: "claude-code";
		try {
			const created = await this.inCwd(cwd, () =>
				this.deps.read(
					[
						...binding.command,
						"work",
						"delegate",
						`Undelivered answer ${answer.requestId.slice(0, 8)}: ${question}`.slice(
							0,
							200,
						),
						"--done-when",
						"The user's answer is acted on, here or in the session that asked",
						"--via",
						"session",
						"--to",
						`${host} session ${answer.sessionId}`,
						"--session",
						`${leadHost}:${lead}`,
						...(answer.projectId ? ["--project", answer.projectId] : []),
						"--json",
					],
					HANDOFF_TIMEOUT_MS,
				),
			);
			const id = typeof created.id === "string" ? created.id : "";
			if (!UUID.test(id)) throw new Error("the board returned no Work Item id");
			await this.deps.read(
				[
					...binding.command,
					"work",
					"comment",
					id,
					[
						`The user answered in Tedix OS, but no session took it (${host} session ${answer.sessionId}, question ${answer.requestId}, answered ${answer.respondedAt}).`,
						`Question: ${JSON.stringify(question)}`,
						`The user's own answer (not a tedi draft): ${JSON.stringify(answer.body)}`,
						`Act on it here, or resume that session with it (${host === "codex" ? `codex resume ${answer.sessionId}` : `claude --resume ${answer.sessionId}`}).`,
					].join("\n"),
					"--json",
				],
				HANDOFF_TIMEOUT_MS,
			);
			const name = this.claude.name(lead) ?? "your lead session";
			const acked = await ackAnswers(
				this.deps,
				binding,
				[answer.responseId],
				"handoff",
				DETAIL_TIMEOUT_MS,
				{ handoffTo: name.slice(0, 80), handoffRef: id },
			);
			this.note(
				answer,
				`undelivered after 2 hours; handed to ${name} as Work Item ${id}${acked ? "" : "; recording it failed"}`,
			);
			return true;
		} catch (error) {
			this.retryAt.set(answer.responseId, this.now() + DELIVERY_RETRY_MS);
			this.note(
				answer,
				`hand-off failed: ${(error as Error).message?.slice(0, 200)}`,
			);
			return false;
		}
	}
}

/** Real Codex CLI and queue store. */
export function codexDriver(env: NodeJS.ProcessEnv): CodexDriver {
	const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
	const queueDb = join(codexHome, "queue_1.sqlite");
	const transcripts = new Map<string, string>();
	/** The thread's rollout under $CODEX_HOME/sessions/YYYY/MM/DD. */
	const transcript = (thread: string): string | undefined => {
		const known = transcripts.get(thread);
		if (known && existsSync(known)) return known;
		const root = join(codexHome, "sessions");
		try {
			for (const relative of readdirSync(root, { recursive: true }) as string[])
				if (relative.endsWith(`-${thread}.jsonl`)) {
					const path = join(root, relative);
					transcripts.set(thread, path);
					return path;
				}
		} catch {
			// No sessions directory.
		}
		return undefined;
	};
	const withDb = <T>(operation: (db: Database) => T): T | undefined => {
		if (!existsSync(queueDb)) return undefined;
		const db = new Database(queueDb);
		try {
			db.exec("PRAGMA busy_timeout = 3000");
			return operation(db);
		} catch {
			return undefined;
		} finally {
			db.close();
		}
	};
	return {
		async queue(thread, message) {
			const path = transcript(thread);
			if (!path) return undefined;
			const offset = statSync(path).size;
			const result = spawnSync(
				"codex",
				["queue", "--thread", thread, "--message", message],
				{
					encoding: "utf8",
					timeout: 60_000,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			if (result.status !== 0) return undefined;
			const match = /Queued message (\S+) for thread (\S+?)\.?\s*$/m.exec(
				result.stdout ?? "",
			);
			// A wrong thread must never receive the message.
			return match && match[2] === thread
				? { id: match[1]!, offset }
				: undefined;
		},
		received(thread, message, offset) {
			const path = transcript(thread);
			if (!path) return false;
			try {
				const fd = openSync(path, "r");
				try {
					const size = fstatSync(fd).size;
					const length = Math.min(size - offset, 8 * 1024 * 1024);
					if (length <= 0) return false;
					const buffer = Buffer.alloc(length);
					readSync(fd, buffer, 0, length, offset);
					// The transcript stores the text JSON-escaped, as JSON.stringify does.
					return buffer
						.toString("utf8")
						.includes(JSON.stringify(message).slice(1, 120));
				} finally {
					closeSync(fd);
				}
			} catch {
				return false;
			}
		},
		withdraw(item) {
			return (
				withDb(
					(db) =>
						db.query("DELETE FROM queued_items WHERE id = ?").run(item)
							.changes === 1,
				) ?? false
			);
		},
		async resume(thread, message, cwd) {
			const directory = join(configDir(env), "supervisor");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const output = join(directory, `resume-${thread}.jsonl`);
			const input = join(directory, `resume-${thread}.txt`);
			writeFileSync(input, message, { mode: 0o600 });
			writeFileSync(output, "", { mode: 0o600 });
			const stdio = [
				openSync(input, "r"),
				openSync(output, "a"),
				openSync(join(directory, "resume.err.log"), "a"),
			];
			const child = spawn(
				"codex",
				["exec", "--skip-git-repo-check", "--json", "resume", thread, "-"],
				{
					cwd: existsSync(cwd) ? cwd : homedir(),
					detached: true,
					stdio,
				},
			);
			child.unref();
			for (const fd of stdio) closeSync(fd);
			const deadline = Date.now() + RESUME_CONFIRM_MS;
			while (Date.now() < deadline) {
				const started = /"type":"thread\.started","thread_id":"([^"]+)"/.exec(
					readFileSync(output, "utf8"),
				);
				if (started) {
					if (started[1] === thread) return true;
					// `exec resume` with an unknown ID silently starts a new session.
					try {
						process.kill(-child.pid!, "SIGTERM");
					} catch {
						// Already gone.
					}
					return false;
				}
				if (child.exitCode !== null) return false;
				await pause(1000);
			}
			return false;
		},
	};
}

/**
 * Real Claude Code CLI. A running session is found in Claude Code's session
 * registry (`~/.claude/sessions/<pid>.json`, live pid) or in a process's
 * arguments (`claude --resume <id>`); without the registry a plain `claude`
 * cannot be told apart, so `open` is then undefined.
 */
export function claudeDriver(env: NodeJS.ProcessEnv): ClaudeDriver {
	const registry = join(
		env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
		"sessions",
	);
	const running = (session: string): JsonObject | undefined => {
		let names: string[];
		try {
			names = readdirSync(registry);
		} catch {
			return undefined;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const entry = peek(join(registry, name));
			if (
				typeof entry?.sessionId === "string" &&
				entry.sessionId.toLowerCase() === session &&
				Number.isInteger(entry.pid) &&
				alive(entry.pid)
			)
				return entry;
		}
		return undefined;
	};
	return {
		open(session) {
			if (running(session)) return true;
			const ps = spawnSync("ps", ["-axo", "command="], {
				encoding: "utf8",
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (ps.status !== 0) return undefined;
			if ((ps.stdout ?? "").toLowerCase().includes(session)) return true;
			return existsSync(registry) ? false : undefined;
		},
		name(session) {
			const entry = running(session);
			return entry?.nameSource !== "derived" &&
				typeof entry?.name === "string" &&
				entry.name.trim()
				? entry.name.trim()
				: undefined;
		},
		async resume(session, message, cwd) {
			const directory = join(configDir(env), "supervisor");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const output = join(directory, `claude-resume-${session}.jsonl`);
			const input = join(directory, `claude-resume-${session}.txt`);
			writeFileSync(input, message, { mode: 0o600 });
			writeFileSync(output, "", { mode: 0o600 });
			const stdio = [
				openSync(input, "r"),
				openSync(output, "a"),
				openSync(join(directory, "resume.err.log"), "a"),
			];
			// The documented headless resume; the message arrives on stdin.
			const child = spawn(
				"claude",
				[
					"-p",
					"--resume",
					session,
					"--output-format",
					"stream-json",
					"--verbose",
				],
				{
					cwd: existsSync(cwd) ? cwd : homedir(),
					detached: true,
					stdio,
					env: { ...env },
				},
			);
			child.unref();
			for (const fd of stdio) closeSync(fd);
			const done = new Promise<boolean>((resolve) => {
				child.once("exit", (code) => resolve(code === 0));
				child.once("error", () => resolve(false));
			});
			const stop = () => {
				try {
					process.kill(-child.pid!, "SIGTERM");
				} catch {
					// Already gone.
				}
			};
			const deadline = Date.now() + RESUME_CONFIRM_MS;
			while (Date.now() < deadline) {
				for (const line of readFileSync(output, "utf8").split("\n")) {
					let event: unknown;
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					const init = event as JsonObject;
					if (init?.type !== "system" || init.subtype !== "init") continue;
					if (init.session_id === session) return { started: true, done };
					// Never let a run continue in another session.
					stop();
					return { started: false, done };
				}
				if (child.exitCode !== null) return { started: false, done };
				await pause(1000);
			}
			stop();
			return { started: false, done };
		},
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** One supervisor per user: a PID file, taken over when its owner is gone. */
function acquireLock(env: NodeJS.ProcessEnv): (() => void) | undefined {
	const path = join(configDir(env), "supervisor.pid");
	mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
			return () => rmSync(path, { force: true });
		} catch {
			const owner = Number(readFileSync(path, "utf8"));
			if (Number.isInteger(owner) && owner > 0 && alive(owner))
				return undefined;
			rmSync(path, { force: true });
		}
	}
	return undefined;
}

export const superviseUsage = `Deliver late tedi auto replies and your undelivered Tedix OS answers to agent sessions (macOS and Linux)

  tedix supervise             Check every 30 seconds until stopped
  tedix supervise --once      Run one check and exit
  tedix supervise install     Run it at login as a user LaunchAgent (macOS)
  tedix supervise uninstall   Stop it and remove the LaunchAgent

A Codex session's await-draft hook waits 5 minutes for a tedi auto reply. When
one arrives later for a Codex chat still waiting on its question, the
supervisor queues it with codex queue (an open window acts on it) or, with no
window open, resumes the session headless with codex exec resume. It sends only
tedi drafts the server marked for automatic delivery, once per question and at
most three in a row, the same rules as the hooks. Claude Code sessions keep
their own await-reply wake; a draft that arrives after it stopped waiting is
only logged.

It also delivers your own Tedix OS answers that no hook delivered: a closed
Claude Code session is resumed headless with claude -p --resume in its
directory (a session open in a terminal never is; its hooks deliver there), a
Codex session gets codex queue or codex exec resume, and an answer still
undelivered after two hours becomes a delegated Work Item for your lead
session (the one that registered delegations with tedix work delegate).
Requires decision capture. Log: ~/.tedix/supervisor.log.`;

function launchAgentPath(): string {
	return join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${LAUNCH_AGENT_LABEL}.plist`,
	);
}

const xml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

export function launchAgentPlist(
	program: string[],
	env: NodeJS.ProcessEnv,
): string {
	const logPath = join(configDir(env), "supervisor.launchd.log");
	const variables: Record<string, string> = {
		PATH: env.PATH || "/usr/bin:/bin",
		...(env.TEDIX_CONFIG_DIR ? { TEDIX_CONFIG_DIR: env.TEDIX_CONFIG_DIR } : {}),
		...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
	};
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${program.map((arg) => `		<string>${xml(arg)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(variables)
	.map(
		([key, value]) =>
			`		<key>${xml(key)}</key>\n		<string>${xml(value)}</string>`,
	)
	.join("\n")}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>60</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export interface LaunchctlResult {
	status: number;
	output: string;
}
export type Launchctl = (args: string[]) => LaunchctlResult;

export function systemLaunchctl(bin = "launchctl"): Launchctl {
	return (args) => {
		const result = spawnSync(bin, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			status: result.status ?? 1,
			output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
		};
	};
}

/**
 * Loads the LaunchAgent at `path` into `domain`, replacing a loaded copy.
 * `bootout` returns before launchd finishes tearing the old job down, so an
 * immediate `bootstrap` fails on a reinstall; wait for the old job to leave,
 * retry the bootstrap, and let `launchctl print` decide the outcome. launchd
 * gives a job 20 seconds to exit before killing it, so the unload wait is
 * longer than that.
 * Returns an error message, or undefined once the job is loaded.
 */
export async function loadLaunchAgent(
	path: string,
	domain: string,
	run: Launchctl,
	{ attempts = 20, unloadAttempts = 120, sleep = pause, delayMs = 250 } = {},
): Promise<string | undefined> {
	const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
	const loaded = () => run(["print", service]).status === 0;
	// "Not loaded" is the fresh-install case, not an error.
	run(["bootout", service]);
	let waited = 0;
	while (loaded()) {
		if (++waited >= unloadAttempts)
			return `the existing ${service} did not unload; run launchctl bootout ${service} and retry.`;
		await sleep(delayMs);
	}
	let last: LaunchctlResult = { status: 1, output: "" };
	for (let attempt = 0; attempt < attempts; attempt++) {
		last = run(["bootstrap", domain, path]);
		if (last.status === 0 || loaded()) break;
		await sleep(delayMs);
	}
	if (loaded()) return undefined;
	return `launchctl bootstrap ${domain} failed (exit ${last.status}${last.output ? `: ${last.output}` : ""}).`;
}

async function install(env: NodeJS.ProcessEnv): Promise<number> {
	if (process.platform !== "darwin") {
		console.error(
			"tedix supervise install writes a macOS LaunchAgent; elsewhere run tedix supervise under your own service manager.",
		);
		return 1;
	}
	const [command, prefix] = selfCommand();
	const path = launchAgentPath();
	mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
	writeFileSync(
		path,
		launchAgentPlist([command, ...prefix, "supervise"], env),
		{
			mode: 0o644,
		},
	);
	const error = await loadLaunchAgent(
		path,
		`gui/${process.getuid!()}`,
		systemLaunchctl(),
	);
	if (error) {
		console.error(`Wrote ${path} but ${error}`);
		return 1;
	}
	console.log(
		`Installed ${path}; the supervisor runs now and at every login. Remove it with tedix supervise uninstall.`,
	);
	return 0;
}

function uninstall(): number {
	if (process.platform !== "darwin") return 0;
	systemLaunchctl()([
		"bootout",
		`gui/${process.getuid!()}/${LAUNCH_AGENT_LABEL}`,
	]);
	rmSync(launchAgentPath(), { force: true });
	console.log("Removed the Tedix supervisor LaunchAgent.");
	return 0;
}

export async function runSuperviseCommand(args: string[]): Promise<number> {
	const [first] = args;
	if (first === "--help" || first === "-h") {
		console.log(superviseUsage);
		return 0;
	}
	const env = { ...process.env };
	if (first === "install" && args.length === 1) return install(env);
	if (first === "uninstall" && args.length === 1) return uninstall();
	const once = first === "--once" && args.length === 1;
	if (args.length && !once) {
		console.error(
			`Unknown supervise arguments "${args.join(" ")}". Run tedix supervise --help.`,
		);
		return 1;
	}
	// Questions belong to the signed-in user, never an exported agent identity.
	for (const key of AGENT_IDENTITY_ENV) delete env[key];
	const release = acquireLock(env);
	if (!release) {
		console.error("Another tedix supervise is already running.");
		return once ? 0 : 1;
	}
	const supervisor = new Supervisor({
		env,
		read: cliRead,
		codex: codexDriver(env),
	});
	try {
		if (once) {
			const delivered = await supervisor.tick();
			const { checked, failed } = supervisor.lastPass;
			console.log(
				`Checked ${checked} waiting question${checked === 1 ? "" : "s"} (${failed} failed); ${delivered} draft${delivered === 1 ? "" : "s"} delivered. Log: ${join(configDir(env), "supervisor.log")}`,
			);
			return 0;
		}
		supervisorLog(env, `supervisor started (pid ${process.pid})`);
		let stopped = false;
		const stop = () => {
			stopped = true;
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		while (!stopped) {
			await supervisor.tick();
			for (
				let waited = 0;
				waited < SUPERVISE_INTERVAL_MS && !stopped;
				waited += 1000
			)
				await pause(1000);
		}
		supervisorLog(env, "supervisor stopped");
		return 0;
	} finally {
		release();
	}
}
