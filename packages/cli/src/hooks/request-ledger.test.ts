import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./hook-io";
import { openRequestLines } from "./prompt-context";
import {
	ledgerText,
	runRequestLedger,
	readTurnTranscript,
} from "./request-ledger";

const SESSION = "77777777-7777-4777-8777-777777777777";
const OTHER = "88888888-8888-4888-8888-888888888888";
const BINDING = {
	status: "bound",
	workspace: "fixture",
	org: "org_fixture",
	mcpUrl: "https://fixture.example.invalid/mcp",
	projectId: "66666666-6666-4666-8666-666666666666",
	root: process.cwd(),
	origin: "https://github.com/example-org/widgets.git",
	decisionCapture: true,
};
const AUTH = {
	wouldUse: "stored-login",
	workspace: "fixture",
	mcpUrl: BINDING.mcpUrl,
	storedLogin: { loginId: "U-fixture-user" },
};

let config: string;
beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "tedix-ledger-"));
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

const outbox = () =>
	readdirSync(join(config, "session-events", "fixture--default"));

async function run(
	mode: "prompt" | "turn",
	event: JsonObject,
	{
		binding = BINDING,
		env = {},
		fail = false,
	}: {
		binding?: JsonObject;
		env?: Record<string, string>;
		fail?: boolean;
	} = {},
) {
	const uploads: JsonObject[][] = [];
	await runRequestLedger(mode, {
		env: { TEDIX_CONFIG_DIR: config, ...env },
		stdin: JSON.stringify({ session_id: SESSION, ...event }),
		cwd: process.cwd(),
		now: () => new Date("2026-10-06T10:00:00Z"),
		write: () => {},
		read: async (args, _timeout, input) => {
			if (args.includes("context")) return binding;
			if (args.includes("auth")) return AUTH;
			if (args.at(-1) === "code" && input) {
				if (fail) throw new Error("offline");
				const prefix = "async () => await work.record_agent_session_events(";
				expect(input).toStartWith(prefix);
				uploads.push(JSON.parse(input.slice(prefix.length, -1)).events);
				return { accepted: 1, duplicates: 0 };
			}
			throw new Error(`unexpected read ${args.join(" ")}`);
		},
	});
	return uploads;
}

describe("session event upload", () => {
	test("uploads the typed message, redacted, and empties the outbox", async () => {
		const uploads = await run("prompt", {
			prompt: "Fix the login page and rotate token=supersecretvalue123 please",
		});
		expect(uploads).toEqual([
			[
				{
					kind: "prompt",
					harness: "claude-code",
					sessionKey: SESSION,
					sourceAt: "2026-10-06T10:00:00Z",
					text: "Fix the login page and rotate token=[redacted] please",
					repository: "widgets",
				},
			],
		]);
		expect(outbox()).toEqual([]);
	});

	test("keeps a failed upload and sends it with the next event", async () => {
		await run("prompt", { prompt: "Fix the login page" }, { fail: true });
		expect(outbox()).toHaveLength(1);
		const [batch] = await run("turn", {
			last_assistant_message: "Pushed 4f2a9c1e; the login page works.",
		});
		expect(batch!.map((event) => event.kind)).toEqual(["prompt", "turn"]);
		expect(outbox()).toEqual([]);
	});

	test("a turn carries the activity digest of its transcript", async () => {
		const transcript = join(config, `${SESSION}.jsonl`);
		const lines = [
			{ type: "user", message: { content: "Earlier request about the docs" } },
			{ type: "user", message: { content: "Fix the login page please" } },
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Agent",
							input: { description: "Check the CSS", run_in_background: true },
						},
						{ type: "tool_use", id: "t2", name: "Bash", input: {} },
					],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t2",
							is_error: true,
							content: "Exit code 1\nmore",
						},
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: "Async agent launched",
						},
					],
				},
			},
		];
		writeFileSync(
			transcript,
			lines.map((line) => JSON.stringify(line)).join("\n"),
		);
		expect(readTurnTranscript(transcript).activity).toBe(
			[
				"Started background agent: Check the CSS",
				"Failed Bash: Exit code 1",
				"Agent reported: Async agent launched",
			].join("\n"),
		);
		const [batch] = await run("turn", {
			last_assistant_message: "Started a background check.",
			transcript_path: transcript,
		});
		expect(batch![0]!.activity).toContain("Failed Bash: Exit code 1");
	});

	test("nothing is written without the decision-capture opt-in", async () => {
		expect(
			await run(
				"prompt",
				{ prompt: "Fix the login page" },
				{ binding: { ...BINDING, decisionCapture: false } },
			),
		).toEqual([]);
	});

	test("unattended runs and host injections are skipped", async () => {
		expect(
			await run(
				"prompt",
				{ prompt: "Fix the login page" },
				{ env: { CLAUDE_CODE_SESSION_ATTENDED: "0" } },
			),
		).toEqual([]);
		expect(
			ledgerText("prompt", {
				prompt: "<task-notification>x</task-notification>",
			}),
		).toBeUndefined();
		expect(
			ledgerText("turn", { last_assistant_message: "<heartbeat/>" }),
		).toBeUndefined();
	});
});

