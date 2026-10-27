import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { validateWorkflowSource } from "@tedix/db/queries/cognitive/skill-validation";
import workflow from "../examples/research-judge/scripts/workflow";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { callMcpTool } = await import("../src/mcp-bridge");
const threads = Array.from({ length: 12 }, (_, i) => ({
	id: `thread-${i}`,
	excerpt: `Question: compare prices. Thread ${i} asks about price comparison.`,
}));
const ack =
	"Tedi run run-lost was dispatched but acknowledgement is unknown. Read its status or retry with the same client_request_id.";
function reply(batch) {
	return {
		assistant: {
			content: JSON.stringify(
				batch.map((t) => ({ id: t.id, score: 7, reason: "Relevant question" })),
			),
		},
	};
}
function harness(dispatch) {
	const cache = new Map();
	const calls = [];
	const sleeps = [];
	const step = {
		do: async (name, options, action) => {
			if (cache.has(name)) return cache.get(name);
			const result = await (action ?? options)();
			cache.set(name, result);
			return result;
		},
		sleep: async (name) => {
			sleeps.push(name);
		},
	};
	const env = {
		MCP: {
			tedi: {
				run_tedi_turn: async (request) => {
					calls.push(request);
					return dispatch(request, calls.length);
				},
			},
		},
	};
	const run = (input = threads) =>
		workflow.run({ payload: { threads: input } }, step, env);
	return { calls, cache, sleeps, run };
}

