/// <reference types="@cloudflare/vitest-plugin/types" />

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { toolCallCountStub } from "./tool-call-counts";

it("keeps concurrent calls in one durable counter per tool and UTC day", async () => {
	const bindingEnv = env as unknown as CloudflareEnv;
	const day = "2026-01-01";
	const stub = toolCallCountStub(bindingEnv, day);
	await Promise.all(
		Array.from({ length: 100 }, (_, i) =>
			stub.fetch("https://counter/tool-counts/increment", {
				method: "POST",
				body: JSON.stringify({
					toolName: i % 2 ? "read_report" : "write_report",
				}),
			}),
		),
	);
	const report = await stub.fetch("https://counter/tool-counts/report", {
		method: "POST",
	});
	expect(await report.json()).toMatchObject({
		storage: "durable-object-sqlite",
		counterCount: 2,
		databaseBytes: expect.any(Number),
		rows: [
			{ toolName: "read_report", calls: 50 },
			{ toolName: "write_report", calls: 50 },
		],
	});
	const tomorrow = await toolCallCountStub(bindingEnv, "2026-01-02").fetch(
		"https://counter/tool-counts/report",
		{ method: "POST" },
	);
	expect(await tomorrow.json()).toMatchObject({ counterCount: 0, rows: [] });
});

it("refuses public reads of installation-wide counts", async () => {
	const response = await SELF.fetch(
		"https://pilot.mcp.tedix.dev/__internal/tool-counts",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
			},
			body: JSON.stringify({ day: "2026-01-01" }),
		},
	);
	expect(response.status).toBe(403);
});
