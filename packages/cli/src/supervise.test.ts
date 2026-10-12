import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoDraftMessage } from "./hooks/await-reply";
import {
	autoDeliveryPath,
	draftStatusPath,
	peek,
	questionPath,
} from "./hooks/decision-capture";
import type { JsonObject } from "./hooks/hook-io";
import {
	answerAction,
	type ClaudeDriver,
	CODEX_IDLE_MS,
	type CodexDriver,
	codexMessageReceived,
	launchAgentPlist,
	loadLaunchAgent,
	OPEN_SESSION_GRACE_MS,
	privacyProtected,
	Supervisor,
	systemLaunchctl,
} from "./supervise";

const SESSION = "01a11c83-81a9-7a32-9332-21edc1832f00";
const REQUEST = "99999999-9999-4999-8999-999999999999";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const BINDING = {
	status: "bound",
	workspace: "fixture",
	mcpUrl: "https://fixture.example.invalid/mcp",
	projectId: PROJECT,
	contextSource: "default",
	decisionCapture: true,
};
const AUTH = {
	wouldUse: "stored-login",
	mcpUrl: BINDING.mcpUrl,
	storedLogin: { loginId: "U-fixture-user" },
};
const DRAFT = {
	id: "abababab-abab-4bab-8bab-abababababab",
	body: "Yes, rerun the failing test.",
	rationale: "Fixture rationale",
	delivery: "auto",
	drafterId: "33333333-3333-4333-8333-333333333333",
	drafterName: "Builder",
	createdAt: "2026-10-06T00:00:00Z",
	turnType: "continue",
};
const interaction = (latestDraft: unknown, effectiveState = "open") => ({
	request: {
		id: REQUEST,
		orgId: "11111111-1111-4111-8111-111111111111",
		workItemId: null,
		caseId: null,
		projectId: PROJECT,
		kind: "question",
		subject: "Fixture decision",
		prompt: "Fixture question",
		requestedFromType: "user",
		requestedFromId: "U-fixture-user",
		creatorType: "user",
		creatorId: "U-fixture-user",
		creatorSessionId: null,
		state: "open",
		requestedAt: "2026-10-06T00:00:00Z",
		dueAt: null,
		expiresAt: null,
		resolvedAt: null,
		version: 2,
		metadata: {},
	},
	canRespond: true,
	canCancel: false,
	effectiveState,
	latestDraft,
	responses: { data: [], nextCursor: null, hasMore: false },
});

let config: string;
beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "tedix-supervise-"));
	mkdirSync(join(config, "decision-capture"), { recursive: true });
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

const state = () => join(config, "decision-capture", `${SESSION}.json`);

/** What capture-stop leaves for a waiting question with a queued draft, aged. */
function waiting(host: "codex" | "claude-code", ageMs: number): void {
	writeFileSync(
		state(),
		JSON.stringify({ requestId: REQUEST, version: 1, token: "t1", host }),
	);
	writeFileSync(
		questionPath(state()),
		JSON.stringify({ requestId: REQUEST, token: "t1", host }),
	);
	writeFileSync(
		draftStatusPath(state()),
		JSON.stringify({ requestId: REQUEST, status: "queued" }),
	);
	const at = (Date.now() - ageMs) / 1000;
	utimesSync(questionPath(state()), at, at);
}

interface Fake {
	queued: Array<[string, string]>;
	resumed: Array<[string, string]>;
	/** Whether the transcript shows the message, given whether it was withdrawn. */
	received: (withdrawn: boolean) => boolean;
	queueResult?: { id: string; offset: number };
	withdrawals: number;
	withdrawResult: boolean;
}

