import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureStatePath,
	claimReply,
	classify,
	runDecisionCapture,
} from "./decision-capture";
import type { JsonObject } from "./hook-io";

/** Checks for opt-in decision capture: pairing, redaction, opt-in and fail-silent behaviour. */
const SESSION = "77777777-7777-4777-8777-777777777777";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const WORK = "55555555-5555-4555-8555-555555555555";
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
const CREATED = { id: REQUEST, version: 1 };

let config: string;
let payloads: Array<[string[], JsonObject]>;

beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "tedix-capture-"));
	payloads = [];
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

async function runHook(
	mode: "stop" | "reply",
	event: JsonObject,
	reads: unknown[],
	{
		env = {},
		duringCreate,
		failRespond = false,
		stdin,
	}: {
		env?: Record<string, string>;
		duringCreate?: () => void;
		failRespond?: boolean;
		stdin?: string;
	} = {},
): Promise<string[][]> {
	const calls: string[][] = [];
	const environment: NodeJS.ProcessEnv = {
		TEDIX_CONFIG_DIR: config,
		TEDIX_EXTERNAL_AGENT: "agent",
		TEDIX_MCP_BEARER_TOKEN: "token",
		...env,
	};
	await runDecisionCapture(mode, {
		env: environment,
		stdin: stdin ?? JSON.stringify({ session_id: SESSION, ...event }),
		cwd: process.cwd(),
		write: () => {
			throw new Error("capture never writes to stdout");
		},
		branch: () => "main",
		read: async (args) => {
			calls.push(args);
			// Interactions are addressed to the signed-in user, never an agent identity.
			expect(environment.TEDIX_EXTERNAL_AGENT).toBeUndefined();
			expect(environment.TEDIX_MCP_BEARER_TOKEN).toBeUndefined();
			if (failRespond && args.includes("interaction-respond"))
				throw new Error("offline");
			const input = args.indexOf("--input");
			if (input >= 0)
				payloads.push([
					args,
					JSON.parse(readFileSync(args[input + 1]!.slice(1), "utf8")),
				]);
			if (duringCreate && args.includes("interaction-create")) duringCreate();
			if (!reads.length) throw new Error("unexpected read");
			return structuredClone(reads.shift()) as JsonObject;
		},
	});
	return calls;
}

const state = () => join(config, "decision-capture", `${SESSION}.json`);
const verbs = () =>
	payloads.map(([args]) =>
		args.includes("interaction-create")
			? "interaction-create"
			: "interaction-respond",
	);