describe("open request lines", () => {
	const now = new Date("2026-10-06T12:00:00Z");
	const row = (overrides: JsonObject) => ({
		harness: "claude-code",
		sessionKey: SESSION,
		repository: "widgets",
		text: "Fix the login page",
		status: "open",
		sourceAt: "2026-10-06T10:00:00Z",
		...overrides,
	});

	test("lists this chat first, at risk first, then earlier chats", () => {
		const lines = openRequestLines(
			{
				requests: {
					data: [
						row({ text: "Add a changeset", sourceAt: "2026-10-06T09:00:00Z" }),
						row({ text: "Answer the build question", status: "dropped_risk" }),
						row({ text: "Ship the docs", sessionKey: OTHER }),
						row({ text: "Elsewhere", sessionKey: OTHER, repository: "other" }),
					],
				},
			},
			{ session: SESSION, repository: "widgets" },
			now,
		);
		expect(lines[0]).toStartWith("Open requests (3):");
		expect(lines.slice(1)).toEqual([
			'- dropped risk · 2h · "Answer the build question"',
			'- open · 3h · "Add a changeset"',
			'- open · 2h · earlier chat · "Ship the docs"',
		]);
	});

	test("caps the list and points to Tedix OS", () => {
		const data = Array.from({ length: 7 }, (_, index) =>
			row({ text: `Request ${index}` }),
		);
		const lines = openRequestLines(
			{ requests: { data } },
			{ session: SESSION, repository: "widgets" },
			now,
		);
		expect(lines).toHaveLength(7);
		expect(lines.at(-1)).toContain("2 more open");
	});

	test("says nothing when the ledger is unavailable or empty", () => {
		expect(
			openRequestLines(
				{ requests: { unavailable: true } },
				{ session: SESSION },
				now,
			),
		).toEqual([]);
		expect(openRequestLines({}, { session: SESSION }, now)).toEqual([]);
	});
});

test("preserves an earlier answer and a recovery receipt before a later summary", () => {
	const transcript = join(config, "earlier-answer.jsonl");
	const records = [
		{
			type: "user",
			message: { content: [{ type: "text", text: "Why did upload fail?" }] },
		},
		{
			type: "assistant",
			message: {
				content: [
					{
						type: "text",
						text: "The upload failed because its file exceeded the limit. Use the native uploader.",
					},
					{ type: "tool_use", id: "failed-upload", name: "upload", input: {} },
				],
			},
		},
		{
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "failed-upload",
						is_error: true,
						content: "File exceeds upload size limit",
					},
				],
			},
		},
		{
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "fixed-upload", name: "upload", input: {} },
				],
			},
		},
		{
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "fixed-upload",
						content: "Native upload saved successfully",
					},
				],
			},
		},
		{
			type: "assistant",
			message: {
				content: [
					{
						type: "text",
						text: "Summary: legal page needs your OK. Say go to publish.",
					},
				],
			},
		},
	];
	writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join("\n"));
	const { text, activity } = readTurnTranscript(transcript);
	expect(text).toContain(
		"The upload failed because its file exceeded the limit",
	);
	expect(activity).toContain("Failed upload: File exceeds upload size limit");
	expect(activity).toContain(
		"Succeeded upload after failure: Native upload saved successfully",
	);
	expect(text).toContain("legal page needs your OK");
});

