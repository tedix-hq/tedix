import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { buildRuntimeRunId } from "@tedix/api-contract/utils/runtime-identity";
import {
	SkillWorkflowTediTaskReferenceSchema,
	SkillWorkflowTediTaskSigningPayloadSchema,
	WORKFLOW_TEDI_TASK_SIGNATURE_CONTEXT,
} from "@tedix/api-contract/schemas/cognitive";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";

mock.module("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
}));

const { callMcpTool, McpBridge } = await import("../src/mcp-bridge");

function nativeRunForProgram(program: string, tediId = "tedi-1") {
	const key = program.match(/"client_request_id":"(wftedi_[0-9a-f]{64})"/)?.[1];
	assert.ok(key, "reserved tedi dispatch uses a host-scoped key");
	return buildRuntimeRunId({ tediId, turnKey: key, surface: "mcp" });
}

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

for (const readError of [
	"cognitive runtime request timed out after 10000ms",
	"cognitive runtime request failed: Network connection lost.",
	"cognitive runtime listEvents failed with status 503",
	"cognitive runtime listEvents failed",
]) {
	test(`a long skill-workflow tedi turn survives a failed task read and settles (${readError})`, async () => {
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
								message: readError,
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

		assert.equal(
			outcome.value.assistant?.content,
			"Verdict: two worth a reply.",
		);
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
}

test("a 4xx task read of a tedi turn stays a final error", async () => {
	const taskId = "tedi:tedi-1:run-forbidden";
	let reads = 0;
	const env = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = (await new Request(input, init).json()) as {
					id: string;
					method: string;
				};
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
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					error: {
						code: -32603,
						message: "cognitive runtime listEvents failed with status 403",
					},
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];

	await assert.rejects(
		callMcpTool(env, props, {
			namespace: "acme_tedix",
			method: "run_tedi_turn",
			args: { session_key: "skill:judge", text: "Judge." },
			workflow,
		}),
		/listEvents failed with status 403/,
	);
	assert.equal(reads, 1);
});

for (const codeMode of [false, true]) {
	for (const persistent of [false, true]) {
		test(`unknown acknowledgement is retried once with the same turn identity (codeMode=${codeMode}, persistent=${persistent})`, async () => {
			const requests: unknown[] = [];
			const env = {
				MCP_SERVICE: {
					fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
						const body = await new Request(input, init).json();
						requests.push(body);
						if (persistent || requests.length === 1)
							return Response.json({
								jsonrpc: "2.0",
								id: "1",
								result: {
									isError: true,
									content: [
										{
											type: "text",
											text: "Tedi run tedi-1:judge was dispatched but acknowledgement is unknown. Read its status or retry with the same client_request_id.",
										},
									],
								},
							});
						return Response.json({
							jsonrpc: "2.0",
							id: "1",
							result: {
								structuredContent: {
									assistant: { content: "All threads judged" },
								},
							},
						});
					},
				},
			} as unknown as Parameters<typeof callMcpTool>[0];
			const call = () =>
				callMcpTool(
					env,
					{
						...props,
						tediNamespace: "acme_tedix",
						manifest: {
							...manifest,
							mcp: { [codeMode ? "tedi" : "acme_tedix"]: ["run_tedi_turn"] },
						},
					},
					{
						namespace: codeMode ? "tedi" : "acme_tedix",
						method: "run_tedi_turn",
						args: { session_key: "judge", text: "Judge the batch" },
						workflow,
					},
				);
			if (persistent) await assert.rejects(call, /acknowledgement is unknown/);
			else {
				const result = (await call()) as {
					value: { assistant: { content: string } };
				};
				assert.equal(result.value.assistant.content, "All threads judged");
			}
			assert.equal(requests.length, 2);
			const [first, second] = requests as Array<{
				params: { arguments: Record<string, unknown> };
			}>;
			assert.deepEqual(first!.params.arguments, second!.params.arguments);
			if (codeMode)
				assert.match(String(first!.params.arguments.code), /wftedi_/);
			else
				assert.match(
					String(first!.params.arguments.client_request_id),
					/^wfidem_/,
				);
		});
	}
}

