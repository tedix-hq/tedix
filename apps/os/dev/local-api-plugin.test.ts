// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import { localApiPlugin } from "./local-api-plugin";

describe("fixture health middleware", () => {
	it("reports the fixture runtime without pretending a Worker or login is running", () => {
		let middleware: Connect.NextHandleFunction | undefined;
		const configure = localApiPlugin().configureServer;
		if (typeof configure !== "function")
			throw new Error("missing configureServer");
		configure.call(
			{} as never,
			{
				middlewares: {
					use(handler: Connect.NextHandleFunction) {
						middleware = handler;
					},
				},
			} as unknown as ViteDevServer,
		);
		if (!middleware) throw new Error("missing middleware");
		const next = vi.fn();
		const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
		middleware(
			{ url: "/health?probe=1", method: "GET" } as IncomingMessage,
			response as unknown as ServerResponse,
			next,
		);
		expect(next).not.toHaveBeenCalled();
		expect(response.setHeader).toHaveBeenCalledWith(
			"cache-control",
			"no-store",
		);
		expect(response.writeHead).toHaveBeenCalledWith(200, {
			"content-type": "application/json",
		});
		expect(JSON.parse(response.end.mock.calls[0]?.[0])).toEqual({
			status: "ok",
			runtime: "fixtures",
			data: "in-memory",
			auth: "disabled",
		});
		middleware(
			{ url: "/health-other", method: "GET" } as IncomingMessage,
			response as unknown as ServerResponse,
			next,
		);
		expect(next).toHaveBeenCalledOnce();
	});
});