function supervisor(details: unknown[], fake: Partial<Fake> = {}) {
	const seen: Fake = {
		queued: [],
		resumed: [],
		received: () => true,
		withdrawals: 0,
		withdrawResult: true,
		queueResult: { id: "queue-item-1", offset: 0 },
		...fake,
	};
	const lines: string[] = [];
	let reads = 0;
	const drafted: Array<[string, JsonObject]> = [];
	const codex: CodexDriver = {
		queue: async (thread, message) => {
			seen.queued.push([thread, message]);
			return seen.queueResult;
		},
		received: () => seen.received(seen.withdrawals > 0),
		withdraw: () => {
			seen.withdrawals++;
			return seen.withdrawResult;
		},
		resume: async (thread, message) => {
			seen.resumed.push([thread, message]);
			return true;
		},
	};
	let clock = Date.now();
	const runner = new Supervisor({
		env: { TEDIX_CONFIG_DIR: config },
		codex,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
		log: (line) => lines.push(line),
		read: async (args) => {
			reads++;
			if (args.includes("interaction-get")) {
				const next = details.shift();
				if (next === undefined) throw new Error("no detail");
				return structuredClone(next) as JsonObject;
			}
			if (args.includes("interaction-draft-delivered")) {
				const at = args.indexOf("interaction-draft-delivered");
				drafted.push([args[at + 1]!, JSON.parse(args[at + 3]!)]);
				return { request: {}, response: {} };
			}
			if (args.includes("context")) return structuredClone(BINDING);
			if (args.includes("auth")) return structuredClone(AUTH);
			throw new Error(`unexpected read ${args.join(" ")}`);
		},
	});
	return { runner, seen, lines, drafted, reads: () => reads };
}

describe("existing-chat handoff delivery", () => {
	test("a confirmed handoff is not queued again after restart", async () => {
		const first = supervisor([]);
		expect(
			await first.runner.toCodex(
				SESSION,
				"accepted Work brief",
				config,
				undefined,
				"work-1",
			),
		).toBe("codex_queue");
		const restarted = supervisor([]);
		expect(
			await restarted.runner.toCodex(
				SESSION,
				"accepted Work brief",
				config,
				undefined,
				"work-1",
			),
		).toBe("codex_queue");
		expect(restarted.seen.queued).toEqual([]);
		expect(restarted.seen.resumed).toEqual([]);
		expect(
			await restarted.runner.toCodex(
				SESSION,
				"changed brief",
				config,
				undefined,
				"work-1",
			),
		).toBe("queue-pending");
	});

	test("an uncertain handoff keeps the original queue across restart", async () => {
		const first = supervisor([], {
			received: () => false,
			withdrawResult: false,
		});
		expect(
			await first.runner.toCodex(
				SESSION,
				"accepted Work brief",
				config,
				undefined,
				"work-1",
			),
		).toBe("queue-pending");
		const restarted = supervisor([]);
		expect(
			await restarted.runner.toCodex(
				SESSION,
				"accepted Work brief",
				config,
				undefined,
				"work-1",
			),
		).toBe("codex_queue");
		expect(restarted.seen.queued).toEqual([]);
		expect(restarted.seen.resumed).toEqual([]);
	});

	test("parallel delivery cannot enqueue into a chat already being dispatched", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((done) => {
			release = done;
		});
		let queues = 0;
		const runner = new Supervisor({
			env: { TEDIX_CONFIG_DIR: config },
			read: async () => ({}),
			codex: {
				queue: async () => {
					queues++;
					await waiting;
					return { id: "q", offset: 0 };
				},
				received: () => true,
				withdraw: () => true,
				resume: async () => true,
			},
		});
		const first = runner.toCodex(SESSION, "handoff", config);
		expect(await runner.toCodex(SESSION, "reply", config)).toBe(
			"queue-pending",
		);
		release();
		expect(await first).toBe("codex_queue");
		expect(queues).toBe(1);
	});
});