test("keeps the entire summary and earlier replies in the turn text", () => {
	const transcript = join(config, "summary-asks.jsonl");
	writeFileSync(
		transcript,
		[
			{ type: "user", message: { content: "What needs me?" } },
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "text",
							text:
								"Long status report ".repeat(30) +
								"\n- Public README needs your OK.\n- Say go to bundle cards.\n- Tell me if the legal sections should stay.",
						},
					],
				},
			},
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Background: CI is still running." }],
				},
			},
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
	const { text } = readTurnTranscript(transcript);
	expect(text).toContain("Public README needs your OK");
	expect(text).toContain("Say go to bundle cards");
	expect(text).toContain("Tell me if the legal sections should stay");
	expect(text).toContain("Background: CI is still running.");
});

test("uploads all redacted messages in a turn without the old 8,000 character truncation", async () => {
	const transcript = join(config, "full-turn.jsonl");
	const first =
		"Approve the public README before publishing. " +
		"Detail ".repeat(1600) +
		" token=supersecretvalue123";
	writeFileSync(
		transcript,
		[
			{ type: "user", message: { content: "Review the README" } },
			{
				type: "assistant",
				message: { content: [{ type: "text", text: first }] },
			},
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Waiting for your decision." }],
				},
			},
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
	const [batch] = await run("turn", {
		last_assistant_message: "Waiting for your decision.",
		transcript_path: transcript,
	});
	expect(batch![0]!.text).toStartWith(
		"Approve the public README before publishing.",
	);
	expect(batch![0]!.text).toContain("Waiting for your decision.");
	expect(batch![0]!.text.length).toBeGreaterThan(8000);
	expect(batch![0]!.text).not.toContain("supersecretvalue123");
});

test("keeps the host final response when the transcript write lags", async () => {
	const transcript = join(config, "lagging-turn.jsonl");
	writeFileSync(
		transcript,
		[
			{ type: "user", message: { content: "Fix the result" } },
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Checking the result." }] },
			},
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
	const [batch] = await run("turn", {
		transcript_path: transcript,
		last_assistant_message: "The result is fixed and verified.",
	});
	expect(batch![0]!.text).toBe(
		"Checking the result.\n\nThe result is fixed and verified.",
	);
	expect(
		await run("turn", {
			transcript_path: transcript,
			last_assistant_message: "<heartbeat/>",
		}),
	).toEqual([]);
});

test("keeps full delegated reports as agent evidence without treating them as a human boundary", async () => {
	const transcript = join(config, "delegated-report.jsonl");
	const report =
		"[Subagent hand-back] " +
		"Checked result. ".repeat(700) +
		"Live version verified. token=supersecretvalue123";
	writeFileSync(
		transcript,
		[
			{ type: "user", message: { content: "Fix the import" } },
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "The import lane is running." }],
				},
			},
			{
				type: "user",
				isMeta: true,
				message: { content: `<agent-message>${report}</agent-message>` },
			},
			{
				type: "user",
				isMeta: true,
				message: { content: "Unrelated hook injection" },
			},
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	const [batch] = await run("turn", {
		transcript_path: transcript,
		last_assistant_message: "The import lane is running.",
	});
	const text = batch![0]!.text;
	expect(text).toStartWith("The import lane is running.");
	expect(text).toContain("DELEGATED AGENT REPORT (not a user reply):");
	expect(text).toContain("Live version verified.");
	expect(text).not.toContain("supersecretvalue123");
	expect(text).not.toContain("Unrelated hook injection");
	expect(text.match(/The import lane is running\./g)).toHaveLength(1);
});

test("Codex capture keeps visible commentary and final text only", () => {
	const transcript = join(config, "visible-codex.jsonl");
	const message = (channel: string, text: string) => ({
		type: "response_item",
		payload: {
			type: "message",
			role: "assistant",
			channel,
			content: [{ type: "output_text", text }],
		},
	});
	writeFileSync(
		transcript,
		[
			{
				type: "event_msg",
				payload: { type: "user_message", message: "Review this task" },
			},
			message("analysis", "Internal analysis marker must stay private"),
			message("commentary", "Checking the requested result."),
			message("final", "The result has been checked."),
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
	const turn = readTurnTranscript(transcript);
	expect(turn.text).toBe(
		"Checking the requested result.\n\nThe result has been checked.",
	);
	expect(JSON.stringify(turn)).not.toContain("Internal analysis marker");
});
