import { describe, expect, it } from "vite-plus/test";
import { installCmsToolAudit } from "./tools";

describe("CMS MCP tool audit", () => {
	it("records successful tool execution without changing the result", async () => {
		let registered: ((...args: unknown[]) => Promise<unknown>) | undefined;
		const events: Array<Record<string, unknown>> = [];
		const server = {
			registerTool: (
				_name: string,
				_options: unknown,
				handler: (...args: unknown[]) => Promise<unknown>,
			) => {
				registered = handler;
			},
		};
		installCmsToolAudit(server as never, async (event) => {
			events.push(event);
		});
		server.registerTool("get_site_overview", {}, async () => ({ ok: true }));

		await expect(registered?.()).resolves.toEqual({ ok: true });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			outcome: "success",
			toolName: "get_site_overview",
		});
		expect(events[0]?.resultDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("records failed execution and preserves the tool error", async () => {
		let registered: ((...args: unknown[]) => Promise<unknown>) | undefined;
		const events: Array<Record<string, unknown>> = [];
		const server = {
			registerTool: (
				_name: string,
				_options: unknown,
				handler: (...args: unknown[]) => Promise<unknown>,
			) => {
				registered = handler;
			},
		};
		installCmsToolAudit(server as never, async (event) => {
			events.push(event);
		});
		server.registerTool("theme_deploy", {}, async () => {
			throw new Error("deploy failed");
		});

		await expect(registered?.()).rejects.toThrow("deploy failed");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			outcome: "error",
			resultDigest: null,
			toolName: "theme_deploy",
		});
	});
});
