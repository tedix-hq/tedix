import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	archiveWithReadback,
	checkOutput,
	fixtures,
	percentiles,
	phases,
	summarize,
	unwrap,
} from "./chat-latency.mjs";

describe("live chat eval accounting", () => {
	test("question samples are counted once per group", () => {
		expect(
			summarize([{ operation: "question", ok: true, wallMs: 100 }]).question
				.count,
		).toBe(1);
	});
	test("fixed coverage is ten writes and ten questions, with all output kinds and edits", () => {
		expect(fixtures).toHaveLength(20);
		expect(fixtures.filter((f) => f.kind)).toHaveLength(10);
		expect(fixtures.filter((f) => f.topic)).toHaveLength(10);
		expect(
			new Set(fixtures.filter((f) => f.target).map((f) => f.kind)),
		).toEqual(new Set(["document", "sheet", "presentation"]));
	});
	test("nearest-rank p50/p90 exclude missing measurements", () => {
		expect(
			percentiles([
				null,
				undefined,
				NaN,
				...Array.from({ length: 20 }, (_, i) => i + 1),
			]),
		).toEqual({ n: 20, p50: 10, p90: 18 });
		expect(percentiles([null])).toEqual({ n: 0, p50: null, p90: null });
	});
	test("hedge token time includes launch delay, never substitutes a missing token", () => {
		expect(
			phases({
				kernelRouteHedge: {
					winner: "hedge",
					afterMs: 5000,
					hedgeFirstPartialMs: 2000,
				},
			}).routeFirstTokenMs,
		).toBe(7000);
		expect(
			phases({
				kernelRouteHedge: {
					winner: "hedge",
					afterMs: 5000,
					hedgeFirstPartialMs: null,
				},
			}).routeFirstTokenMs,
		).toBeNull();
	});
	test("calculates phase durations and execution from durable timestamps", () => {
		const result = phases(
			{
				kernelTurnTimings: {
					turnType: "write_proposal",
					stages: {
						routePlanStarted: 10,
						plannerFirstProgress: 30,
						routePlanEnded: 130,
						writeProposalPlanStarted: 130,
						writeProposalPlanEnded: 230,
					},
				},
				kernelWriteExecutedAt: "2026-01-01T00:00:00Z",
			},
			"2026-01-01T00:00:02Z",
		);
		expect(result).toMatchObject({
			contextMs: 20,
			routeDecisionMs: 100,
			writePlanMs: 100,
			executeMs: 2000,
			firstAnswerMs: null,
		});
	});
	test("unwraps Code Mode and inspect envelopes", () => {
		expect(
			unwrap({ result: { result: { run: { id: "fictional" } } } }),
		).toEqual({ run: { id: "fictional" } });
	});
	test("an edit must preserve expected content and advance the same output", () => {
		const fixture = { kind: "document", contains: ["Welcome", "Fresh bread"] };
		const target = { id: "fictional", revision: 1 };
		const detail = {
			output: { id: "fictional" },
			currentRevision: {
				revision: 2,
				content: {
					kind: "document",
					blocks: [{ text: "Welcome. Fresh bread." }],
				},
			},
		};
		expect(() => checkOutput(fixture, detail, target)).not.toThrow();
		expect(() =>
			checkOutput(
				fixture,
				{
					...detail,
					currentRevision: { ...detail.currentRevision, revision: 1 },
				},
				target,
			),
		).toThrow("advance");
		expect(() =>
			checkOutput(fixture, { ...detail, output: { id: "other" } }, target),
		).toThrow("advance");
		expect(() =>
			checkOutput(
				fixture,
				{
					...detail,
					currentRevision: {
						revision: 2,
						content: { kind: "document", blocks: [{ text: "Fresh bread" }] },
					},
				},
				target,
			),
		).toThrow("Welcome");
		expect(() =>
			checkOutput(fixture, { ...detail, currentRevision: null }, target),
		).toThrow("canonical");
	});
});

