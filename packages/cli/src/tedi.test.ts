import { describe, expect, test, spyOn, afterEach } from "bun:test";
import type { CommandContext } from "./commands";
import type { TedixHomeClient } from "./home-client";
import type { AuthResolution, CliOptions } from "./shared";
import { runTediCommand } from "./tedi";

afterEach(() => {
	timeoutSpy?.mockRestore();
	timeoutSpy = undefined;
});
let timeoutSpy: ReturnType<typeof spyOn> | undefined;

const CRO_ID = "5eed0043-0000-4000-8000-000000000043";

function makeOptions(): CliOptions {
	return {
		conversationId: "home:cli:test",
		follow: false,
		includeArchived: false,
		json: true,
		noColor: true,
		poll: false,
		pollIntervalMs: 1,
		pollTimeoutMs: 1_000,
		repoContext: false,
		requireCodeProof: false,
		requireWorkstation: false,
		url: "https://tedix-unified.mcp.tedix.dev/mcp",
	};
}

function makeContext(input: {
	onRunCode: (source: string) => Promise<unknown>;
	onSend: (content: string) => Promise<void>;
	onCallOptions?: (options: {
		retryable?: boolean;
		signal?: AbortSignal;
	}) => void;
}): CommandContext {
	return {
		client: {
			runCode: input.onRunCode,
			callTool: async (
				name: string,
				args: { code: string },
				options: { retryable?: boolean; signal?: AbortSignal },
			) => {
				expect(name).toBe("code");
				input.onCallOptions?.(options);
				return input.onRunCode(args.code);
			},
		} as unknown as TedixHomeClient,
		color: { enabled: false },
		conversationId: "home:cli:test",
		follow: false,
		includeArchived: false,
		json: true,
		ops: {
			childEvidence: async () => ({}),
			childTree: async () => ({}),
			inspect: async () => ({}) as never,
			send: async (content) => {
				await input.onSend(content);
				return {
					assistantText: "queued",
					homeRunId: "home-run-1",
					status: "completed",
				};
			},
		},
		pollIntervalMs: 1,
	};
}

const AUTH = { headers: {}, source: "test" } satisfies AuthResolution;

