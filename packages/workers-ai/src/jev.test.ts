import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	callJev,
	CLEF_FLASH_MODEL,
	CLEF_MODEL,
	JevResponseError,
	parseJevResult,
	resolveJevExecution,
	type JevClient,
} from "./jev";
const questions = {
	fit: { type: "noul", instructions: "Does this match?" },
	pick: {
		type: "choice",
		instructions: "Choose",
		criteria: { yes: "Relevant", no: "Irrelevant" },
	},
	rank: {
		type: "score",
		instructions: "Relevance",
		criteria: ["Irrelevant", "Partial", "Strong"],
	},
} as const;
const result = () => ({
	model: "jev-1.13.0",
	answers: {
		fit: { type: "noul", noul: 0.8 },
		pick: {
			type: "choice",
			choice: "yes",
			probabilities: { yes: 0.9, no: 0.1 },
			confidence: 0.8,
		},
		rank: {
			type: "score",
			score: 1.8,
			probabilities: { "0": 0, "1": 0.2, "2": 0.8 },
			confidence: 0.7,
			legend: { "0": "Irrelevant", "1": "Partial", "2": "Strong" },
		},
	},
	usage: { input_tokens: 200, output_tokens: 30 },
});
function client(): JevClient {
	return {
		env: {
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_WORKERS_AI_TOKEN: "secret",
		},
		authorize: vi.fn(async () => ({ attribution: { executionId: "receipt" } })),
	};
}
afterEach(() => vi.unstubAllGlobals());
describe("typed Jev transport", () => {
	it("unwraps the completed Cloudflare BYOK execution and preserves provider usage", async () => {
		let correlationId: string | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				correlationId = JSON.parse(
					(init.headers as Record<string, string>)["cf-aig-metadata"]!,
				).decision_trace_id;
				expect(correlationId).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
				);
				return Response.json({
					success: true,
					result: {
						state: "Completed",
						result: result(),
						gatewayMetadata: { keySource: "BYOK" },
					},
				});
			}),
		);
		expect(await callJev(client(), { state: "test", questions })).toEqual({
			...result(),
			gatewayCorrelationId: correlationId,
		});
	});
	it.each(["Running", "Failed"])(
		"rejects a %s Cloudflare execution even with an answer",
		async (state) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json({ success: true, result: { state, result: result() } }),
				),
			);
			await expect(
				callJev(client(), { state: "test", questions }),
			).rejects.toThrow("did not complete");
		},
	);
	it("admits exact identity before native Cloudflare send and preserves usage", async () => {
		const c = client();
		let correlationId: string | undefined;
		const send = vi.fn(async (_url: string, init: RequestInit) => {
			expect(c.authorize).toHaveBeenCalledOnce();
			expect(JSON.parse(init.body as string)).toEqual({
				model: "typesafe/jev",
				input: { state: "test", questions },
			});
			expect(init.headers).toMatchObject({
				"cf-aig-gateway-id": "gateway",
				"cf-aig-collect-log": "true",
				"cf-aig-collect-log-payload": "false",
				"cf-aig-skip-cache": "true",
				"cf-aig-no-wholesale": "true",
			});
			const metadata = JSON.parse(
				(init.headers as Record<string, string>)["cf-aig-metadata"]!,
			);
			expect(Object.keys(metadata)).toEqual(["decision_trace_id"]);
			correlationId = metadata.decision_trace_id;
			expect(correlationId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
			);
			return Response.json({ success: true, result: result() });
		});
		vi.stubGlobal("fetch", send);
		expect(await callJev(c, { state: "test", questions })).toEqual({
			...result(),
			gatewayCorrelationId: correlationId,
		});
		expect(send.mock.calls[0]?.[0]).toBe(
			"https://api.cloudflare.com/client/v4/accounts/account/ai/run",
		);
		expect(c.authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				execution: expect.objectContaining({
					provider: "typesafe",
					apiKind: "typesafe-systemone",
					requestModel: "typesafe/jev",
				}),
			}),
		);
	});
	it("uses only explicitly configured direct transport without fake gateway identity", async () => {
		const c = client();
		c.env = { JEV_TRANSPORT: "direct", TYPESAFE_API_KEY: "direct-secret" };
		const send = vi.fn(async (_url: string, init: RequestInit) => {
			expect(JSON.parse(init.body as string)).toEqual({
				model: "jev-1.13.0",
				state: "test",
				questions,
			});
			expect(init.headers).toEqual({
				Authorization: "Bearer direct-secret",
				"Content-Type": "application/json",
			});
			return Response.json(result());
		});
		vi.stubGlobal("fetch", send);
		expect(await callJev(c, { state: "test", questions })).toEqual(result());
		expect(send.mock.calls[0]?.[0]).toBe(
			"https://api.typesafe.ai/v1/systemone",
		);
		expect(resolveJevExecution(c.env)).toMatchObject({
			gatewayId: null,
			gatewayAccountId: null,
			providerOrigin: "https://api.typesafe.ai",
			transportKind: "direct-https",
		});
	});
	it("does not send rejected, invalid, oversized or pre-aborted requests", async () => {
		const send = vi.fn();
		vi.stubGlobal("fetch", send);
		const c = client();
		await expect(
			callJev(c, { state: "test", questions: {} }),
		).rejects.toThrow();
		await expect(
			callJev(c, { state: "x".repeat(30_001), questions }),
		).rejects.toThrow();
		await expect(
			callJev(c, { state: "test", questions, signal: AbortSignal.abort() }),
		).rejects.toThrow();
		expect(c.authorize).not.toHaveBeenCalled();
		c.authorize = vi.fn(async () => {
			throw new Error("denied");
		});
		await expect(callJev(c, { state: "test", questions })).rejects.toThrow(
			"denied",
		);
		expect(send).not.toHaveBeenCalled();
	});
	it.each([401, 402, 422, 429, 529])(
		"returns HTTP %s without retry, fallback or leaking provider body",
		async (status) => {
			const send = vi.fn(
				async () => new Response("sensitive body", { status }),
			);
			vi.stubGlobal("fetch", send);
			await expect(
				callJev(client(), { state: "test", questions }),
			).rejects.toMatchObject({
				status,
				message: `Jev returned HTTP ${status}`,
			});
			expect(send).toHaveBeenCalledOnce();
		},
	);
	it("exposes a distinct opaque correlation on HTTP and semantic failures without leaking provider data", async () => {
		const responses = [
			new Response("private provider payload", { status: 429 }),
			new Response("private provider payload", { status: 200 }),
			Response.json({ success: false, errors: ["private provider payload"] }),
			Response.json({ success: true, result: { state: "Failed" } }),
			Response.json({ success: true, result: { ...result(), answers: {} } }),
		];
		const sentIds: string[] = [];
		const send = vi.fn(async (_url: string, init: RequestInit) => {
			const metadata = JSON.parse(
				(init.headers as Record<string, string>)["cf-aig-metadata"]!,
			);
			expect(Object.keys(metadata)).toEqual(["decision_trace_id"]);
			sentIds.push(metadata.decision_trace_id);
			return responses.shift()!;
		});
		vi.stubGlobal("fetch", send);
		for (let i = 0; i < 5; i++) {
			try {
				await callJev(client(), { state: "private prompt", questions });
				throw new Error("accepted");
			} catch (error) {
				expect(error).toBeInstanceOf(JevResponseError);
				const receipt = error as JevResponseError;
				expect(receipt.gatewayCorrelationId).toBe(sentIds[i]);
				expect(receipt.message).not.toContain("private");
			}
		}
		expect(new Set(sentIds).size).toBe(5);
		expect(send).toHaveBeenCalledTimes(5);
	});
	it("joins canonical admission to the Gateway trace without forwarding private attribution", async () => {
		const c = client();
		const executionId = "12345678-1234-4123-8123-123456789abc";
		c.authorize = vi.fn(async () => ({
			attribution: {
				orgId: "private-org",
				attribution: JSON.stringify({
					v: 3,
					r: "private-run",
					w: "private-work",
					e: executionId,
					b: "private-reservation",
				}),
			},
		}));
		const send = vi.fn(async (_url: string, init: RequestInit) => {
			expect(c.authorize).toHaveBeenCalledOnce();
			expect(
				JSON.parse(new Headers(init.headers).get("cf-aig-metadata")!),
			).toEqual({ decision_trace_id: executionId });
			return Response.json({ success: true, result: result() });
		});
		vi.stubGlobal("fetch", send);
		expect(
			await callJev(c, { state: "private prompt", questions }),
		).toMatchObject({ gatewayCorrelationId: executionId });
		expect(send).toHaveBeenCalledOnce();
	});
	it.each(["http", "json", "envelope", "incomplete", "semantic"])(
		"preserves admitted execution trace on %s failure",
		async (failure) => {
			const c = client();
			const executionId = "12345678-1234-4123-8123-123456789abc";
			c.authorize = vi.fn(async () => ({
				attribution: {
					attribution: JSON.stringify({
						v: 3,
						r: "private-run",
						w: "private-work",
						e: executionId,
					}),
				},
			}));
			const responses: Record<string, () => Response> = {
				http: () => new Response("private payload", { status: 429 }),
				json: () => new Response("private payload", { status: 200 }),
				envelope: () => Response.json({ success: false }),
				incomplete: () =>
					Response.json({ success: true, result: { state: "Failed" } }),
				semantic: () =>
					Response.json({
						success: true,
						result: { ...result(), answers: {} },
					}),
			};
			const send = vi.fn(async (_url: string, init: RequestInit) => {
				expect(
					JSON.parse(new Headers(init.headers).get("cf-aig-metadata")!),
				).toEqual({ decision_trace_id: executionId });
				return responses[failure]!();
			});
			vi.stubGlobal("fetch", send);
			await expect(
				callJev(c, { state: "private prompt", questions }),
			).rejects.toMatchObject({
				name: "JevResponseError",
				gatewayCorrelationId: executionId,
			});
			expect(c.authorize).toHaveBeenCalledOnce();
			expect(send).toHaveBeenCalledOnce();
		},
	);
	it("keeps standalone no-op admission independent of caller-supplied execution metadata", async () => {
		const c = client();
		c.authorize = vi.fn(async () => ({}));
		const send = vi.fn(async () => Response.json(result()));
		vi.stubGlobal("fetch", send);
		const response = await callJev(c, {
			state: "test",
			questions,
			attribution: {
				attribution: JSON.stringify({
					v: 3,
					r: "caller-run",
					w: "caller-work",
					e: "caller-forged",
				}),
			},
		});
		expect(response.gatewayCorrelationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(response.gatewayCorrelationId).not.toBe("caller-forged");
		expect(c.authorize).toHaveBeenCalledOnce();
	});
	it("bounds stalled requests and cancels upstream", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason),
							{ once: true },
						);
					}),
			),
		);
		await expect(
			callJev(client(), { state: "test", questions, timeoutMs: 5 }),
		).rejects.toThrow("timed out");
	});
	it.each([
		[CLEF_MODEL, "clef"],
		[CLEF_FLASH_MODEL, "clef-flash"],
	] as const)(
		"calls the hosted %s decision model with exact identity and response pinning",
		async (model, responseModel) => {
			const c = client();
			const send = vi.fn(async (url: string, init: RequestInit) => {
				expect(new Headers(init.headers).has("cf-aig-no-wholesale")).toBe(
					false,
				);
				expect(url).toBe(
					`https://api.cloudflare.com/client/v4/accounts/account/ai/run/${model}`,
				);
				expect(JSON.parse(init.body as string)).toEqual({
					model: responseModel,
					state: "test",
					questions,
				});
				return Response.json({ ...result(), model: responseModel });
			});
			vi.stubGlobal("fetch", send);
			expect(
				await callJev(c, { model, state: "test", questions }),
			).toMatchObject({ model: responseModel });
			expect(c.authorize).toHaveBeenCalledWith(
				expect.objectContaining({
					execution: expect.objectContaining({
						provider: "workers-ai",
						requestModel: model,
						transportKind: "gateway-https",
					}),
				}),
			);
		},
	);
	it("rejects hosted model mismatch and direct Clef before admission", async () => {
		const c = client();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ...result(), model: "clef-flash" })),
		);
		await expect(
			callJev(c, { model: CLEF_MODEL, state: "test", questions }),
		).rejects.toThrow("Invalid Jev response");
		c.env.JEV_TRANSPORT = "direct";
		c.authorize = vi.fn();
		await expect(
			callJev(c, { model: CLEF_MODEL, state: "test", questions }),
		).rejects.toThrow("Direct transport supports only TypeSafe Jev");
		expect(c.authorize).not.toHaveBeenCalled();
	});
	it("rejects an unrecognized decision model before admission", async () => {
		const c = client();
		c.authorize = vi.fn();
		await expect(
			callJev(c, {
				model: "@cf/cloudflare/not-clef" as typeof CLEF_MODEL,
				state: "test",
				questions,
			}),
		).rejects.toThrow();
		expect(c.authorize).not.toHaveBeenCalled();
	});
});
describe("Jev response validation", () => {
	it.each([
		(value: ReturnType<typeof result>) => {
			value.answers.pick.choice = "invented";
		},
		(value: ReturnType<typeof result>) => {
			value.answers.pick.probabilities.yes = 0.2;
		},
		(value: ReturnType<typeof result>) => {
			value.answers.fit.noul = Number.NaN;
		},
		(value: ReturnType<typeof result>) => {
			value.answers.rank.score = 4;
		},
		(value: ReturnType<typeof result>) => {
			value.answers.rank.legend["0"] = "changed";
		},
		(value: ReturnType<typeof result>) => {
			Object.assign(value.answers, { injected: { type: "noul", noul: 1 } });
		},
	])("rejects invalid answer but retains incurred usage", (mutate) => {
		const value = result();
		mutate(value);
		try {
			parseJevResult(value, questions);
			throw new Error("accepted");
		} catch (error) {
			expect(error).toBeInstanceOf(JevResponseError);
			expect((error as JevResponseError).usage).toEqual(value.usage);
		}
	});
	it("rejects missing or invalid usage", () => {
		const value = result();
		value.usage.input_tokens = -1;
		expect(() => parseJevResult(value, questions)).toThrow();
	});
});