describe("scratch archive readback", () => {
	test("retries null bounded writes until a separate read confirms the archive", async () => {
		let writes = 0;
		let reads = 0;
		const delays = [];
		const result = await archiveWithReadback(
			async () => {
				writes++;
				return null;
			},
			async () => {
				reads++;
				return { status: writes >= 3 ? "archived" : "active" };
			},
			(state) => state?.status === "archived",
			async (ms) => {
				delays.push(ms);
			},
		);
		expect(result.status).toBe("archived");
		expect(writes).toBe(3);
		expect(reads).toBe(3);
		expect(delays).toEqual([1000, 2000]);
	});
	test("an archive receipt alone cannot pass; missing readback exhausts bounded backoff", async () => {
		const delays = [];
		await expect(
			archiveWithReadback(
				async () => ({ status: "archived" }),
				async () => null,
				(state) => state?.status === "archived",
				async (ms) => {
					delays.push(ms);
				},
			),
		).rejects.toThrow("after retries");
		expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
	});
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	test(`${signal} waits for the current chat and archives all scratch resources`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "chat-latency-test-"));
		const stateFile = join(directory, "state.json");
		const ready = join(directory, "ready");
		const fakeCli = join(directory, "tedix");
		await writeFile(stateFile, JSON.stringify({ chats: [], outputs: [] }));
		await writeFile(
			fakeCli,
			`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.EVAL_TEST_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
if (args[2] === "chat") {
  state.chats.push({ id: args[args.indexOf("-c") + 1], status: "active" });
  save();
  writeFileSync(process.env.EVAL_TEST_READY, "ready");
  await Bun.sleep(200);
  state.outputs.push({ id: "fictional-output", status: "active" });
  save();
  console.log("null");
  process.exit(1);
}
const os = {
  create_os_workspace: async (input) => { state.workspace = { id: "fictional-workspace", status: "active", ...input }; save(); return { workspace: state.workspace }; },
  list_os_outputs: async () => ({ items: state.outputs.filter(o => o.status === "active"), truncated: false }),
  archive_os_output: async ({ outputId }) => { state.outputs.find(o => o.id === outputId).status = "archived"; save(); return null; },
  get_os_output: async ({ outputId }) => ({ output: state.outputs.find(o => o.id === outputId) }),
  archive_os_workspace: async () => { state.workspace.status = "archived"; save(); return null; },
  get_os_workspace: async () => ({ workspace: state.workspace }),
};
const home = {
  archive_conversation: async ({ conversationId }) => { state.chats.find(c => c.id === conversationId).status = "archived"; save(); return null; },
  list_conversations: async () => ({ conversations: state.chats }),
};
const result = await new Function("os", "home", "return (" + args[3] + ")()") (os, home);
console.log(JSON.stringify(result));
`,
		);
		await chmod(fakeCli, 0o755);
		const proc = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "chat-latency.mjs"),
				"--rounds",
				"1",
				"--out",
				join(directory, "evidence"),
			],
			{
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH}`,
					TEDIX_ORGANIZATION: "fictional-org",
					EVAL_TEST_STATE: stateFile,
					EVAL_TEST_READY: ready,
				},
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		try {
			for (let i = 0; !(await Bun.file(ready).exists()); i++) {
				if (i >= 200) throw new Error("Fake chat did not start");
				await Bun.sleep(10);
			}
			proc.kill(signal);
			expect(await proc.exited).toBe(signal === "SIGINT" ? 130 : 143);
			const state = JSON.parse(await readFile(stateFile, "utf8"));
			expect(state.workspace.visibility).toBe("private");
			expect(state.workspace.status).toBe("archived");
			expect(state.chats).toHaveLength(1);
			expect(state.chats[0].status).toBe("archived");
			expect(state.outputs).toEqual([
				{ id: "fictional-output", status: "archived" },
			]);
			expect(
				await Bun.file(join(directory, "evidence", "archived.json")).exists(),
			).toBe(true);
		} finally {
			if (proc.exitCode === null) {
				proc.kill("SIGKILL");
				await proc.exited;
			}
			await rm(directory, { recursive: true, force: true });
		}
	}, 10000);
}