test("12 opened threads survive a batch losing both acknowledgements through the real bridge", async () => {
	const wire = [];
	const manifest = parseCapabilityManifest(
		await readFile(
			new URL("../examples/research-judge/SKILL.md", import.meta.url),
			"utf8",
		),
	);
	const env = {
		MCP_SERVICE: {
			fetch: async (input, init) => {
				const body = await new Request(input, init).json();
				const request = body.params.arguments;
				wire.push(request);
				const failed = request.client_request_id.endsWith(":batch-1");
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: failed
						? { isError: true, content: [{ type: "text", text: ack }] }
						: {
								structuredContent: reply(
									JSON.parse(request.text.split("\n").at(-1)),
								),
							},
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	const h = harness(async (args, ordinal) => {
		const result = await callMcpTool(
			env,
			{
				manifest: { ...manifest, mcp: { acme_tedix: ["run_tedi_turn"] } },
				tediId: "tedi-1",
				orgId: "org-1",
				skillId: "skill-1",
				runId: "research-1",
				executionEpoch: 0,
				namespaceToSlug: { acme_tedix: "judge" },
				aggregateMcpSlug: "acme-unified",
				mcpBaseHost: "mcp.example.test",
				serviceToken: "test-token",
			},
			{
				namespace: "acme_tedix",
				method: "run_tedi_turn",
				args,
				workflow: {
					stepName: `judge-${ordinal}`,
					stepCount: ordinal,
					stepType: "do",
					attempt: 1,
					phase: "run",
					ordinal: 1,
				},
			},
		);
		return result.value;
	});
	const result = await h.run();
	expect(result.judged).toBe(12);
	expect(result.verdicts.map((v) => v.id)).toEqual(threads.map((t) => t.id));
	const lost = wire.filter((r) => r.client_request_id.endsWith(":batch-1"));
	expect(lost).toHaveLength(2);
	expect(lost[0]).toEqual(lost[1]);
	expect(wire.map((r) => JSON.parse(r.text.split("\n").at(-1)).length)).toEqual(
		[3, 3, 3, 2, 1, 3, 3],
	);
	expect(new Set(wire.map((r) => r.client_request_id)).size).toBe(6);
	await h.run();
	expect(wire).toHaveLength(7); // Completed steps replay without any dispatch.
});

test("partial, duplicate, foreign and malformed verdicts recover only missing thread IDs", async () => {
	const h = harness(async (request, ordinal) => {
		const batch = JSON.parse(request.text.split("\n").at(-1));
		if (ordinal === 1)
			return {
				assistant: {
					content: JSON.stringify([
						{ id: batch[0].id, score: 7, reason: "Relevant" },
						{ id: batch[1].id, score: 7, reason: "Duplicate" },
						{ id: batch[1].id, score: 7, reason: "Duplicate" },
						{ id: batch[2].id, score: 99, reason: "Invalid score" },
						{ id: "foreign", score: 7, reason: "Not opened" },
					]),
				},
			};
		return reply(batch);
	});
	expect((await h.run()).judged).toBe(12);
	expect(
		h.calls
			.slice(1, 3)
			.map((r) => JSON.parse(r.text.split("\n").at(-1)).map((t) => t.id)),
	).toEqual([["thread-1"], ["thread-2"]]);
});

test("pending turns are observed with the same identity before splitting", async () => {
	const h = harness(async (r, n) =>
		n === 1
			? {
					ok: true,
					pending: true,
					run_id: "run-1",
					session_key: r.session_key,
					assistant: null,
				}
			: {
					...reply(JSON.parse(r.text.split("\n").at(-1))),
					run_id: "run-1",
					session_key: r.session_key,
				},
	);
	expect((await h.run()).judged).toBe(12);
	expect(h.calls[0]).toEqual(h.calls[1]);
	expect(h.sleeps).toHaveLength(1);
});

test("an unavailable singleton names missing IDs and still attempts later batches", async () => {
	const h = harness(async (r) => {
		const batch = JSON.parse(r.text.split("\n").at(-1));
		if (batch.some((t) => t.id === "thread-4")) throw new Error(ack);
		return reply(batch);
	});
	await expect(h.run()).rejects.toThrow(
		'JUDGE_INCOMPLETE: unjudged thread IDs ["thread-4"]',
	);
	expect(h.calls.some((r) => r.text.includes("thread-11"))).toBe(true);
	expect([...h.cache.values()].some((v) => v?.error === `Error: ${ack}`)).toBe(
		true,
	);
});

test("authorization failures propagate without splitting", async () => {
	const h = harness(async () => {
		throw new Error("FORBIDDEN");
	});
	await expect(h.run()).rejects.toThrow("FORBIDDEN");
	expect(h.calls).toHaveLength(1);
});

test("pending receipts cannot change run identity", async () => {
	const h = harness(async (r, n) => ({
		ok: true,
		pending: true,
		run_id: `run-${n}`,
		session_key: r.session_key,
		assistant: null,
	}));
	await expect(h.run()).rejects.toThrow("JUDGE_PENDING_IDENTITY_INVALID");
	expect(h.calls).toHaveLength(2);
});

test("permanently pending turns stop after bounded observation and report every missing ID", async () => {
	const h = harness(async (r) => ({
		ok: true,
		pending: true,
		run_id: r.session_key,
		session_key: r.session_key,
		assistant: null,
	}));
	await expect(h.run()).rejects.toThrow(
		`JUDGE_INCOMPLETE: unjudged thread IDs ${JSON.stringify(threads.map((t) => t.id))}`,
	);
	expect(h.calls.length).toBeLessThan(300);
	const counts = new Map<string, number>();
	for (const r of h.calls)
		counts.set(r.client_request_id, (counts.get(r.client_request_id) ?? 0) + 1);
	expect([...counts.values()].every((count) => count === 13)).toBe(true);
});

test("input bounds reject duplicate IDs and exclude unrelated fields from prompts", async () => {
	const h = harness(async (r) => reply(JSON.parse(r.text.split("\n").at(-1))));
	await expect(h.run([threads[0], threads[0]])).rejects.toThrow(
		"unique thread IDs",
	);
	expect(h.calls).toHaveLength(0);
	expect(
		(await h.run([{ ...threads[0], extra: "private unrelated data" }])).judged,
	).toBe(1);
	expect(h.calls[0].text).not.toContain("private unrelated data");
});

test("formatted workflow passes canonical source and capability validation", async () => {
	const base = new URL("../examples/research-judge/", import.meta.url);
	const content = await readFile(new URL("SKILL.md", base), "utf8");
	const source = await readFile(new URL("scripts/workflow.ts", base), "utf8");
	expect(
		validateWorkflowSource(
			source,
			"scripts/workflow.ts",
			parseCapabilityManifest(content),
		),
	).toEqual([]);
});
