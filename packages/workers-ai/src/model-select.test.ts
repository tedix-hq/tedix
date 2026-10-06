import {
	generateObject,
	generateText,
	jsonSchema,
	streamObject,
	streamText,
} from "ai";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	CLOUDFLARE_AUTO_MODEL_REF,
	cloudflareAutoRouterEligible,
	cloudflareAutoRouterModel,
	DEFAULT_WORKERS_AI_MODEL,
	selectWorkersAiModel,
} from "./model-select";

const DEFAULT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

describe("Auto Router structured output contract", () => {
	const schema = jsonSchema<{ answer: string; targetTediId: null }>({
		type: "object",
		properties: { answer: { type: "string" }, targetTediId: { type: "null" } },
		required: ["answer", "targetTediId"],
		additionalProperties: false,
	});

	it.each(["generate", "stream"] as const)(
		"preserves the SDK %s schema",
		async (mode) => {
			const fetchMock = vi.fn(async (_url, init: RequestInit) => {
				const body = JSON.parse(init.body as string);
				expect(body.response_format).toEqual({
					type: "json_schema",
					json_schema: {
						name: "home_route",
						description: "Complete routing decision",
						schema: schema.jsonSchema,
						strict: true,
					},
				});
				return new Response(
					JSON.stringify({
						choices: [
							{
								finish_reason: "stop",
								message: {
									content: JSON.stringify({ answer: "4", targetTediId: null }),
								},
							},
						],
						usage: { prompt_tokens: 12, completion_tokens: 10 },
					}),
				);
			});
			vi.stubGlobal("fetch", fetchMock);
			try {
				const model = cloudflareAutoRouterModel(
					{
						env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
						authorize: async ({ attribution }) => ({ attribution }),
					},
					{ gatewayId: "g" },
				);
				const options = {
					model,
					schema,
					schemaName: "home_route",
					schemaDescription: "Complete routing decision",
					prompt: "2 + 2?",
				};
				if (mode === "generate") {
					expect((await generateObject(options)).object).toEqual({
						answer: "4",
						targetTediId: null,
					});
				} else {
					const result = streamObject(options);
					for await (const _partial of result.partialObjectStream) {
						/* drain */
					}
					expect(await result.object).toEqual({
						answer: "4",
						targetTediId: null,
					});
				}
				expect(fetchMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);

	it("uses JSON mode when no schema was requested", async () => {
		const fetchMock = vi.fn(async (_url, init: RequestInit) => {
			expect(JSON.parse(init.body as string).response_format).toEqual({
				type: "json_object",
			});
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const model = cloudflareAutoRouterModel(
				{
					env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
					authorize: async ({ attribution }) => ({ attribution }),
				},
				{ gatewayId: "g" },
			);
			await model.doGenerate({
				prompt: [],
				responseFormat: { type: "json" },
			} as never);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("selectWorkersAiModel", () => {
	it("falls back to the caller default when no ref is given", () => {
		expect(selectWorkersAiModel(DEFAULT)).toBe(DEFAULT);
		expect(selectWorkersAiModel(DEFAULT, null)).toBe(DEFAULT);
		expect(selectWorkersAiModel(DEFAULT, "")).toBe(DEFAULT);
	});

	it("selects the model id from a valid workers-ai catalog ref", () => {
		expect(
			selectWorkersAiModel(DEFAULT, "workers-ai/@cf/openai/gpt-oss-120b"),
		).toBe("@cf/openai/gpt-oss-120b");
	});

	it("ignores a non-workers-ai provider ref", () => {
		expect(selectWorkersAiModel(DEFAULT, "azure/gpt-5.6-terra")).toBe(DEFAULT);
	});

	it("ignores a workers-ai ref that is not in the catalog", () => {
		expect(
			selectWorkersAiModel(DEFAULT, "workers-ai/@cf/meta/not-a-real-model"),
		).toBe(DEFAULT);
	});

	it("ignores a malformed ref", () => {
		expect(selectWorkersAiModel(DEFAULT, "gpt-oss-120b")).toBe(DEFAULT);
		expect(selectWorkersAiModel(DEFAULT, "/@cf/openai/gpt-oss-120b")).toBe(
			DEFAULT,
		);
		expect(selectWorkersAiModel(DEFAULT, "workers-ai/")).toBe(DEFAULT);
	});

	it("ships a default that is itself a catalog model", () => {
		expect(DEFAULT_WORKERS_AI_MODEL).toBe("@cf/openai/gpt-oss-120b");
		expect(
			selectWorkersAiModel("unused", `workers-ai/${DEFAULT_WORKERS_AI_MODEL}`),
		).toBe(DEFAULT_WORKERS_AI_MODEL);
	});
});

describe("Cloudflare Auto Router eligibility", () => {
	const eligible = {
		surface: "cron",
		authority: "ordinary",
		reproducibility: "adaptive",
		sovereignty: "unconstrained",
	} as const;

	it("requires the exact cloudflare/auto ref and an eligible utility context", () => {
		expect(
			cloudflareAutoRouterEligible(CLOUDFLARE_AUTO_MODEL_REF, eligible),
		).toBe(true);
		expect(
			cloudflareAutoRouterEligible(
				"workers-ai/@cf/openai/gpt-oss-120b",
				eligible,
			),
		).toBe(false);
	});

	it("admits authorized surfaces but rejects explicit model constraints", () => {
		expect(
			cloudflareAutoRouterEligible(CLOUDFLARE_AUTO_MODEL_REF, {
				...eligible,
				surface: "chat",
			}),
		).toBe(true);
		for (const context of [
			{ ...eligible, reproducibility: "fixed-model-required" as const },
			{ ...eligible, sovereignty: "residency-bound" as const },
		]) {
			expect(
				cloudflareAutoRouterEligible(CLOUDFLARE_AUTO_MODEL_REF, context),
			).toBe(false);
		}
	});

	it("meters before calling the documented compat endpoint", async () => {
		const authorize = vi.fn(async ({ attribution }) => ({
			attribution: {
				...attribution,
				billing: "reservation",
			},
		}));
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "done" } }],
						usage: { prompt_tokens: 3, completion_tokens: 1 },
					}),
					{
						headers: {
							"cf-aig-routed-model": "openai/gpt-5.6-luna",
							"cf-aig-routing-reason": "quality_match",
							"cf-aig-routing-decision-id": "decision-1",
							"cf-aig-request-id": "request-1",
						},
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const model = cloudflareAutoRouterModel(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "account",
						CF_AI_GATEWAY_TOKEN: "token",
					},
					authorize,
				},
				{ gatewayId: "gateway", attribution: { source: "cron:test" } },
			);
			const result = await model.doGenerate({
				prompt: [{ role: "user", content: [{ type: "text", text: "work" }] }],
			} as never);
			expect(result.content).toEqual([{ type: "text", text: "done" }]);
			expect(result.providerMetadata).toEqual({
				cloudflareAutoRouter: {
					routedModel: "openai/gpt-5.6-luna",
					routingReason: "quality_match",
					routingDecisionId: "decision-1",
					requestId: "request-1",
				},
			});
			expect(authorize).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const init = fetchMock.mock.calls[0]![1] as RequestInit;
			expect(init.headers).toMatchObject({
				"cf-aig-metadata": JSON.stringify({
					source: "cron:test",
					billing: "reservation",
				}),
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("Auto Router lossless request and result handling", () => {
	it("preserves URL and inline images, tool transcripts, reasoning controls and finish reasons", async () => {
		const fetchMock = vi.fn(async (_url, init: RequestInit) => {
			if (JSON.parse(init.body as string).stream)
				return new Response(
					[
						{
							choices: [
								{
									delta: { reasoning_content: "thinking", content: "answer" },
									finish_reason: "length",
								},
							],
						},
						{ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
					]
						.map((x) => `data: ${JSON.stringify(x)}\n\n`)
						.join("") + "data: [DONE]\n\n",
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			return new Response(
				JSON.stringify({
					choices: [
						{
							finish_reason: "length",
							message: { reasoning_content: "thinking", content: "answer" },
						},
					],
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const model = cloudflareAutoRouterModel(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "a",
						CF_AI_GATEWAY_TOKEN: "t",
						AI_GATEWAY_AUTO_ALLOWED_IMAGE_MODELS:
							"@cf/google/gemma-4-26b-a4b-it",
					},
					authorize: async ({ attribution }) => ({ attribution }),
				},
				{ gatewayId: "g" },
			);
			const call = {
				prompt: [
					{
						role: "user",
						content: [
							{ type: "text", text: "inspect" },
							{
								type: "file",
								mediaType: "image/png",
								data: new URL("https://example.com/image.png"),
							},
							{
								type: "file",
								mediaType: "image/png",
								data: new Uint8Array([1, 2, 3]),
							},
						],
					},
					{
						role: "assistant",
						content: [
							{
								type: "tool-call",
								toolCallId: "call1",
								toolName: "lookup",
								input: { id: 1 },
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								type: "tool-result",
								toolCallId: "call1",
								toolName: "lookup",
								output: { type: "json", value: { ok: true } },
							},
						],
					},
				],
				providerOptions: { cloudflareAutoRouter: { reasoningEffort: "high" } },
			};
			const result = await model.doGenerate(call as never);
			const sent = JSON.parse(
				(fetchMock.mock.calls[0]![1] as RequestInit).body as string,
			);
			expect(sent.messages[0].content).toEqual([
				{ type: "text", text: "inspect" },
				{
					type: "image_url",
					image_url: { url: "https://example.com/image.png" },
				},
				{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
			]);
			expect(sent.messages[1].tool_calls[0]).toMatchObject({
				id: "call1",
				function: { name: "lookup", arguments: '{"id":1}' },
			});
			expect(sent.messages[2]).toMatchObject({
				role: "tool",
				tool_call_id: "call1",
			});
			expect(sent.reasoning_effort).toBe("high");
			expect(result.finishReason).toBe("length");
			const streamed = await model.doStream(call as never);
			const reader = streamed.stream.getReader();
			const parts = [];
			while (true) {
				const item = await reader.read();
				if (item.done) break;
				parts.push(item.value);
			}
			expect(parts).toContainEqual({
				type: "reasoning-delta",
				id: "reasoning-0",
				delta: "thinking",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("rejects unsupported media before billing or dispatch", async () => {
		const authorize = vi.fn();
		const model = cloudflareAutoRouterModel(
			{
				env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
				authorize,
			},
			{ gatewayId: "g" },
		);
		await expect(
			model.doGenerate({
				prompt: [
					{
						role: "user",
						content: [
							{
								type: "file",
								mediaType: "application/pdf",
								data: new Uint8Array([1]),
							},
						],
					},
				],
			} as never),
		).rejects.toThrow(/unsupported|Unsupported/);
		expect(authorize).not.toHaveBeenCalled();
	});
});

describe("Auto Router SDK text streaming", () => {
	it("delivers SDK text before completion and authorizes the actual streaming request", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const encode = (v: unknown) =>
			new TextEncoder().encode(`data: ${JSON.stringify(v)}\n\n`);
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const authorize = vi.fn(async ({ body, attribution }) => {
			expect(JSON.parse(body)).toMatchObject({
				stream: true,
				stream_options: { include_usage: true },
			});
			return { attribution };
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				expect(authorize).toHaveBeenCalledTimes(1);
				return new Response(upstream, {
					headers: {
						"content-type": "text/event-stream",
						"cf-aig-request-id": "sdk-proof",
					},
				});
			}),
		);
		try {
			const result = streamText({
				model: cloudflareAutoRouterModel(
					{
						env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
						authorize,
					},
					{ gatewayId: "g" },
				),
				prompt: "Explain streaming",
			});
			const reader = result.textStream.getReader();
			const early = reader.read();
			controller.enqueue(
				encode({ choices: [{ delta: { content: "Early" } }] }),
			);
			expect((await early).value).toBe("Early");
			controller.enqueue(
				encode({
					choices: [{ delta: { content: " later" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 2 },
				}),
			);
			controller.close();
			expect((await reader.read()).value).toBe(" later");
			expect((await reader.read()).done).toBe(true);
			expect(await result.usage).toMatchObject({
				inputTokens: 5,
				outputTokens: 2,
			});
			expect(await result.providerMetadata).toMatchObject({
				cloudflareAutoRouter: { requestId: "sdk-proof" },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("Auto Router receipt and admission regressions", () => {
	it.each(["generate", "json-stream"] as const)(
		"preserves usage detail and filtered termination for %s",
		async (mode) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								choices: [
									{ finish_reason: "content_filter", message: { content: "" } },
								],
								usage: {
									prompt_tokens: 12,
									completion_tokens: 10,
									prompt_tokens_details: { cached_tokens: 8 },
									completion_tokens_details: { reasoning_tokens: 7 },
								},
							}),
						),
				),
			);
			try {
				const model = cloudflareAutoRouterModel(
					{
						env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
						authorize: async () => ({}),
					},
					{ gatewayId: "g" },
				);
				const call = { prompt: [], responseFormat: { type: "json" } } as never;
				const result =
					mode === "generate"
						? await model.doGenerate(call)
						: await (async () => {
								const reader = (await model.doStream(call)).stream.getReader();
								while (true) {
									const { value, done } = await reader.read();
									if (done) throw new Error("missing finish");
									if (value.type === "finish") return value;
								}
							})();
				expect(result.finishReason).toBe("content-filter");
				expect(result.usage).toMatchObject({
					inputTokens: 12,
					outputTokens: 10,
					totalTokens: 22,
					cachedInputTokens: 8,
					reasoningTokens: 7,
				});
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
	it.each(["invalid-pool", "missing-image-pool", "aborted"])(
		"rejects %s before admission and dispatch",
		async (failure) => {
			const authorize = vi.fn(async () => ({}));
			const send = vi.fn();
			vi.stubGlobal("fetch", send);
			try {
				const model = cloudflareAutoRouterModel(
					{
						env: {
							AI_GATEWAY_ACCOUNT_ID: "a",
							CF_AI_GATEWAY_TOKEN: "t",
							...(failure === "invalid-pool"
								? { AI_GATEWAY_AUTO_ALLOWED_MODELS: "bad,*" }
								: {}),
						},
						authorize,
					},
					{ gatewayId: "g" },
				);
				await expect(
					model.doGenerate({
						prompt:
							failure === "missing-image-pool"
								? [
										{
											role: "user",
											content: [
												{
													type: "file",
													mediaType: "image/png",
													data: new URL("https://example.com/image.png"),
												},
											],
										},
									]
								: [],
						...(failure === "aborted"
							? { abortSignal: AbortSignal.abort() }
							: {}),
					} as never),
				).rejects.toThrow();
				expect(authorize).not.toHaveBeenCalled();
				expect(send).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
	it("preserves unknown termination instead of reporting stop", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							choices: [
								{ finish_reason: "future_reason", message: { content: "" } },
							],
						}),
					),
			),
		);
		try {
			const model = cloudflareAutoRouterModel(
				{
					env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
					authorize: async () => ({}),
				},
				{ gatewayId: "g" },
			);
			expect(
				(await model.doGenerate({ prompt: [] } as never)).finishReason,
			).toBe("unknown");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("Auto model private wire authority", () => {
	it.each(["generate", "stream"] as const)(
		"%s resumes delayed admission into a denied wire boundary",
		async (mode) => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							choices: [{ finish_reason: "stop", message: { content: "ok" } }],
							usage: { prompt_tokens: 1, completion_tokens: 1 },
						}),
					),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				let release!: () => void,
					active = true;
				const barrier = new Promise<void>((resolve) => {
					release = resolve;
				});
				const authorize = vi.fn(async () => {
					await barrier;
					return {};
				});
				const guard = vi.fn(() => {
					if (!active) throw new Error("held");
				});
				const model = cloudflareAutoRouterModel(
					{
						env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
						authorize,
						beforeDispatch: guard,
					},
					{ gatewayId: "gw" },
				);
				const invoke = () =>
					mode === "generate"
						? model.doGenerate({ prompt: [] } as never)
						: model.doStream({ prompt: [] } as never);
				const pending = invoke();
				expect(authorize).toHaveBeenCalledTimes(1);
				active = false;
				release();
				await expect(pending).rejects.toMatchObject({
					phase: "before_dispatch",
					providerRequestSent: false,
				});
				expect(fetchMock).not.toHaveBeenCalled();
				// A fresh explicit call checks the current guard again; no implicit retry is granted by refusal.
				active = true;
				if (mode === "stream") {
					fetchMock.mockImplementation(
						async () =>
							new Response(
								'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
								{ headers: { "content-type": "text/event-stream" } },
							),
					);
				}
				{
					const positive = await invoke();
					if ("stream" in positive) {
						const reader = positive.stream.getReader();
						while (!(await reader.read()).done) {}
					}
					expect(fetchMock).toHaveBeenCalledTimes(1);
					active = false;
					await expect(invoke()).rejects.toMatchObject({
						phase: "before_dispatch",
					});
					expect(fetchMock).toHaveBeenCalledTimes(1);
				}
				const invalid = cloudflareAutoRouterModel(
					{
						env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
						authorize: async () => ({}),
						beforeDispatch: async () => {},
					},
					{ gatewayId: "gw" },
				);
				await expect(
					invalid.doGenerate({ prompt: [] } as never),
				).rejects.toMatchObject({ phase: "before_dispatch" });
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
});

it("AI SDK does not automatically retry a local pre-send refusal", async () => {
	const send = vi.fn();
	vi.stubGlobal("fetch", send);
	try {
		const authorize = vi.fn(async () => ({}));
		const beforeDispatch = vi.fn(() => {
			throw new Error("held");
		});
		const model = cloudflareAutoRouterModel(
			{
				env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
				authorize,
				beforeDispatch,
			},
			{ gatewayId: "g" },
		);
		await expect(
			generateText({ model, prompt: "hi", maxRetries: 2 }),
		).rejects.toMatchObject({
			phase: "before_dispatch",
			providerRequestSent: false,
		});
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(beforeDispatch).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Auto Router request-local authorization", () => {
	for (const mode of ["generate", "stream"] as const) {
		for (const failure of [
			"billing-abort",
			"client-abort",
			"own-abort",
			"async-own",
		] as const) {
			it(`${mode} denies ${failure} before the compat wire`, async () => {
				const send = vi.fn();
				vi.stubGlobal("fetch", send);
				const controller = new AbortController();
				let release!: () => void;
				const barrier = new Promise<void>((resolve) => {
					release = resolve;
				});
				const model = cloudflareAutoRouterModel(
					{
						env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
						beforeDispatch: () => {
							if (failure === "client-abort")
								controller.abort(new Error("client abort"));
						},
						authorize: async () => {
							await barrier;
							return {
								attribution: { issued: "original-unknown" },
								signal: controller.signal,
								beforeDispatch:
									failure === "async-own"
										? async () => {}
										: () => {
												if (failure === "own-abort")
													controller.abort(new Error("own abort"));
											},
							};
						},
					},
					{ gatewayId: "g" },
				);
				try {
					const pending = (
						mode === "generate"
							? model.doGenerate({ prompt: [] } as never)
							: model.doStream({ prompt: [] } as never)
					).catch((error: unknown) => error);
					if (failure === "billing-abort")
						controller.abort(new Error("billing abort"));
					release();
					const error = await pending;
					expect(error).toBeInstanceOf(Error);
					if (failure !== "billing-abort")
						expect(error).toMatchObject({
							name: "ProviderDispatchGuardError",
							providerRequestSent: false,
						});
					expect(send).not.toHaveBeenCalled();
				} finally {
					vi.unstubAllGlobals();
				}
			});
		}
	}
	it("concurrent SDK generations retain their own receipt and signal", async () => {
		const releases = new Map<string, () => void>();
		const signals: AbortSignal[] = [];
		const checks: string[] = [];
		const send = vi.fn(async (_url: unknown, init: RequestInit) => {
			expect(new Headers(init.headers).get("cf-aig-metadata")).toBe(
				'{"issued":"allowed"}',
			);
			signals.push(init.signal!);
			return Response.json({
				choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
			});
		});
		vi.stubGlobal("fetch", send);
		const deniedController = new AbortController(),
			allowedController = new AbortController();
		const model = cloudflareAutoRouterModel(
			{
				env: { AI_GATEWAY_ACCOUNT_ID: "a", CF_AI_GATEWAY_TOKEN: "t" },
				authorize: async ({ body }) => {
					const id = body.includes("denied") ? "denied" : "allowed";
					await new Promise<void>((resolve) => releases.set(id, resolve));
					return {
						attribution: { issued: id },
						signal:
							id === "denied"
								? deniedController.signal
								: allowedController.signal,
						beforeDispatch: () => {
							checks.push(id);
							if (id === "denied") throw new Error("own denied");
						},
					};
				},
			},
			{ gatewayId: "g" },
		);
		try {
			const denied = generateText({
				model,
				prompt: "denied",
				maxRetries: 0,
			}).catch((error: unknown) => error);
			const allowed = generateText({ model, prompt: "allowed", maxRetries: 0 });
			// Wait for both actual SDK calls to reach their authorizers, without elapsed-time assumptions.
			while (releases.size < 2)
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			releases.get("allowed")!();
			expect((await allowed).text).toBe("ok");
			releases.get("denied")!();
			expect(await denied).toMatchObject({
				name: "ProviderDispatchGuardError",
			});
			expect(checks).toEqual(["allowed", "denied"]);
			expect(send).toHaveBeenCalledOnce();
			expect(signals).toEqual([allowedController.signal]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("Auto Router request cancellation before authorization", () => {
	it.each(["generate", "stream"] as const)(
		"%s preserves original signal and stops serialization cancellation before admission",
		async (mode) => {
			const controller = new AbortController();
			const send = vi.fn();
			vi.stubGlobal("fetch", send);
			const authorize = vi.fn(async (input: { signal?: AbortSignal }) => {
				expect(input.signal).toBe(controller.signal);
				throw new Error("stopped at authorization");
			});
			const model = cloudflareAutoRouterModel(
				{
					env: {
						AI_GATEWAY_ACCOUNT_ID: "account",
						CF_AI_GATEWAY_TOKEN: "token",
					},
					authorize,
				},
				{ gatewayId: "gateway" },
			);
			let currentCall: { prompt: unknown[]; abortSignal: AbortSignal };
			const invoke = (extra = {}) => {
				currentCall = { prompt: [], abortSignal: controller.signal, ...extra };
				return mode === "generate"
					? model.doGenerate(currentCall as never)
					: model.doStream(currentCall as never);
			};
			try {
				await expect(invoke()).rejects.toThrow("stopped at authorization");
				expect(authorize).toHaveBeenCalledOnce();
				authorize.mockClear();
				const schema = {
					toJSON() {
						controller.abort(new Error("cancelled during serialization"));
						currentCall.abortSignal = new AbortController().signal;
						return { type: "object" };
					},
				};
				await expect(
					invoke({ responseFormat: { type: "json", schema } }),
				).rejects.toThrow("cancelled during serialization");
				expect(authorize).not.toHaveBeenCalled();
				expect(send).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
});

it("freezes the admitted candidate pool before authorization mutates deployment config", async () => {
	const env = {
		AI_GATEWAY_ACCOUNT_ID: "account",
		CF_AI_GATEWAY_TOKEN: "token",
		AI_GATEWAY_AUTO_ALLOWED_PROVIDERS: "workers-ai",
		AI_GATEWAY_AUTO_ALLOWED_MODELS: "@cf/example/model",
	};
	const send = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			),
	);
	vi.stubGlobal("fetch", send);
	try {
		const model = cloudflareAutoRouterModel(
			{
				env,
				authorize: async ({ execution, attribution }) => {
					expect(execution.autoRouting?.allowedModels).toEqual([
						"@cf/example/model",
					]);
					expect(Object.isFrozen(execution.autoRouting?.allowedModels)).toBe(
						true,
					);
					env.AI_GATEWAY_AUTO_ALLOWED_PROVIDERS = "azure-openai";
					env.AI_GATEWAY_AUTO_ALLOWED_MODELS = "other";
					return { attribution };
				},
			},
			{ gatewayId: "gateway" },
		);
		await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "work" }] }],
		} as never);
		expect((send.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
			"cf-aig-allowed-providers": "workers-ai",
			"cf-aig-allowed-models": "@cf/example/model",
		});
	} finally {
		vi.unstubAllGlobals();
	}
});
