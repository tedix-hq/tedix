import { expect, test } from "bun:test";
import { buildQuery, compactRow } from "./logs";

test("trace and service filters reach Cloudflare together with a bounded window", () => {
	const query = buildQuery(
		[
			"--",
			"--service",
			"example-api",
			"--trace",
			"trace-example",
			"--needle",
			"save",
			"--since",
			"2m",
		],
		180000,
	);
	expect(query.timeframe).toEqual({ from: 60000, to: 180000 });
	expect(query.parameters.filters).toEqual([
		{
			key: "$metadata.service",
			value: "example-api",
			operation: "eq",
			type: "string",
		},
		{
			key: "$metadata.traceId",
			value: "trace-example",
			operation: "eq",
			type: "string",
		},
	]);
	expect(query.parameters.needle).toEqual({ value: "save", isRegex: false });
	expect(() => buildQuery(["--since", "nonsense"])).toThrow();
	expect(() => buildQuery(["--limit", "0"])).toThrow();
});

test("compact rows preserve both timing formats and RPC elapsed messages without source payloads", () => {
	const row = JSON.parse(
		compactRow({
			timestamp: 0,
			source: {
				event: "save",
				handlerMs: 431,
				total_ms: 300,
				message: "--> POST /rpc/audit/createEvent \u001b[32m200\u001b[0m 113ms",
				body: "private payload",
			},
			$workers: { wallTimeMs: 809 },
			$metadata: { traceId: "example" },
		}),
	);
	expect(row).toMatchObject({
		handlerMs: 431,
		total_ms: 300,
		wallTimeMs: 809,
		trace: "example",
		message: "--> POST /rpc/audit/createEvent 200 113ms",
	});
	expect(row.body).toBeUndefined();
});