describe("runTediCommand ask", () => {
	test("resolves a slug and sends an explicit delegation without rewriting the request", async () => {
		const options = makeOptions();
		let source = "";
		let observedDelegate: string | undefined;
		let observedContent = "";
		const ctx = makeContext({
			onRunCode: async (value) => {
				source = value;
				return {
					executionId: "code-execution-1",
					result: JSON.stringify(CRO_ID),
				};
			},
			onSend: async (content) => {
				observedDelegate = options.delegateToTediId;
				observedContent = content;
			},
		});

		expect(
			await runTediCommand(
				"cro ask Summarize the Acme discovery evidence",
				ctx,
				options,
				AUTH,
			),
		).toBe(0);
		expect(source).toContain("tedis.list_tedis");
		expect(source).toContain('target = "cro"');
		expect(source).toContain("tedi.slug === target");
		expect(source).toContain("offset += 100");
		expect(observedDelegate).toBe(CRO_ID);
		expect(observedContent).toBe("Summarize the Acme discovery evidence");
		expect(options.delegateToTediId).toBeUndefined();
	});

	test("verifies an explicit UUID through the selected organization gateway", async () => {
		const options = makeOptions();
		let observedDelegate: string | undefined;
		const ctx = makeContext({
			onRunCode: async (source) => {
				expect(source).toContain("tedis.get_tedi");
				expect(source).toContain(CRO_ID);
				return CRO_ID;
			},
			onSend: async () => {
				observedDelegate = options.delegateToTediId;
			},
		});

		expect(
			await runTediCommand(
				`${CRO_ID} ask Return one result`,
				ctx,
				options,
				AUTH,
			),
		).toBe(0);
		expect(observedDelegate).toBe(CRO_ID);
		expect(options.delegateToTediId).toBeUndefined();
	});

	test("fails clearly when a slug cannot be resolved", async () => {
		const options = makeOptions();
		const ctx = makeContext({
			onRunCode: async () => null,
			onSend: async () => {
				throw new Error("must not send");
			},
		});

		expect(
			runTediCommand("missing ask Do work", ctx, options, AUTH),
		).rejects.toThrow("Tedi not found in the selected organization: missing");
		expect(options.delegateToTediId).toBeUndefined();
	});
	test("does not delegate when the selected organization denies UUID access", async () => {
		let sent = false;
		const options = makeOptions();
		const ctx = makeContext({
			onRunCode: async () => {
				throw new Error("Organization mismatch");
			},
			onSend: async () => {
				sent = true;
			},
		});
		await expect(
			runTediCommand(`${CRO_ID} ask Do work`, ctx, options, AUTH),
		).rejects.toThrow("Organization mismatch");
		expect(sent).toBe(false);
		expect(options.delegateToTediId).toBeUndefined();
	});

	test("does not delegate after a permission denial", async () => {
		let sent = false;
		const ctx = makeContext({
			onRunCode: async () => {
				throw new Error("Required scope: mcp:tedis.read");
			},
			onSend: async () => {
				sent = true;
			},
		});
		await expect(
			runTediCommand("cro ask Do work", ctx, makeOptions(), AUTH),
		).rejects.toThrow("mcp:tedis.read");
		expect(sent).toBe(false);
	});

	test("paginates authorized workers and ignores partial slug matches", async () => {
		const offsets: number[] = [];
		let delegate: string | undefined;
		const options = makeOptions();
		const ctx = makeContext({
			onRunCode: async (source) => {
				const tedis = {
					list_tedis: async (input: {
						search: string;
						offset: number;
						limit: number;
					}) => {
						expect(input.search).toBe("cro");
						expect(input.limit).toBe(100);
						offsets.push(input.offset);
						return input.offset === 0
							? {
									data: [{ slug: "other-cro", id: "wrong" }],
									pagination: { hasMore: true },
								}
							: {
									data: [{ slug: "cro", id: CRO_ID }],
									pagination: { hasMore: false },
								};
					},
				};
				return await new Function("tedis", `return (${source})();`)(tedis);
			},
			onSend: async () => {
				delegate = options.delegateToTediId;
			},
		});
		expect(await runTediCommand("cro ask Do work", ctx, options, AUTH)).toBe(0);
		expect(offsets).toEqual([0, 100]);
		expect(delegate).toBe(CRO_ID);
	});
});

