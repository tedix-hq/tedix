// @vitest-environment node
import { App } from "@modelcontextprotocol/ext-apps";
import {
	ProtocolError,
	type Transport,
	type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { createWidgetAppBridge } from "./widget-app-bridge";
import { readWidgetProxyResponse } from "./widget-proxy-response";

class Pipe implements Transport {
	peer!: Pipe;
	onmessage?: Transport["onmessage"];
	onclose?: () => void;
	onerror?: (error: Error) => void;
	async start() {}
	async send(message: JSONRPCMessage) {
		this.peer.onmessage?.(structuredClone(message));
	}
	async close() {
		this.onclose?.();
	}
}
function pair() {
	const a = new Pipe();
	const b = new Pipe();
	a.peer = b;
	b.peer = a;
	return [a, b] as const;
}

for (const [name, Guest] of [["v2", App]] as const) {
	describe(`${name} guest with Tedix v2 host`, () => {
		it("initializes permissions/theme, calls tools, receives results and updates model context", async () => {
			const call = vi.fn(async () => ({
				content: [],
				structuredContent: { ok: true },
			}));
			const update = vi.fn(async () => ({}));
			const host = createWidgetAppBridge(
				call,
				update,
				{ theme: "dark" },
				{ camera: {} },
			);
			const guest = new Guest(
				{ name: "widget", version: "1" },
				{},
				{ autoResize: false },
			);
			const result = vi.fn();
			guest.addEventListener("toolresult", result);
			const [a, b] = pair();
			try {
				await host.connect(a);
				await guest.connect(b);
				expect(guest.getHostContext()).toMatchObject({ theme: "dark" });
				expect(guest.getHostCapabilities()).toMatchObject({
					sandbox: { permissions: { camera: {} } },
				});
				await expect(
					guest.callServerTool({ name: "list_items", arguments: {} }),
				).resolves.toMatchObject({ structuredContent: { ok: true } });
				await guest.updateModelContext({ structuredContent: { selected: 3 } });
				expect(update).toHaveBeenCalledWith(
					{ structuredContent: { selected: 3 } },
					expect.anything(),
				);
				await host.sendToolInput({ arguments: {} });
				await host.sendToolResult({
					content: [],
					structuredContent: { rows: [1, 2] },
				});
				expect(result).toHaveBeenCalledWith(
					expect.objectContaining({ structuredContent: { rows: [1, 2] } }),
				);
			} finally {
				await guest.close();
				await host.close();
			}
		});
		it.each([
			[-32602, "Unknown tool", undefined],
			[-32602, "Invalid arguments", { field: "name" }],
			[-32602, "Resource missing", { uri: "ui://missing" }],
		])("preserves proxy error %s %s", async (code, message, data) => {
			const host = createWidgetAppBridge(
				async () =>
					await readWidgetProxyResponse(
						Response.json(
							{ error: { rpc: { code, message, data } } },
							{ status: 502 },
						),
					),
				async () => ({}),
				{},
			);
			const guest = new Guest(
				{ name: "widget", version: "1" },
				{},
				{ autoResize: false },
			);
			const [a, b] = pair();
			try {
				await host.connect(a);
				await guest.connect(b);
				await expect(
					guest.callServerTool({ name: "missing" }),
				).rejects.toMatchObject({ code, data });
			} finally {
				await guest.close();
				await host.close();
			}
		});
	});
}

it.each([[1, 2], "text", 42, false, null].map((value) => [value]))(
	"v2 result preserves JSON %j",
	async (value) => {
		const host = createWidgetAppBridge(
			async () => ({ content: [] }),
			async () => ({}),
			{},
		);
		const guest = new App(
			{ name: "widget", version: "1" },
			{},
			{ autoResize: false },
		);
		const result = vi.fn();
		guest.addEventListener("toolresult", result);
		const [a, b] = pair();
		try {
			await host.connect(a);
			await guest.connect(b);
			await host.sendToolInput({ arguments: {} });
			await host.sendToolResult({ content: [], structuredContent: value });
			expect(result.mock.calls[0]?.[0].structuredContent).toEqual(value);
		} finally {
			await guest.close();
			await host.close();
		}
	},
);

it("reconstructs a ProtocolError instead of flattening it into an HTTP status", async () => {
	await expect(
		readWidgetProxyResponse(
			Response.json(
				{
					error: {
						rpc: {
							code: -32602,
							message: "Invalid params",
							data: { field: "q" },
						},
					},
				},
				{ status: 502 },
			),
		),
	).rejects.toBeInstanceOf(ProtocolError);
});

it.each(["timeout", "cancel"])(
	"v2 %s rejects locally and aborts the host handler",
	async (mode) => {
		let hostSignal: AbortSignal | undefined;
		const host = createWidgetAppBridge(
			async (_params, extra) => {
				hostSignal = extra.mcpReq.signal;
				await new Promise<void>((resolve) =>
					extra.mcpReq.signal.addEventListener("abort", () => resolve(), {
						once: true,
					}),
				);
				return { content: [] };
			},
			async () => ({}),
			{},
		);
		const guest = new App(
			{ name: "widget", version: "1" },
			{},
			{ autoResize: false },
		);
		const [a, b] = pair();
		try {
			await host.connect(a);
			await guest.connect(b);
			const controller = new AbortController();
			const pending = guest.callServerTool(
				{ name: "slow" },
				{ timeout: mode === "timeout" ? 20 : 1000, signal: controller.signal },
			);
			const assertion = expect(pending).rejects.toMatchObject({
				code: "REQUEST_TIMEOUT",
			});
			if (mode === "cancel") controller.abort("User cancelled");
			await assertion;
			expect(hostSignal?.aborted).toBe(true);
		} finally {
			await guest.close();
			await host.close();
		}
	},
);
