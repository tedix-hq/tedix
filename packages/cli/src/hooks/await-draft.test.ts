import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AWAIT_DRAFT_MAX_MS, runAwaitDraft } from "./await-draft";
import { autoDeliveryPath, draftStatusPath, peek } from "./decision-capture";
import type { JsonObject } from "./hook-io";

/** Checks for the Codex Stop continuation: only an explicit auto draft continues the turn. */
const SESSION = "77777777-7777-4777-8777-777777777777";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const REQUEST = "99999999-9999-4999-8999-999999999999";
const BINDING = {
	status: "bound",
	workspace: "fixture",
	org: "org_fixture",
	mcpUrl: "https://fixture.example.invalid/mcp",
	projectId: PROJECT,
	root: process.cwd(),
	decisionCapture: true,
};
const AUTH = {
	wouldUse: "stored-login",
	workspace: "fixture",
	mcpUrl: BINDING.mcpUrl,
	storedLogin: { loginId: "U-fixture-user" },
};
const DRAFT = {
	id: "abababab-abab-4bab-8bab-abababababab",
	body: "Yes, rerun the failing test.",
	rationale: "Fixture rationale",
	delivery: "review",
	drafterId: "33333333-3333-4333-8333-333333333333",
	drafterName: "Builder",
	createdAt: "2026-10-06T00:00:00Z",
	turnType: "continue",
};
const CODEX_STOP = { session_id: SESSION, turn_id: "turn-1" };

const nativeRequest = (overrides: JsonObject = {}) => ({
	id: REQUEST,
	orgId: "11111111-1111-4111-8111-111111111111",
	workItemId: null,
	caseId: null,
	projectId: null,
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
	...overrides,
});
let config: string;
beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "tedix-await-draft-"));
	mkdirSync(join(config, "decision-capture"), { recursive: true });
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

const state = () => join(config, "decision-capture", `${SESSION}.json`);
/** What capture-stop leaves once the question exists and its draft is (not) queued. */
const created = (status: "queued" | "none" = "queued") => {
	writeFileSync(
		state(),
		JSON.stringify({
			requestId: REQUEST,
			version: 1,
			token: "t1",
			host: "codex",
		}),
	);
	writeFileSync(
		draftStatusPath(state()),
		JSON.stringify({ requestId: REQUEST, status }),
	);
};
const interaction = (latestDraft: unknown, effectiveState = "open") => ({
	request: nativeRequest(),
	canRespond: true,
	canCancel: false,
	effectiveState,
	latestDraft,
	responses: { data: [], nextCursor: null, hasMore: false },
});

async function run(
	details: unknown[],
	{
		event = CODEX_STOP,
		env = {},
		onSleep = (count: number) => count === 1 && created(),
	}: {
		event?: JsonObject;
		env?: Record<string, string>;
		onSleep?: (count: number) => unknown;
	} = {},
) {
	let now = 0;
	let detailReads = 0;
	const reads = [BINDING, AUTH];
	const output = await runAwaitDraft(
		{
			env: { TEDIX_CONFIG_DIR: config, ...env },
			stdin: JSON.stringify(event),
			cwd: process.cwd(),
			write: () => {
				throw new Error("the command prints the continuation");
			},
			read: async (args, _timeout, input) => {
				if (args.includes("interaction-get")) {
					detailReads++;
					expect(input).toBeUndefined();
					expect(args.slice(-5)).toEqual([
						"work",
						"interaction-get",
						REQUEST,
						"--input",
						JSON.stringify({ responseLimit: 5 }),
					]);
					const next = details.shift();
					if (next === undefined) throw new Error("Unknown native tool");
					return structuredClone(next) as JsonObject;
				}
				if (!reads.length) throw new Error("unexpected read");
				return structuredClone(reads.shift()) as JsonObject;
			},
		},
		{
			clock: () => now,
			sleep: async (ms) => {
				now += ms;
				onSleep(Math.round(now / 1000));
			},
		},
	);
	return { output, detailReads, elapsed: now };
}

describe("tedix hooks await-draft", () => {
	test("an auto draft continues the Codex turn with the framed reply", async () => {
		mkdirSync(join(config, "agent-status"), { recursive: true });
		const { output } = await run(
			[interaction(null), interaction({ ...DRAFT, delivery: "auto" })],
			{ env: { TEDIX_AGENT_STATUS: "1" } },
		);
		const continuation = JSON.parse(output!);
		expect(continuation.decision).toBe("block");
		expect(continuation.reason).toStartWith(
			`Tedix tedi Builder replied for the user (auto, reversible step; the user can override at any time): ${JSON.stringify(DRAFT.body)}`,
		);
		expect(peek(autoDeliveryPath(state()))).toEqual({
			requestId: REQUEST,
			draftId: DRAFT.id,
			count: 1,
		});
		// The question stays open and the session is recorded as working.
		expect(existsSync(state())).toBe(true);
		expect(
			peek(join(config, "agent-status", `codex-${SESSION}.json`)),
		).toMatchObject({ state: "working" });
	});

	test("review, legacy or absent drafts and closed questions end silently", async () => {
		for (const detail of [
			interaction({ ...DRAFT, delivery: "review" }),
			interaction(DRAFT),
			interaction({ ...DRAFT, delivery: "auto" }, "resolved"),
		]) {
			rmSync(state(), { force: true });
			const { output } = await run([detail]);
			expect(output).toBeUndefined();
			expect(existsSync(autoDeliveryPath(state()))).toBe(false);
		}
	});

	test("no queued draft ends without a read; waiting stops at 5 minutes", async () => {
		const unqueued = await run([], {
			onSleep: (count) => count === 1 && created("none"),
		});
		expect(unqueued.output).toBeUndefined();
		expect(unqueued.detailReads).toBe(0);
		rmSync(state(), { force: true });
		const pending = await run(
			Array.from({ length: 60 }, () => interaction(null)),
		);
		expect(pending.output).toBeUndefined();
		expect(pending.elapsed).toBeLessThanOrEqual(AWAIT_DRAFT_MAX_MS);
		expect(pending.detailReads).toBeGreaterThan(20);
	});

	test("Claude Code and a bad event never wait", async () => {
		for (const event of [{ session_id: SESSION }, { session_id: "bad" }]) {
			const { output, detailReads, elapsed } = await run(
				[interaction({ ...DRAFT, delivery: "auto" })],
				{ event },
			);
			expect(output).toBeUndefined();
			expect(detailReads).toBe(0);
			expect(elapsed).toBe(0);
		}
	});
});