test("unrelated dispatch failures are never retried", async () => {
	let calls = 0;
	const env = {
		MCP_SERVICE: {
			fetch: async () => {
				calls++;
				return Response.json({
					jsonrpc: "2.0",
					id: "1",
					error: { code: -32603, message: "permission denied" },
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	await assert.rejects(
		() =>
			callMcpTool(env, props, {
				namespace: "acme_tedix",
				method: "run_tedi_turn",
				args: { text: "Judge" },
				workflow,
			}),
		/permission denied/,
	);
	assert.equal(calls, 1);
});

test("HTTP acknowledgement failure redelivers the explicit client identity once", async () => {
	const ids: unknown[] = [];
	const env = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = (await new Request(input, init).json()) as {
					params: { arguments: { client_request_id: string } };
				};
				ids.push(body.params.arguments.client_request_id);
				if (ids.length === 1)
					return Response.json(
						{
							error:
								"Tedi run tedi-1:judge was dispatched but acknowledgement is unknown. Read its status or retry with the same client_request_id.",
						},
						{ status: 500 },
					);
				return Response.json({
					jsonrpc: "2.0",
					id: "1",
					result: { structuredContent: { assistant: { content: "judged" } } },
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	await callMcpTool(env, props, {
		namespace: "acme_tedix",
		method: "run_tedi_turn",
		args: { text: "Judge", client_request_id: "original-batch" },
		workflow,
	});
	assert.deepEqual(ids, ["original-batch", "original-batch"]);
});

test("workflow retries retain turn identity while different batches get distinct identities", async () => {
	const ids: unknown[] = [];
	const env = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = (await new Request(input, init).json()) as {
					params: { arguments: { client_request_id: string } };
				};
				ids.push(body.params.arguments.client_request_id);
				return Response.json({
					jsonrpc: "2.0",
					id: "1",
					result: { structuredContent: { assistant: { content: "judged" } } },
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	for (const context of [
		workflow,
		{ ...workflow, attempt: 2 },
		{ ...workflow, ordinal: 2 },
	]) {
		await callMcpTool(env, props, {
			namespace: "acme_tedix",
			method: "run_tedi_turn",
			args: { text: "Judge" },
			workflow: context,
		});
	}
	assert.equal(ids[0], ids[1]);
	assert.notEqual(ids[0], ids[2]);
});

for (const pending of [false, true]) {
	test(`reserved tedi dispatch signs its ${pending ? "polled task" : "legacy run"} reference before returning the result`, async () => {
		let runId = "";
		let taskId = "";
		const calls: string[] = [];
		const env = {
			MCP_SERVICE: {
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					const body = (await new Request(input, init).json()) as {
						id: string;
						method: string;
						params: {
							name?: string;
							taskId?: string;
							arguments?: { code: string };
						};
					};
					calls.push(body.method);
					if (body.method === "tasks/get") {
						assert.equal(body.params.taskId, taskId);
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								taskId,
								status: "completed",
								result: { assistant: { content: "Canonical reply" } },
							},
						});
					}
					assert.equal(body.params.name, "code");
					runId = nativeRunForProgram(body.params.arguments!.code);
					taskId = pending ? `tedi:tedi-1:${runId}` : runId;
					const accepted = pending
						? {
								ok: true,
								accepted: true,
								pending: true,
								task: { id: taskId, pollWith: "tasks/get" },
							}
						: {
								ok: true,
								run_id: runId,
								assistant: { content: "Canonical reply" },
							};
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { structuredContent: accepted },
					});
				},
			},
		} as unknown as Parameters<typeof callMcpTool>[0];
		const result = (await callMcpTool(
			env,
			{
				...props,
				tediNamespace: "reviewer",
				manifest: { ...manifest, mcp: { tedi: ["run_tedi_turn"] } },
			},
			{
				namespace: "tedi",
				method: "run_tedi_turn",
				args: { text: "Review", session_key: "session" },
				workflow: { ...workflow, attempt: 3 },
				sensitiveOutput: false,
			},
		)) as {
			value: { assistant: { content: string } };
			tediTaskReference: unknown;
		};
		assert.equal(result.value.assistant.content, "Canonical reply");
		const ref = SkillWorkflowTediTaskReferenceSchema.parse(
			result.tediTaskReference,
		);
		assert.equal(ref.workflowRunId, props.runId);
		assert.equal(ref.organizationId, props.orgId);
		assert.equal(ref.executionEpoch, props.executionEpoch);
		assert.equal(ref.stepName, workflow.stepName);
		assert.equal(ref.attempt, 3);
		assert.equal(ref.taskId, taskId);
		assert.equal(ref.runId, runId);
		assert.equal(ref.sensitiveOutput, false);
		const { signature, ...unsigned } = ref;
		const digest = await hmacSha256(
			await deriveHkdfHmacKey(
				props.serviceToken,
				WORKFLOW_TEDI_TASK_SIGNATURE_CONTEXT,
			),
			JSON.stringify(SkillWorkflowTediTaskSigningPayloadSchema.parse(unsigned)),
		);
		assert.equal(
			signature,
			Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		);
		assert.equal(calls.filter((method) => method === "tools/call").length, 1);
		assert.equal(
			calls.filter((method) => method === "tasks/get").length,
			pending ? 1 : 0,
		);
	});
}

test("the RPC bridge retains a signed accepted task when the canonical tedi run fails", async () => {
	let taskId = "";
	let runId = "";
	const env = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = (await new Request(input, init).json()) as {
					id: string;
					method: string;
					params: { arguments?: { code: string } };
				};
				if (body.method === "tools/call") {
					runId = nativeRunForProgram(body.params.arguments!.code);
					taskId = `tedi:tedi-1:${runId}`;
				}
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result:
						body.method === "tasks/get"
							? { taskId, status: "failed", error: { message: "test failure" } }
							: {
									structuredContent: {
										ok: true,
										accepted: true,
										pending: true,
										task: { id: taskId, pollWith: "tasks/get" },
									},
								},
				});
			},
		},
	};
	const bridge = Object.assign(new McpBridge(), {
		env,
		ctx: {
			props: {
				...props,
				tediNamespace: "reviewer",
				manifest: { ...manifest, mcp: { tedi: ["run_tedi_turn"] } },
			},
		},
	});
	const outcome = (await bridge.call({
		namespace: "tedi",
		method: "run_tedi_turn",
		workflow,
		args: { text: "Review" },
	})) as {
		__tedixMcpFailure: boolean;
		error: { message: string };
		tediTaskReference: unknown;
	};
	assert.equal(outcome.__tedixMcpFailure, true);
	assert.match(outcome.error.message, /MCP_TASK_FAILED/);
	assert.equal(
		SkillWorkflowTediTaskReferenceSchema.parse(outcome.tediTaskReference).runId,
		runId,
	);
});

