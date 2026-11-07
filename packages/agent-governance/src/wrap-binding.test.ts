import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { hashArguments, hashValue } from "./hash";
import { createInMemoryAdapters } from "./in-memory";
import { CallRefusedError, wrapBinding } from "./wrap-binding";
import type { MethodPolicy } from "./wrap-binding";

const actor = { id: "agent-1", kind: "agent" };
const source = { surface: "test" };

function cyclic() {
	const value: { self?: unknown; count: number } = { count: 1 };
	value.self = value;
	return value;
}

afterEach(() => vi.restoreAllMocks());

describe("one record per binding invocation", () => {
	for (const [name, args] of [
		["JSON", { value: 1 }],
		["cyclic", cyclic()],
		["BigInt", { value: 42n }],
	] as const) {
		for (const path of [
			"allowed",
			"denied",
			"approval",
			"before",
			"execute",
			"after",
			"undo",
			"observer",
			"check",
		] as const) {
			it(`${name} arguments: ${path}`, async () => {
				const adapters = createInMemoryAdapters({
					policies: {
						tool: {
							riskTier: "read",
							disposition:
								path === "denied"
									? "deny"
									: path === "approval"
										? "ask"
										: "allow",
						},
					},
				});
				const failure = new Error(`${path} failed`);
				const fail = () => {
					throw failure;
				};
				const before = vi.fn(async () => {
					if (path === "before") throw failure;
					return { revisionId: "before" };
				});
				const execute = vi.fn(async (_args: unknown) => {
					if (path === "execute") throw failure;
					return "ok";
				});
				if (path === "check")
					vi.spyOn(adapters.compliance, "check").mockRejectedValue(failure);
				const append = vi.spyOn(adapters.accountability, "append");
				const record = vi.spyOn(adapters.compliance, "record");
				const onRecorded = vi.fn(path === "observer" ? fail : () => {});
				const policy: MethodPolicy = {
					before,
					after: path === "after" ? fail : undefined,
					undo: path === "undo" ? fail : undefined,
				};
				const wrapped = wrapBinding(
					{ run: execute },
					{
						...adapters,
						actor,
						source,
						resource: "tool",
						methods: { run: policy },
						onRecorded,
					},
				);
				const invocation = wrapped.run(args);
				if (["denied", "approval", "before", "check"].includes(path)) {
					await expect(invocation).rejects.toBeInstanceOf(CallRefusedError);
					expect(execute).not.toHaveBeenCalled();
				} else if (["execute", "after", "undo"].includes(path)) {
					await expect(invocation).rejects.toBe(failure);
				} else {
					await expect(invocation).resolves.toBe("ok");
				}
				expect(append).toHaveBeenCalledTimes(1);
				expect(record).toHaveBeenCalledTimes(1);
				expect(onRecorded).toHaveBeenCalledTimes(1);
				const rows = await adapters.accountability.list();
				expect(rows).toHaveLength(1);
				expect(adapters.compliance.outcomes).toHaveLength(1);
				expect(rows[0]?.argsHash).toMatch(/^[a-f0-9]{64}$/);
				const outcome =
					path === "approval"
						? "needs_approval"
						: ["denied", "before", "check"].includes(path)
							? "denied"
							: ["execute", "after", "undo"].includes(path)
								? "unknown"
								: "applied";
				expect(rows[0]?.outcome).toBe(outcome);
				if (["before", "check"].includes(path)) {
					expect(rows[0]?.decision).toMatchObject({
						verdict: "deny",
						reason: `preflight_failed: ${path} failed`,
					});
					expect(adapters.compliance.outcomes[0]?.outcome).toMatchObject({
						status: "not_applied",
					});
				}
				if (["denied", "approval", "check"].includes(path))
					expect(before).not.toHaveBeenCalled();
			});
		}
	}

	it.each(["digest", "getter"])(
		"records a denial when %s prevents hashing",
		async (path) => {
			const adapters = createInMemoryAdapters();
			if (path === "digest")
				vi.spyOn(crypto.subtle, "digest").mockRejectedValue(
					new Error("digest unavailable"),
				);
			const args =
				path === "getter"
					? {
							get value() {
								throw new Error("unreadable");
							},
						}
					: {};
			const execute = vi.fn(async (_args: unknown) => "ok");
			const wrapped = wrapBinding(
				{ run: execute },
				{ ...adapters, actor, source, resource: "tool" },
			);
			await expect(wrapped.run(args)).rejects.toBeInstanceOf(CallRefusedError);
			expect(execute).not.toHaveBeenCalled();
			const rows = await adapters.accountability.list();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				argsHash: "unavailable",
				outcome: "denied",
			});
			expect(adapters.compliance.outcomes).toHaveLength(1);
		},
	);
});

describe("argument hash fallback", () => {
	it("preserves existing JSON hashes", async () => {
		expect(await hashArguments([{ b: 2, a: 1 }])).toBe(
			await hashValue([{ a: 1, b: 2 }]),
		);
	});

	it("hashes cycles deterministically without mutating arguments", async () => {
		const first = cyclic();
		const second: { count: number; self?: unknown } = {
			self: undefined,
			count: 1,
		};
		second.self = second;
		expect(await hashArguments([first])).toBe(await hashArguments([second]));
		expect(first.self).toBe(first);
		second.count = 2;
		expect(await hashArguments([first])).not.toBe(
			await hashArguments([second]),
		);
	});

	it("distinguishes BigInt from strings and numbers", async () => {
		const digest = await hashArguments([42n]);
		expect(digest).toBe(await hashArguments([42n]));
		expect(digest).not.toBe(await hashArguments(["42"]));
		expect(digest).not.toBe(await hashArguments([42]));
	});
});