it("retains usage but rejects a direct response from a different model", async () => {
	const c = client();
	c.env = { JEV_TRANSPORT: "direct", TYPESAFE_API_KEY: "key" };
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ...result(), model: "jev-2.0.0" })),
	);
	await expect(callJev(c, { state: "test", questions })).rejects.toMatchObject({
		usage: result().usage,
		message: "Jev returned a different model than the pinned request",
	});
});

describe("Jev private wire authority", () => {
	it.each(["cloudflare", "direct"] as const)(
		"%s denies revoked authority after delayed admission without a fabricated Jev receipt",
		async (route) => {
			const send = vi.fn(async () => new Response(JSON.stringify(result())));
			vi.stubGlobal("fetch", send);
			let release!: () => void,
				active = true;
			const ready = new Promise<void>((resolve) => {
				release = resolve;
			});
			const authorize = vi.fn(async () => {
				await ready;
				return { attribution: { reservation: "original-unresolved" } };
			});
			const beforeDispatch = vi.fn(() => {
				if (!active) throw new Error("held");
			});
			const c = { ...client(), authorize, beforeDispatch };
			if (route === "direct") {
				c.env.JEV_TRANSPORT = "direct";
				c.env.TYPESAFE_API_KEY = "direct-token";
			}
			const pending = callJev(c, { state: "original", questions });
			expect(authorize).toHaveBeenCalledTimes(1);
			active = false;
			release();
			const error = await pending.catch((error) => error);
			expect(error).toMatchObject({
				name: "ProviderDispatchGuardError",
				phase: "before_dispatch",
				providerRequestSent: false,
			});
			expect(error).not.toBeInstanceOf(JevResponseError);
			expect(error).not.toHaveProperty("usage");
			expect(error).not.toHaveProperty("gatewayCorrelationId");
			expect(send).not.toHaveBeenCalled();
			active = true;
			expect(
				(await callJev(c, { state: "original", questions })).answers.fit.noul,
			).toBe(0.8);
			active = false;
			await expect(
				callJev(c, { state: "original", questions }),
			).rejects.toMatchObject({ phase: "before_dispatch" });
			expect(send).toHaveBeenCalledTimes(1);
			expect(beforeDispatch).toHaveBeenCalledTimes(3);
			await expect(
				callJev(
					{
						...c,
						beforeDispatch: async () => {
							throw new Error("bad async");
						},
					},
					{ state: "original", questions },
				),
			).rejects.toMatchObject({ phase: "before_dispatch" });
			expect(send).toHaveBeenCalledTimes(1);
		},
	);
});