describe("tedix supervise", () => {
	test("queues a late auto draft for an open Codex session and records it", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		const { runner, seen, lines, drafted } = supervisor([interaction(DRAFT)]);
		expect(await runner.tick()).toBe(1);
		expect(seen.queued).toEqual([
			[SESSION, autoDraftMessage({ ...DRAFT, complete: true } as never)],
		]);
		expect(drafted).toEqual([
			[REQUEST, { draftId: DRAFT.id, via: "codex_queue" }],
		]);
		expect(seen.resumed).toEqual([]);
		expect(seen.withdrawals).toBe(0);
		expect(runner.lastPass).toEqual({ checked: 1, failed: 0 });
		expect(peek(autoDeliveryPath(state()))).toEqual({
			requestId: REQUEST,
			draftId: DRAFT.id,
			count: 1,
		});
		expect(lines.join("\n")).toContain("to the open session");
		// Delivered once: the next pass reads nothing.
		const again = supervisor([interaction(DRAFT)]);
		expect(await again.runner.tick()).toBe(0);
		expect(again.reads()).toBe(0);
	});

	test("withdraws an unclaimed queued copy and resumes headless instead", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		const { runner, seen } = supervisor([interaction(DRAFT)], {
			received: () => false,
		});
		expect(await runner.tick()).toBe(1);
		expect(seen.queued).toHaveLength(1);
		expect(seen.withdrawals).toBe(1);
		expect(seen.resumed).toEqual([[SESSION, seen.queued[0]![1]]]);
	});

	test("a queued copy taken while withdrawing is not resumed again", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		const { runner, seen } = supervisor([interaction(DRAFT)], {
			received: (withdrawn) => withdrawn,
		});
		expect(await runner.tick()).toBe(1);
		expect(seen.resumed).toEqual([]);
	});

	test("retains an uncertain queue without starting another turn", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		const { runner, seen, drafted, lines } = supervisor([interaction(DRAFT)], {
			received: () => false,
			withdrawResult: false,
		});
		expect(await runner.tick()).toBe(0);
		expect(seen.queued).toHaveLength(1);
		expect(seen.resumed).toEqual([]);
		expect(drafted).toEqual([]);
		expect(lines.join("\n")).toContain("not confirmed");
		expect(readdirSync(join(config, "supervisor", "codex-queue"))).toHaveLength(
			1,
		);
	});

	test("leaves a Codex question alone while await-draft may still deliver", async () => {
		waiting("codex", CODEX_IDLE_MS - 60_000);
		const { runner, seen, reads } = supervisor([interaction(DRAFT)]);
		expect(await runner.tick()).toBe(0);
		expect(reads()).toBe(0);
		expect(seen.queued).toEqual([]);
	});

	test("never sends a review draft, a closed question, or past the cap", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		let run = supervisor([interaction({ ...DRAFT, delivery: "review" })]);
		expect(await run.runner.tick()).toBe(0);
		run = supervisor([interaction(DRAFT, "resolved")]);
		expect(await run.runner.tick()).toBe(0);
		writeFileSync(
			autoDeliveryPath(state()),
			JSON.stringify({
				requestId: "88888888-8888-4888-8888-888888888888",
				draftId: DRAFT.id,
				count: 3,
			}),
		);
		run = supervisor([interaction(DRAFT)]);
		expect(await run.runner.tick()).toBe(0);
		expect(run.seen.queued).toEqual([]);
	});

	test("skips a question a typed reply already claimed", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		writeFileSync(state(), JSON.stringify({ requestId: REQUEST, token: "t2" }));
		const { runner, reads } = supervisor([interaction(DRAFT)]);
		expect(await runner.tick()).toBe(0);
		expect(reads()).toBe(0);
	});

	test("a failed codex queue records nothing", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		const { runner, lines } = supervisor([interaction(DRAFT)], {
			queueResult: undefined,
		});
		expect(await runner.tick()).toBe(0);
		expect(existsSync(autoDeliveryPath(state()))).toBe(false);
		expect(lines.join("\n")).toContain("codex queue failed");
	});

	test("only logs a late Claude Code auto draft, once", async () => {
		waiting("claude-code", 4 * 60 * 60 * 1000 + 1000);
		const { runner, seen, lines } = supervisor([
			interaction(DRAFT),
			interaction(DRAFT),
		]);
		expect(await runner.tick()).toBe(0);
		expect(await runner.tick()).toBe(0);
		expect(seen.queued).toEqual([]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("not delivered");
		expect(existsSync(autoDeliveryPath(state()))).toBe(false);
	});

	describe("undelivered OS answers", () => {
		const CLAUDE = "11111111-1111-4111-8111-111111111111";
		const CODEX = "22222222-2222-4222-8222-222222222222";
		const WORK = "44444444-4444-4444-8444-444444444444";
		const answer = (
			session: string,
			host: string,
			ageMs: number,
			responseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		) => ({
			responseId,
			requestId: REQUEST,
			subject: `tedix · ${host} waiting: Ship it?`,
			body: "Yes, ship it.",
			respondedAt: new Date(Date.now() - ageMs).toISOString(),
			sessionId: session,
			host,
			workItemId: null,
			projectId: PROJECT,
		});
		/** What capture-stop leaves for each session: host and directory. */
		function sessions(...entries: Array<[string, string]>): void {
			for (const [session, host] of entries)
				writeFileSync(
					join(config, "decision-capture", `${session}.session.json`),
					JSON.stringify({ host, cwd: config }),
				);
		}

		function drain(
			answers: unknown[],
			{
				open = false,
				started = true,
				received = true,
				withdrawn = true,
				undeliveredError,
			}: {
				open?: boolean | undefined;
				started?: boolean;
				received?: boolean;
				withdrawn?: boolean;
				undeliveredError?: Error;
			} = {},
		) {
			const lines: string[] = [];
			const acks: JsonObject[] = [];
			const resumed: Array<[string, string, string]> = [];
			const queued: Array<[string, string]> = [];
			const board: string[][] = [];
			/** The working directory each read was given, by its first command word. */
			const cwds: Array<[string, string | undefined]> = [];
			let finish: (ok: boolean) => void = () => {};
			const claude: ClaudeDriver = {
				open: () => open,
				resume: async (session, message, cwd) => {
					resumed.push([session, message, cwd]);
					return {
						started,
						done: new Promise<boolean>((resolve) => {
							finish = resolve;
						}),
					};
				},
			};
			const codex: CodexDriver = {
				queue: async (thread, message) => {
					queued.push([thread, message]);
					return { id: "queue-item-1", offset: 0 };
				},
				received: () => received,
				withdraw: () => withdrawn,
				resume: async (thread, message, cwd) => {
					resumed.push([thread, message, cwd]);
					return true;
				},
			};
			let clock = Date.now();
			const runner = new Supervisor({
				env: { TEDIX_CONFIG_DIR: config },
				codex,
				claude,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
				log: (line) => lines.push(line),
				read: async (args, _timeoutMs, _input, options) => {
					cwds.push([args[0]!, options?.cwd]);
					if (args.includes("interaction-undelivered")) {
						if (undeliveredError) throw undeliveredError;
						return {
							data: structuredClone(answers),
							observedAt: new Date().toISOString(),
						} as JsonObject;
					}
					if (args.includes("interaction-ack")) {
						acks.push(JSON.parse(args[args.indexOf("--input") + 1]!));
						return { data: [] };
					}
					if (args.includes("delegate")) {
						board.push(args);
						return { id: WORK, reused: false, via: "session" };
					}
					if (args.includes("comment")) {
						board.push(args);
						return {};
					}
					if (args.includes("context")) return structuredClone(BINDING);
					if (args.includes("auth")) return structuredClone(AUTH);
					throw new Error(`unexpected read ${args.join(" ")}`);
				},
			});
			return {
				runner,
				lines,
				acks,
				resumed,
				queued,
				board,
				cwds,
				finish: (ok: boolean) => finish(ok),
			};
		}

		test("an uncertain Codex answer reuses its queue after restart until receipt is confirmed", async () => {
			sessions([SESSION, "codex"]);
			const answers = [answer(SESSION, "codex", 60_000)];
			const first = drain(answers, { received: false, withdrawn: false });
			expect(await first.runner.tick()).toBe(0);
			expect(first.queued).toHaveLength(1);
			expect(first.resumed).toEqual([]);
			expect(first.acks).toEqual([]);
			const retry = drain(answers, { received: false, withdrawn: false });
			expect(await retry.runner.tick()).toBe(0);
			expect(retry.queued).toEqual([]);
			expect(retry.resumed).toEqual([]);
			const confirmed = drain(answers);
			expect(await confirmed.runner.tick()).toBe(1);
			expect(confirmed.queued).toEqual([]);
			expect(confirmed.resumed).toEqual([]);
			expect(confirmed.acks).toHaveLength(1);
			expect(readdirSync(join(config, "supervisor", "codex-queue"))).toEqual(
				[],
			);
		});

		test("a retained Codex answer resumes only after withdrawal succeeds", async () => {
			sessions([SESSION, "codex"]);
			const answers = [answer(SESSION, "codex", 60_000)];
			const first = drain(answers, { received: false, withdrawn: false });
			expect(await first.runner.tick()).toBe(0);
			const retry = drain(answers, { received: false, withdrawn: true });
			expect(await retry.runner.tick()).toBe(1);
			expect(retry.queued).toEqual([]);
			expect(retry.resumed).toHaveLength(1);
		});

		test("new answers cannot enqueue another batch while the prior queue is uncertain", async () => {
			sessions([SESSION, "codex"]);
			const answers = [answer(SESSION, "codex", 60_000)];
			expect(
				await drain(answers, {
					received: false,
					withdrawn: false,
				}).runner.tick(),
			).toBe(0);
			const retry = drain([
				...answers,
				answer(
					SESSION,
					"codex",
					30_000,
					"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				),
			]);
			expect(await retry.runner.tick()).toBe(0);
			expect(retry.queued).toEqual([]);
			expect(retry.resumed).toEqual([]);
			expect(retry.acks).toEqual([]);
		});

		test("a damaged queue receipt does not start a replacement turn", async () => {
			sessions([SESSION, "codex"]);
			const answers = [answer(SESSION, "codex", 60_000)];
			expect(
				await drain(answers, {
					received: false,
					withdrawn: false,
				}).runner.tick(),
			).toBe(0);
			const directory = join(config, "supervisor", "codex-queue");
			writeFileSync(join(directory, readdirSync(directory)[0]!), "{");
			const retry = drain(answers);
			expect(await retry.runner.tick()).toBe(0);
			expect(retry.queued).toEqual([]);
			expect(retry.resumed).toEqual([]);
		});

		test("reads resolve from the session's checkout without changing this process's directory", async () => {
			sessions([CLAUDE, "claude-code"]);
			const home = process.cwd();
			const run = drain([answer(CLAUDE, "claude-code", 3 * 60 * 60 * 1000)]);
			expect(await run.runner.tick()).toBe(1);
			expect(process.cwd()).toBe(home);
			expect(run.cwds.filter(([word]) => word === "setup")).toEqual([
				["setup", config],
			]);
			expect(
				run.cwds.filter(([, cwd]) => cwd === config).map(([word]) => word),
			).toEqual(["setup", "-w", "-w"]);
		});

		test("an unreadable answer list logs the read failure's reason once", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", 60_000)], {
				undeliveredError: new Error(
					"Tedix CLI read failed (exit 1): Error: not signed in",
				),
			});
			expect(await run.runner.tick()).toBe(0);
			expect(await run.runner.tick()).toBe(0);
			expect(
				run.lines.filter((line) => line.includes("could not be read")),
			).toEqual([
				"undelivered answers could not be read for -w fixture: Tedix CLI read failed (exit 1): Error: not signed in",
			]);
		});

		test("decides by host, open session and age", () => {
			const base = { open: false, working: false };
			expect(
				answerAction({ ...base, host: "claude-code", ageMs: 1000 }).kind,
			).toBe("claude-resume");
			expect(
				answerAction({ ...base, host: "claude-code", ageMs: 1000, open: true }),
			).toEqual({
				kind: "wait",
				reason:
					"the Claude Code session is open in a terminal; its hooks deliver it",
			});
			expect(
				answerAction({
					...base,
					host: "claude-code",
					ageMs: OPEN_SESSION_GRACE_MS,
					open: true,
				}).kind === "wait" &&
					answerAction({
						...base,
						host: "claude-code",
						ageMs: OPEN_SESSION_GRACE_MS,
						open: true,
					}),
			).toMatchObject({ reason: expect.stringContaining("after 15 minutes") });
			expect(
				answerAction({
					...base,
					host: "claude-code",
					ageMs: 1000,
					open: undefined,
				}).kind,
			).toBe("wait");
			expect(answerAction({ ...base, host: "codex", ageMs: 1000 }).kind).toBe(
				"codex",
			);
			expect(
				answerAction({ ...base, host: "codex", ageMs: 1000, working: true })
					.kind,
			).toBe("wait");
			for (const host of ["claude-code", "codex"] as const)
				expect(
					answerAction({
						host,
						ageMs: 3 * 60 * 60 * 1000,
						open: true,
						working: true,
					}).kind,
				).toBe("wait");
		});

		test("resumes a closed Claude Code session headless, then records delivery and acknowledgement", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", 60_000)]);
			expect(await run.runner.tick()).toBe(1);
			expect(run.resumed).toEqual([
				[
					CLAUDE,
					'The user replied in Tedix OS: "Yes, ship it."\nThis is the user\'s own answer (not a tedi draft) to your question "Ship it?". Act on it as their reply.',
					config,
				],
			]);
			expect(run.acks).toEqual([
				{
					responseIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
					via: "supervisor_resume",
					acknowledged: false,
				},
			]);
			run.finish(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(run.acks.at(-1)).toEqual({
				responseIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
				via: "supervisor_resume",
				acknowledged: true,
			});
		});

		test("never resumes a Claude Code session open in a terminal, and logs why once", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", 60_000)], {
				open: true,
			});
			expect(await run.runner.tick()).toBe(0);
			expect(await run.runner.tick()).toBe(0);
			expect(run.resumed).toEqual([]);
			expect(run.acks).toEqual([]);
			expect(run.lines).toEqual([
				expect.stringContaining("open in a terminal; its hooks deliver it"),
			]);
		});

		test("a resume that does not confirm the session records nothing", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", 60_000)], {
				started: false,
			});
			expect(await run.runner.tick()).toBe(0);
			expect(run.acks).toEqual([]);
			expect(run.lines.join("\n")).toContain("did not confirm this session");
		});

		test("queues a human answer for a Codex session like a draft", async () => {
			sessions([CODEX, "codex"]);
			const run = drain([answer(CODEX, "codex", 60_000)]);
			expect(await run.runner.tick()).toBe(1);
			expect(run.queued).toHaveLength(1);
			expect(run.queued[0]![1]).toStartWith(
				'The user replied in Tedix OS: "Yes, ship it."',
			);
			expect(run.acks).toEqual([
				{
					responseIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
					via: "codex_queue",
					acknowledged: false,
				},
			]);
		});

		test("an overdue answer stays with an open originating session without new Work", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", 3 * 60 * 60 * 1000)], {
				open: true,
			});
			expect(await run.runner.tick()).toBe(0);
			expect(await run.runner.tick()).toBe(0);
			expect(run.resumed).toEqual([]);
			expect(run.board).toEqual([]);
			expect(run.acks).toEqual([]);
			expect(run.lines).toHaveLength(1);
			expect(run.lines[0]).toContain("left undelivered");
		});

		test("an overdue answer resumes only its available originating session", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", 3 * 60 * 60 * 1000)]);
			expect(await run.runner.tick()).toBe(1);
			expect(run.resumed[0]?.[0]).toBe(CLAUDE);
			expect(run.board).toEqual([]);
			expect(run.acks[0]).toMatchObject({
				via: "supervisor_resume",
				acknowledged: false,
			});
		});

		test("an overdue answer with a missing target remains undelivered", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CODEX, "codex", 3 * 60 * 60 * 1000)]);
			expect(await run.runner.tick()).toBe(0);
			expect(run.queued).toEqual([]);
			expect(run.resumed).toEqual([]);
			expect(run.board).toEqual([]);
			expect(run.acks).toEqual([]);
			expect(run.lines.join("\n")).toContain("not on this machine");
		});
	});

	test("the LaunchAgent runs the given program with escaped arguments", () => {
		const plist = launchAgentPlist(["/opt/tedix & co/tedix", "supervise"], {
			PATH: "/usr/bin",
		});
		expect(plist).toContain("<string>/opt/tedix &amp; co/tedix</string>");
		expect(plist).toContain("<string>supervise</string>");
		expect(plist).toContain("<key>RunAtLoad</key>");
	});

	describe("loading the LaunchAgent", () => {
		let dir: string;
		const domain = "gui/501";
		const service = `${domain}/dev.tedix.supervisor`;
		const plist = () => join(dir, "agent.plist");
		const fake = () => join(dir, "launchctl");
		const calls = () =>
			readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
		const setState = (value: string) =>
			writeFileSync(join(dir, "state"), value);
		const load = () =>
			loadLaunchAgent(plist(), domain, systemLaunchctl(fake()), {
				attempts: 5,
				unloadAttempts: 5,
				sleep: async () => {},
			});

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "tedix-launchctl-"));
			// Like launchd, bootout returns while the old job is still listed for
			// a couple of checks, and bootstrap refuses until it is gone.
			writeFileSync(
				fake(),
				`#!/bin/sh
dir="$(dirname "$0")"
echo "$*" >> "$dir/calls"
state="$(cat "$dir/state")"
case "$1" in
print)
	case "$state" in
	loaded) echo "state = running"; exit 0 ;;
	unloading2) echo unloading1 > "$dir/state"; exit 0 ;;
	unloading1) echo none > "$dir/state"; exit 0 ;;
	*) echo "Could not find service" >&2; exit 113 ;;
	esac ;;
bootout)
	if [ "$state" = loaded ]; then echo unloading2 > "$dir/state"; exit 0; fi
	echo "Boot-out failed: 3: No such process" >&2; exit 3 ;;
bootstrap)
	if [ "$state" = none ]; then echo loaded > "$dir/state"; exit 0; fi
	echo "Bootstrap failed: 5: Input/output error" >&2; exit 5 ;;
esac
exit 64
`,
				{ mode: 0o755 },
			);
			writeFileSync(plist(), "<plist/>");
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		test("a fresh install ignores the not-loaded bootout", async () => {
			setState("none");
			expect(await load()).toBeUndefined();
			expect(calls()).toEqual([
				`bootout ${service}`,
				`print ${service}`,
				`bootstrap ${domain} ${plist()}`,
				`print ${service}`,
			]);
		});

		test("a reinstall waits for the old job to unload before bootstrapping", async () => {
			setState("loaded");
			expect(await load()).toBeUndefined();
			expect(calls().filter((call) => call.startsWith("bootstrap"))).toEqual([
				`bootstrap ${domain} ${plist()}`,
			]);
			expect(readFileSync(join(dir, "state"), "utf8").trim()).toBe("loaded");
		});

		test("a bootstrap that never loads reports launchctl's error", async () => {
			setState("broken");
			const error = await load();
			expect(error).toContain("exit 5");
			expect(error).toContain("Input/output error");
		});
	});
});

