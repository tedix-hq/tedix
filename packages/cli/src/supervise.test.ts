import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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
	HANDOFF_AFTER_MS,
	launchAgentPlist,
	loadLaunchAgent,
	OPEN_SESSION_GRACE_MS,
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
}

function supervisor(details: unknown[], fake: Partial<Fake> = {}) {
	const seen: Fake = {
		queued: [],
		resumed: [],
		received: () => true,
		withdrawals: 0,
		queueResult: { id: "queue-item-1", offset: 0 },
		...fake,
	};
	const lines: string[] = [];
	let reads = 0;
	const codex: CodexDriver = {
		queue: async (thread, message) => {
			seen.queued.push([thread, message]);
			return seen.queueResult;
		},
		received: () => seen.received(seen.withdrawals > 0),
		withdraw: () => {
			seen.withdrawals++;
			return true;
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
			if (args.includes("context")) return structuredClone(BINDING);
			if (args.includes("auth")) return structuredClone(AUTH);
			throw new Error(`unexpected read ${args.join(" ")}`);
		},
	});
	return { runner, seen, lines, reads: () => reads };
}

describe("tedix supervise", () => {
	test("queues a late auto draft for an open Codex session and records it", async () => {
		waiting("codex", CODEX_IDLE_MS + 1000);
		const { runner, seen, lines } = supervisor([interaction(DRAFT)]);
		expect(await runner.tick()).toBe(1);
		expect(seen.queued).toEqual([
			[SESSION, autoDraftMessage({ ...DRAFT, complete: true } as never)],
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
		const LEAD = "33333333-3333-4333-8333-333333333333";
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
				lead = LEAD as string | null,
				received = true,
			}: {
				open?: boolean | undefined;
				started?: boolean;
				lead?: string | null;
				received?: boolean;
			} = {},
		) {
			const lines: string[] = [];
			const acks: JsonObject[] = [];
			const resumed: Array<[string, string, string]> = [];
			const queued: Array<[string, string]> = [];
			const board: string[][] = [];
			let finish: (ok: boolean) => void = () => {};
			const claude: ClaudeDriver = {
				open: () => open,
				name: (session) => (session === LEAD ? "LEARN" : undefined),
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
				withdraw: () => true,
				resume: async () => true,
			};
			const runner = new Supervisor({
				env: { TEDIX_CONFIG_DIR: config },
				codex,
				claude,
				lead: () => lead ?? undefined,
				sleep: async () => {},
				log: (line) => lines.push(line),
				read: async (args) => {
					if (args.includes("interaction-undelivered"))
						return {
							data: structuredClone(answers),
							observedAt: new Date().toISOString(),
						} as JsonObject;
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
				finish: (ok: boolean) => finish(ok),
			};
		}

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
						ageMs: HANDOFF_AFTER_MS,
						open: true,
						working: true,
					}).kind,
				).toBe("handoff");
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

		test("hands an answer undelivered for 2 hours to the lead session", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", HANDOFF_AFTER_MS)], {
				open: true,
			});
			expect(await run.runner.tick()).toBe(1);
			expect(run.resumed).toEqual([]);
			const [delegate, comment] = run.board;
			expect(delegate).toContain(`claude-code:${LEAD}`);
			expect(delegate).toContain(PROJECT);
			expect(comment!.join(" ")).toContain(
				`The user's own answer (not a tedi draft): "Yes, ship it."`,
			);
			expect(run.acks).toEqual([
				{
					responseIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
					via: "handoff",
					handoffTo: "LEARN",
					handoffRef: WORK,
				},
			]);
		});

		test("without a lead session an overdue answer is logged and left", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CLAUDE, "claude-code", HANDOFF_AFTER_MS)], {
				lead: null,
			});
			expect(await run.runner.tick()).toBe(0);
			expect(run.board).toEqual([]);
			expect(run.lines.join("\n")).toContain("no lead session");
		});

		test("an answer for a session on another machine waits for the hand-off", async () => {
			sessions([CLAUDE, "claude-code"]);
			const run = drain([answer(CODEX, "codex", 60_000)]);
			expect(await run.runner.tick()).toBe(0);
			expect(run.queued).toEqual([]);
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