describe("Jev request-local authorization", () => {
	for (const route of ["byok", "direct"] as const) {
		for (const failure of [
			"billing-abort",
			"client-abort",
			"own-abort",
			"async-own",
		] as const) {
			it(`${route} denies ${failure} without provider dispatch`, async () => {
				const send = vi.fn();
				vi.stubGlobal("fetch", send);
				const controller = new AbortController();
				let release!: () => void;
				const barrier = new Promise<void>((resolve) => {
					release = resolve;
				});
				const c = client();
				if (route === "direct") {
					c.env.JEV_TRANSPORT = "direct";
					c.env.TYPESAFE_API_KEY = "test-direct";
				}
				c.beforeDispatch = () => {
					if (failure === "client-abort")
						controller.abort(new Error("client abort"));
				};
				c.authorize = async () => {
					await barrier;
					return {
						attribution: { private: "unchanged-unknown" },
						signal: controller.signal,
						beforeDispatch:
							failure === "async-own"
								? async () => {}
								: () => {
										if (failure === "own-abort")
											controller.abort(new Error("own abort"));
									},
					};
				};
				const pending = callJev(c, { state: "original", questions }).catch(
					(error: unknown) => error,
				);
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
			});
		}
		it(`${route} keeps concurrent envelopes isolated`, async () => {
			const c = client();
			if (route === "direct") {
				c.env.JEV_TRANSPORT = "direct";
				c.env.TYPESAFE_API_KEY = "test-direct";
			}
			const releases = new Map<string, () => void>();
			const checks: string[] = [];
			const allowedController = new AbortController();
			const send = vi.fn(async (_url: unknown, init: RequestInit) => {
				expect(init.signal).toBeInstanceOf(AbortSignal);
				return Response.json(
					route === "direct"
						? { ...result(), model: "jev-1.13.0" }
						: { success: true, result: result() },
				);
			});
			vi.stubGlobal("fetch", send);
			c.authorize = async ({ body }) => {
				const id = body!.includes("denied") ? "denied" : "allowed";
				await new Promise<void>((resolve) => releases.set(id, resolve));
				return {
					signal: allowedController.signal,
					beforeDispatch: () => {
						checks.push(id);
						if (id === "denied") throw new Error("own denied");
					},
				};
			};
			const denied = callJev(c, { state: "denied", questions }).catch(
				(error: unknown) => error,
			);
			const allowed = callJev(c, { state: "allowed", questions });
			releases.get("allowed")!();
			await allowed;
			releases.get("denied")!();
			expect(await denied).toMatchObject({
				name: "ProviderDispatchGuardError",
				providerRequestSent: false,
			});
			expect(checks).toEqual(["allowed", "denied"]);
			expect(send).toHaveBeenCalledOnce();
		});
	}
});

