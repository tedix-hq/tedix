import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMcpServer } from "@tedix/mcp-shared/server";
import { StatelessMcpTransport, mountMcp } from "@tedix/mcp-shared/transport";
import { CatalogAdmission, CatalogRequestLifetime } from "./catalog-admission";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const request = (signal?: AbortSignal) =>
	new Request("https://fixture.mcp.test/mcp", { signal });
const flush = async () => {
	for (let n = 0; n < 10; n++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("hydrated catalog admission", () => {
	it("preserves the SDK registration and handler invocation receivers", async () => {
		let registered!: (
			this: { marker: string },
			value: string,
		) => Promise<string>;
		let registrationReceiver: unknown;
		const server = {
			server: {
				setRequestHandler(
					this: unknown,
					_method: string,
					handler: typeof registered,
				) {
					registrationReceiver = this;
					registered = handler;
				},
			},
			close: async () => {},
		};
		const lifetime = new CatalogRequestLifetime(() => {});
		lifetime.attach(server as unknown as Parameters<typeof lifetime.attach>[0]);
		server.server.setRequestHandler("fixture", async function (value) {
			return this.marker + value;
		});
		expect(registrationReceiver).toBe(server.server);
		expect(await registered.call({ marker: "receiver:" }, "value")).toBe(
			"receiver:value",
		);
	});

	it("serves nine requests FIFO with only one operation active", async () => {
		const admission = new CatalogAdmission();
		const order: number[] = [];
		let active = 0;
		let peak = 0;
		const queued: boolean[] = [];
		await Promise.all(
			Array.from({ length: 9 }, async (_, index) => {
				const response = await admission.run(
					request(),
					async (_lifetime, waited) => {
						active++;
						peak = Math.max(peak, active);
						order.push(index);
						queued.push(waited);
						await Promise.resolve();
						active--;
						return Response.json({ index });
					},
				);
				expect(await response.json()).toEqual({ index });
			}),
		);
		expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(peak).toBe(1);
		expect(queued).toEqual([
			false,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
		]);
	});

	it("bounds waiters and queue time with retryable responses", async () => {
		vi.useFakeTimers();
		const admission = new CatalogAdmission(1, 100);
		const active = await admission.run(
			request(),
			async () => new Response(new ReadableStream()),
		);
		const handler = vi.fn(async () => new Response(null, { status: 204 }));
		const queued = admission.run(request(), handler);
		const full = await admission.run(request(), handler);
		expect(full.status).toBe(503);
		expect(full.headers.get("Retry-After")).toBe("1");
		expect(await full.json()).toMatchObject({ reason: "full" });
		await vi.advanceTimersByTimeAsync(100);
		const expired = await queued;
		expect(expired.status).toBe(503);
		expect(await expired.json()).toMatchObject({ reason: "deadline" });
		expect(handler).not.toHaveBeenCalled();
		await active.body!.cancel();
		expect((await admission.run(request(), handler)).status).toBe(204);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("removes aborted waiters without consuming their queue place", async () => {
		const admission = new CatalogAdmission(1);
		const active = await admission.run(
			request(),
			async () => new Response(new ReadableStream()),
		);
		const controller = new AbortController();
		const skipped = vi.fn(async () => new Response(null, { status: 204 }));
		const aborted = admission.run(request(controller.signal), skipped);
		controller.abort();
		expect((await aborted).status).toBe(499);
		const replacement = admission.run(
			request(),
			async () => new Response(null, { status: 204 }),
		);
		await active.body!.cancel();
		expect((await replacement).status).toBe(204);
		expect(skipped).not.toHaveBeenCalled();
	});

	it("releases on operation errors and body read errors", async () => {
		const admission = new CatalogAdmission();
		await expect(
			admission.run(request(), async () => {
				throw new Error("build failed");
			}),
		).rejects.toThrow("build failed");
		const response = await admission.run(
			request(),
			async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error("body failed"));
						},
					}),
				),
		);
		await expect(response.text()).rejects.toThrow("body failed");
		expect(
			(
				await admission.run(
					request(),
					async () => new Response(null, { status: 204 }),
				)
			).status,
		).toBe(204);
	});

	it("holds the slot until response EOF even after its handler settled", async () => {
		const admission = new CatalogAdmission();
		let stream!: ReadableStreamDefaultController<Uint8Array>;
		const first = await admission.run(request(), async (lifetime) => {
			await lifetime.track(async () => {});
			return new Response(
				new ReadableStream({
					start(controller) {
						stream = controller;
					},
				}),
			);
		});
		const next = vi.fn(async () => new Response(null, { status: 204 }));
		const waiting = admission.run(request(), next);
		await flush();
		expect(next).not.toHaveBeenCalled();
		stream.close();
		await first.text();
		expect((await waiting).status).toBe(204);
	});

	it.each(["cancel", "timeout", "abort"])(
		"does not release on %s while the actual SDK tool handler still runs",
		async (ending) => {
			const admission = new CatalogAdmission();
			const finish = deferred();
			const abort = new AbortController();
			const rpc = new Request("https://fixture.mcp.test/mcp", {
				method: "POST",
				signal: abort.signal,
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "slow", arguments: {}, _meta: { progressToken: 1 } },
				}),
			});
			const first = await admission.run(rpc, async (lifetime) => {
				const server = createMcpServer({ name: "Fixture", version: "1" });
				lifetime.attach(server);
				server.registerTool("slow", { inputSchema: {} }, async (_args, ctx) => {
					await ctx.mcpReq.notify({
						method: "notifications/progress",
						params: { progressToken: 1, progress: 1 },
					});
					await finish.promise;
					return { content: [{ type: "text", text: "done" }] };
				});
				if (ending === "timeout") {
					const transport = new StatelessMcpTransport({
						unansweredTimeoutMs: 5,
					});
					await server.connect(transport);
					return transport.handleRequest(rpc);
				}
				return mountMcp(server, rpc, { cacheHints: {} });
			});
			expect(first.headers.get("Content-Type")).toContain("text/event-stream");
			const next = vi.fn(async () => new Response(null, { status: 204 }));
			const waiting = admission.run(request(), next);
			if (ending === "cancel") await first.body!.cancel();
			else if (ending === "timeout")
				expect(await first.text()).toContain("response_timeout");
			else abort.abort();
			await flush();
			expect(next).not.toHaveBeenCalled();
			finish.resolve();
			expect((await waiting).status).toBe(204);
		},
	);
});