describe("Codex transcript acknowledgment", () => {
	const message = "Explicit Work handoff fixture: a complete unique message";
	test("requires the complete message in a received user record", () => {
		for (const row of [
			{ type: "event_msg", payload: { type: "user_message", message } },
			{
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: message }],
				},
			},
		])
			expect(codexMessageReceived(JSON.stringify(row), message)).toBe(true);
	});
	test("rejects diagnostic echoes, assistant text and incomplete records", () => {
		for (const row of [
			{
				type: "response_item",
				payload: { type: "custom_tool_call", input: message },
			},
			{ type: "event_msg", payload: { type: "item_completed", message } },
			{
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: message }],
				},
			},
			{
				type: "event_msg",
				payload: { type: "user_message", message: message.slice(0, 20) },
			},
		])
			expect(codexMessageReceived(JSON.stringify(row), message)).toBe(false);
		expect(codexMessageReceived('{"type":"event_msg",', message)).toBe(false);
	});
});

describe("explicit exact-chat Work pickup", () => {
	const WORK = "77777777-7777-4777-8777-777777777777";
	test("retains offline Work, delivers on reconnect, and suppresses repeats across restart", async () => {
		const { recordDelegation, readDelegations } =
			await import("./delegation-ledger");
		const env = { TEDIX_CONFIG_DIR: config };
		writeFileSync(
			join(config, "decision-capture", `${SESSION}.session.json`),
			JSON.stringify({ host: "codex", cwd: config }),
		);
		recordDelegation(env, SESSION, {
			id: WORK,
			title: "Fixture Work",
			via: "session",
			to: `codex:${SESSION}`,
			workspace: "fixture",
			createdAt: new Date().toISOString(),
			launch: true,
			projectId: PROJECT,
			orgId: PROJECT,
		});
		let online = false;
		let calls = 0;
		const codex: CodexDriver = {
			resolveTranscript: async () => online,
			queue: async (thread) => {
				expect(thread).toBe(SESSION);
				calls++;
				return { id: "queued-work", offset: 0 };
			},
			received: () => true,
			withdraw: () => {
				throw new Error("must not resume a confirmed queue");
			},
			resume: async () => {
				throw new Error("must not create a second turn");
			},
		};
		let clock = Date.now();
		const deps = {
			env,
			codex,
			now: () => clock,
			log: () => {},
			read: async (args: string[]) => {
				if (args.includes("context")) return structuredClone(BINDING);
				if (args.includes("auth")) return structuredClone(AUTH);
				if (args.includes("readiness"))
					return { workItemId: WORK, ready: true };
				if (args.includes("interaction-undelivered"))
					return { data: [], observedAt: new Date().toISOString() };
				throw new Error(args.join(" "));
			},
		};
		const runner = new Supervisor(deps);
		expect(await runner.tick()).toBe(0);
		expect(calls).toBe(0);
		expect(readDelegations(env, SESSION)[0]?.deliveredAt).toBeUndefined();
		online = true;
		clock += 11 * 60_000;
		expect(await runner.tick()).toBe(1);
		expect(readDelegations(env, SESSION)[0]?.deliveredAt).toBeDefined();
		expect(await new Supervisor(deps).tick()).toBe(0);
		expect(calls).toBe(1);
	});
});

describe("privacyProtected", () => {
	test("names the macOS folders the launchd supervisor cannot read", () => {
		const home = "/Users/ada";
		for (const path of [
			"/Users/ada/Documents",
			"/Users/ada/Documents/GitHub/acme",
			"/Users/ada/Desktop/x",
			"/Users/ada/Downloads/x",
			"/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/x",
		])
			expect(privacyProtected(path, home, "darwin")).toBe(true);
		for (const path of [
			"/Users/ada/.codex/worktrees/b515/acme",
			"/Users/ada/DocumentsArchive/acme",
			"/tmp/acme",
		])
			expect(privacyProtected(path, home, "darwin")).toBe(false);
		expect(privacyProtected("/Users/ada/Documents/acme", home, "linux")).toBe(
			false,
		);
	});
});