describe("Jev original request cancellation at authorization", () => {
	it.each(["cloudflare", "direct"] as const)(
		"%s forwards original signal and refuses serialization cancellation before admission",
		async (route) => {
			const controller = new AbortController();
			const send = vi.fn();
			vi.stubGlobal("fetch", send);
			const c = client();
			if (route === "direct") {
				c.env.JEV_TRANSPORT = "direct";
				c.env.TYPESAFE_API_KEY = "direct-token";
			}
			const authorize = vi.fn(async (input: { signal?: AbortSignal }) => {
				expect(input.signal).toBe(controller.signal);
				throw new Error("stopped at authorization");
			});
			c.authorize = authorize;
			await expect(
				callJev(c, { state: "test", questions, signal: controller.signal }),
			).rejects.toThrow("stopped at authorization");
			expect(authorize).toHaveBeenCalledOnce();
			authorize.mockClear();
			const serializable = { ...questions };
			const request = {
				state: "test",
				questions: serializable,
				signal: controller.signal,
			};
			Object.defineProperty(serializable, "toJSON", {
				value() {
					controller.abort(new Error("cancelled during serialization"));
					request.signal = new AbortController().signal;
					return { ...questions };
				},
			});
			await expect(callJev(c, request)).rejects.toThrow(
				"cancelled during serialization",
			);
			expect(authorize).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
		},
	);
});
