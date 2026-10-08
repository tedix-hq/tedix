import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
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
	CODEX_IDLE_MS,
	type CodexDriver,
	launchAgentPlist,
	Supervisor,
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

	test("the LaunchAgent runs the given program with escaped arguments", () => {
		const plist = launchAgentPlist(["/opt/tedix & co/tedix", "supervise"], {
			PATH: "/usr/bin",
		});
		expect(plist).toContain("<string>/opt/tedix &amp; co/tedix</string>");
		expect(plist).toContain("<string>supervise</string>");
		expect(plist).toContain("<key>RunAtLoad</key>");
	});
});