describe("tedix hooks capture-stop / capture-reply", () => {
	test("a turn end and its reply become one resolved Interaction", async () => {
		await runHook(
			"stop",
			{
				last_assistant_message:
					"## Deployed\nAll green. Want me to also clean up legacy?",
			},
			[BINDING, AUTH, CREATED],
		);
		const [args, created] = payloads[0]!;
		expect(args).toContain("interaction-create");
		expect(created.projectId).toBe(PROJECT);
		expect(created.requestedFrom).toEqual({
			type: "user",
			id: "U-fixture-user",
		});
		expect(created.kind).toBe("question");
		expect(created.subject).toContain("claude-code waiting: Deployed");
		expect(created.metadata.sessionId).toBe(SESSION);
		expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(
			0.9 * 86_400_000,
		);
		expect(existsSync(state())).toBe(true);
		await runHook(
			"reply",
			{ prompt: "yes and aggressively remove the legacy path" },
			[BINDING, AUTH, { request: CREATED }],
		);
		const [replyArgs, response] = payloads[1]!;
		expect(replyArgs[replyArgs.indexOf("interaction-respond") + 1]).toBe(
			REQUEST,
		);
		expect(response.body).toBe("yes and aggressively remove the legacy path");
		expect(response.responseKind).toBe("answer");
		expect(response.metadata.replyClass).toBe("simplify");
		expect(response.resolvesRequest).toBe(true);
		expect(existsSync(state())).toBe(false);
	});

	test("selected Work is the context and secrets are redacted", async () => {
		await runHook(
			"stop",
			{
				last_assistant_message:
					"Set TEDIX_API_KEY=abcd1234secret and Bearer abcdefghijklmnopqrstuvwxyz",
			},
			[{ ...BINDING, workItemId: WORK }, AUTH, CREATED],
		);
		const created = payloads[0]![1];
		expect(created.workItemId).toBe(WORK);
		expect(created).not.toHaveProperty("projectId");
		expect(JSON.stringify(created)).not.toContain("abcd1234secret");
		expect(JSON.stringify(created)).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});

	test("without opt-in nothing is sent or stored", async () => {
		const calls = await runHook("stop", { last_assistant_message: "done" }, [
			{ ...BINDING, decisionCapture: false },
		]);
		expect(calls).toHaveLength(1);
		expect(payloads).toEqual([]);
		expect(existsSync(state())).toBe(false);
		await runHook("stop", { last_assistant_message: "done" }, [
			{ status: "unbound" },
		]);
		expect(payloads).toEqual([]);
	});

	test("system re-entries and unpaired prompts are not replies", async () => {
		expect(
			await runHook("reply", { prompt: "first prompt of a session" }, []),
		).toEqual([]);
		await runHook(
			"stop",
			{ last_assistant_message: "Running tests in the background." },
			[BINDING, AUTH, CREATED],
		);
		for (const prompt of [
			"<task-notification>\n<task-id>x</task-id>",
			"[SYSTEM NOTIFICATION - NOT USER INPUT]",
			"<system-reminder>x</system-reminder>",
		])
			expect(await runHook("reply", { prompt }, [])).toEqual([]);
		expect(existsSync(state())).toBe(true);
	});

	test("a pending background turn is not waiting on the user", async () => {
		await runHook(
			"stop",
			{
				last_assistant_message: "Waiting for agents.",
				background_tasks: [{ id: "a" }],
			},
			[BINDING, AUTH],
		);
		expect(payloads).toEqual([]);
	});

	test("an unanswered turn is left to expire when the next one ends", async () => {
		await runHook("stop", { last_assistant_message: "first" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		const second = { id: "88888888-8888-4888-8888-888888888888", version: 1 };
		await runHook("stop", { last_assistant_message: "second" }, [
			BINDING,
			AUTH,
			second,
		]);
		// Never an answer in the user's name, never a cancel, never a rejected close.
		expect(verbs()).toEqual(["interaction-create", "interaction-create"]);
		expect(
			Date.parse(payloads[1]![1].expiresAt) - Date.now(),
		).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
		expect(JSON.parse(readFileSync(state(), "utf8")).requestId).toBe(second.id);
	});

	test("a reply typed while the question is created is kept", async () => {
		const path = captureStatePath({ TEDIX_CONFIG_DIR: config }, SESSION);
		await runHook(
			"stop",
			{ last_assistant_message: "Ship it?" },
			[BINDING, AUTH, CREATED, { request: CREATED }],
			{
				duringCreate: () =>
					expect(claimReply({ prompt: "yes" }, path)).toBe("early"),
			},
		);
		expect(verbs()).toEqual(["interaction-create", "interaction-respond"]);
		const answer = payloads[1]![1];
		expect(answer.body).toBe("yes");
		expect(answer.responseKind).toBe("answer");
		expect(answer.metadata.source).toBe("user-reply");
		expect(existsSync(state())).toBe(false);
	});

	test("a reply that fails to send is retried at the next turn end", async () => {
		await runHook("stop", { last_assistant_message: "first" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		await runHook("reply", { prompt: "make it happen" }, [BINDING, AUTH], {
			failRespond: true,
		});
		expect(existsSync(state())).toBe(true);
		const second = { id: "88888888-8888-4888-8888-888888888888", version: 1 };
		await runHook("stop", { last_assistant_message: "second" }, [
			BINDING,
			AUTH,
			{ request: CREATED },
			second,
		]);
		const retried = payloads.at(-2)![1];
		expect(retried.body).toBe("make it happen");
		expect(retried.metadata.source).toBe("user-reply");
	});

	test("Codex identity and failures stay silent", async () => {
		await runHook(
			"stop",
			{ last_assistant_message: "done" },
			[BINDING, AUTH, CREATED],
			{
				env: { CODEX_THREAD_ID: SESSION },
			},
		);
		expect(payloads[0]![1].subject).toContain("codex waiting");
		await runHook("stop", { last_assistant_message: "done" }, [
			BINDING,
			{ ...AUTH, wouldUse: "external-agent:x" },
		]);
		await runHook("stop", { last_assistant_message: "done" }, [
			{ ...BINDING, contextSessionId: REQUEST },
		]);
		expect(await runHook("stop", {}, [], { stdin: "{not json" })).toEqual([]);
		expect(payloads).toHaveLength(1);
	});

	test("mined reply classes", () => {
		for (const [reply, label] of [
			["continue", "continue"],
			["make it happen", "approve"],
			["its already done, right?", "challenge"],
			["recheck now", "verify"],
			["explain me in simple user stories", "plain-english"],
			["fan out with subagents", "fan-out"],
			["commit and push all deps bumps", "ship"],
			["status now?", "status"],
			["Do you need me babysit you?", "frustration"],
			["add a sidebar button", "instruction"],
		])
			expect(classify(reply!)).toBe(label!);
	});
});