describe("direct worker routing", () => {
	test("returns failure when the worker's durable execution reports an error", async () => {
		let calls = 0;
		const ctx = makeContext({
			onRunCode: async () =>
				calls++ === 0
					? CRO_ID
					: {
							executionId: "gateway-execution",
							result: JSON.stringify({
								executionId: "exec_worker_error",
								status: "error",
								error: "Code failed",
							}),
						},
			onSend: async () => {
				throw new Error("unexpected send");
			},
		});
		expect(
			await runTediCommand("cro code async () => 1", ctx, makeOptions(), AUTH),
		).toBe(2);
	});
	test.each([
		["code async () => 1", "run_tedi_durable_code", { code: "async () => 1" }],
		["executions", "list_tedi_code_executions", { limit: 20 }],
		[
			"recover-code exec_123_uuid",
			"recover_tedi_code_execution",
			{ executionId: "exec_123_uuid" },
		],
		[
			"execution exec_123_uuid",
			"get_tedi_code_execution",
			{ executionId: "exec_123_uuid" },
		],
		[
			"approve-code exec_123_uuid",
			"approve_tedi_code_execution",
			{ executionId: "exec_123_uuid" },
		],
		[
			"reject-code exec_123_uuid 2",
			"reject_tedi_code_execution",
			{ executionId: "exec_123_uuid", seq: 2 },
		],
		[
			"rollback-code exec_123_uuid",
			"rollback_tedi_code_execution",
			{ executionId: "exec_123_uuid" },
		],
	])(
		"routes %s through the selected organization gateway with UUID ownership",
		async (command, tool, input) => {
			let calls = 0;
			let timedCalls = 0;
			timeoutSpy = spyOn(AbortSignal, "timeout");
			const ctx = makeContext({
				onCallOptions: (options) => {
					timedCalls++;
					expect(timeoutSpy).toHaveBeenCalledWith(330000);
					expect(options.retryable).toBe(false);
					expect(options.signal).toBeInstanceOf(AbortSignal);
					expect(options.signal?.aborted).toBe(false);
				},
				onRunCode: async (source) => {
					if (calls++ === 0) return CRO_ID;
					const tedis = {
						[tool]: async (args: unknown) => {
							expect(args).toEqual({ ...input, tediId: CRO_ID });
							if (tool === "recover_tedi_code_execution")
								return {
									recovered: true,
									execution_id: "exec_123_uuid",
									execution_status: "error",
									completion: "unconfirmed",
									effects_may_have_occurred: true,
								};
							return {
								status: "completed",
								executionId: "exec_123_uuid",
								result: 1,
							};
						},
					};
					const native = await new Function("tedis", `return (${source})();`)(
						tedis,
					);
					return {
						executionId: "gateway-execution",
						result: JSON.stringify(native),
					};
				},
				onSend: async () => {
					throw new Error("unexpected Home delegation");
				},
			});
			expect(
				await runTediCommand(`${CRO_ID} ${command}`, ctx, makeOptions(), AUTH),
			).toBe(0);
			expect(calls).toBe(2);
			expect(timedCalls).toBe(
				/^(code|approve-code|rollback-code) /.test(command) ? 1 : 0,
			);
		},
	);
	test.each(["2junk", "-1", "9007199254740992"])(
		"rejects invalid sequence %s before gateway dispatch",
		async (seq) => {
			const ctx = makeContext({
				onRunCode: async () => {
					throw new Error("unexpected gateway request");
				},
				onSend: async () => {
					throw new Error("unexpected send");
				},
			});
			await expect(
				runTediCommand(
					`cro reject-code exec_123_uuid ${seq}`,
					ctx,
					makeOptions(),
					AUTH,
				),
			).rejects.toThrow("non-negative pending seq");
		},
	);
	test("rejects an unselected worker before reading tokens or dispatching to its host", async () => {
		let tokensRead = false;
		const auth = {
			headers: {},
			source: "test",
			oauthProvider: {
				tokens: async () => {
					tokensRead = true;
					return undefined;
				},
			},
		} as unknown as AuthResolution;
		const ctx = makeContext({
			onRunCode: async () => null,
			onSend: async () => {
				throw new Error("unexpected send");
			},
		});
		await expect(
			runTediCommand("customer-worker executions", ctx, makeOptions(), auth),
		).rejects.toThrow("Tedi not found in the selected organization");
		expect(tokensRead).toBe(false);
	});
});

test.each([true, false])(
	"reports recovery outcome %s without treating native error status as CLI failure",
	async (recovered) => {
		let calls = 0;
		const ctx = makeContext({
			onRunCode: async () =>
				calls++ === 0
					? CRO_ID
					: {
							executionId: "gateway",
							result: JSON.stringify({
								recovered,
								execution_status: "error",
								execution_id: "exec_recovery",
								completion: "unconfirmed",
								effects_may_have_occurred: true,
							}),
						},
			onSend: async () => {
				throw new Error("Unexpected delegation");
			},
		});
		expect(
			await runTediCommand(
				`${CRO_ID} recover-code exec_recovery`,
				ctx,
				makeOptions(),
				AUTH,
			),
		).toBe(recovered ? 0 : 2);
	},
);