test("explicit polling keys reuse one canonical task across steps only inside the same workflow epoch", async () => {
	const nativeTasks = new Map<string, string>();
	const returnedRuns: string[] = [];
	const cases = [
		{
			runId: "workflow-a",
			orgId: "org-1",
			executionEpoch: 0,
			stepName: "dispatch",
		},
		{
			runId: "workflow-a",
			orgId: "org-1",
			executionEpoch: 0,
			stepName: "poll-later",
		},
		{
			runId: "workflow-b",
			orgId: "org-1",
			executionEpoch: 0,
			stepName: "dispatch",
		},
		{
			runId: "workflow-a",
			orgId: "org-1",
			executionEpoch: 1,
			stepName: "dispatch",
		},
		{
			runId: "workflow-a",
			orgId: "org-2",
			executionEpoch: 0,
			stepName: "dispatch",
		},
	];
	for (const scope of cases) {
		const env = {
			MCP_SERVICE: {
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					const body = (await new Request(input, init).json()) as {
						id: string;
						params: { arguments: { code: string } };
					};
					const nativeRun = nativeRunForProgram(body.params.arguments.code);
					if (!nativeTasks.has(nativeRun))
						nativeTasks.set(nativeRun, "one recorded reply");
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							structuredContent: {
								ok: true,
								run_id: nativeRun,
								assistant: { content: nativeTasks.get(nativeRun) },
							},
						},
					});
				},
			},
		} as unknown as Parameters<typeof callMcpTool>[0];
		const result = (await callMcpTool(
			env,
			{
				...props,
				...scope,
				tediNamespace: "reviewer",
				manifest: { ...manifest, mcp: { tedi: ["run_tedi_turn"] } },
			},
			{
				namespace: "tedi",
				method: "run_tedi_turn",
				workflow: { ...workflow, stepName: scope.stepName },
				args: {
					text: "Read the same task",
					client_request_id: "same-poll-key",
				},
			},
		)) as { tediTaskReference: unknown };
		const reference = SkillWorkflowTediTaskReferenceSchema.parse(
			result.tediTaskReference,
		);
		assert.equal(reference.workflowRunId, scope.runId);
		assert.equal(reference.stepName, scope.stepName);
		returnedRuns.push(reference.runId);
	}
	assert.equal(returnedRuns[0], returnedRuns[1]);
	assert.equal(new Set(returnedRuns).size, 4);
	assert.equal(nativeTasks.size, 4);
});

for (const invalid of [
	{ pending: false, id: "unrelated-run" },
	{ pending: true, id: "tedi:tedi-1:unrelated-run" },
	{ pending: true, id: "tedi:other-tedi:unrelated-run" },
]) {
	test(`a returned foreign reference ${invalid.id} is rejected before task polling or signing`, async () => {
		let taskReads = 0;
		const env = {
			MCP_SERVICE: {
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					const body = (await new Request(input, init).json()) as {
						id: string;
						method: string;
					};
					if (body.method === "tasks/get") taskReads++;
					const data = invalid.pending
						? {
								ok: true,
								accepted: true,
								pending: true,
								task: {
									id: invalid.id,
									pollWith: "tasks/get",
								},
							}
						: {
								ok: true,
								run_id: invalid.id,
								assistant: { content: "must not escape" },
							};
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { structuredContent: data },
					});
				},
			},
		} as unknown as Parameters<typeof callMcpTool>[0];
		let reference: unknown;
		await assert.rejects(
			callMcpTool(
				env,
				{
					...props,
					tediNamespace: "reviewer",
					manifest: { ...manifest, mcp: { tedi: ["run_tedi_turn"] } },
				},
				{
					namespace: "tedi",
					method: "run_tedi_turn",
					workflow,
					args: { client_request_id: "reused-key", text: "Review" },
				},
				(value) => {
					reference = value;
				},
			),
			/WORKFLOW_TEDI_TASK_ORIGIN_MISMATCH/,
		);
		assert.equal(reference, undefined);
		assert.equal(taskReads, 0);
	});
}
