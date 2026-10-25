import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";

mock.module("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
}));

const { callMcpTool } = await import("../src/mcp-bridge");

/**
 * A skill workflow's long tedi turn (a ~20k-character judge prompt) outlives
 * the cognitive runtime's 10 s read deadline. That read failure must not end
 * the step with a bare -32603: the accepted turn keeps running, so the bridge
 * keeps polling the SAME task and returns the settled reply, never
 * dispatching the turn again.
 */
const manifest: CapabilityManifest = {
	mcp: { acme_tedix: ["run_tedi_turn"] },
	network: false,
	rationale: { mode: "off" },
	expectedAnnotations: { destructive: false, readOnly: false },
	grounding: { required: false, minCausalScore: 1, enforce: "warn" },
	schedule: null,
	reliability: null,
	reason: { enabled: false, maxCalls: null },
};
const props: Parameters<typeof callMcpTool>[1] = {
	manifest,
	tediId: "tedi-1",
	aggregateMcpSlug: "acme-unified",
	orgId: "org-1",
	skillId: "skill-1",
	runId: "run-1",
	executionEpoch: 0,
	namespaceToSlug: { acme_tedix: "acme-tedix" },
	mcpBaseHost: "mcp.example.test",
	serviceToken: "test-service-token",
};
const workflow = {
	stepName: "judge",
	stepCount: 1,
	stepType: "do" as const,
	attempt: 1,
	phase: "run" as const,
	ordinal: 1,
};

test("a long skill-workflow tedi turn survives a task read timeout and settles", async () => {
	const taskId = "tedi:tedi-1:run-judge";
	const prompt = `Judge these opportunities.\n${"Candidate thread summary. ".repeat(800)}`;
	assert.ok(prompt.length >= 20_000);
	const calls: Array<{ method: string; taskId?: string; text?: string }> = [];
	let reads = 0;
	const env = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = (await new Request(input, init).json()) as {
					id: string;
					method: string;
					params?: {
						taskId?: string;
						arguments?: { text?: string };
					};
				};
				calls.push({
					method: body.method,
					taskId: body.params?.taskId,
					text: body.params?.arguments?.text,
				});
				if (body.method === "tools/call") {
					const accepted = {
						ok: true,
						accepted: true,
						pending: true,
						assistant: null,
						task: { id: taskId, pollWith: "tasks/get" },
					};
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							structuredContent: accepted,
							content: [{ type: "text", text: JSON.stringify(accepted) }],
						},
					});
				}
				reads += 1;
				if (reads === 1)
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						error: {
							code: -32603,
							message: "cognitive runtime request timed out after 10000ms",
						},
					});
				const settled = {
					assistant: { content: "Verdict: two worth a reply." },
				};
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						taskId,
						status: "completed",
						result: {
							structuredContent: settled,
							content: [{ type: "text", text: JSON.stringify(settled) }],
						},
					},
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];

	const outcome = (await callMcpTool(env, props, {
		namespace: "acme_tedix",
		method: "run_tedi_turn",
		args: { session_key: "skill:judge", text: prompt },
		workflow,
	})) as { value: { assistant?: { content?: string } } };

	assert.equal(outcome.value.assistant?.content, "Verdict: two worth a reply.");
	// One dispatch with the whole prompt, then two reads of the same task.
	assert.deepEqual(
		calls.map(({ method, taskId }) => [method, taskId]),
		[
			["tools/call", undefined],
			["tasks/get", taskId],
			["tasks/get", taskId],
		],
	);
	assert.equal(calls[0]?.text, prompt);
});
