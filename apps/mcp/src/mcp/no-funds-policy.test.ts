import { describe, expect, it } from "vite-plus/test";
import type { AppTool } from "./server-context";
import {
	isNoFundsToolDenied,
	isToolDeniedForConnection,
} from "./no-funds-policy";

const tool = (overrides: Partial<AppTool>) =>
	({
		toolId: "list_records",
		title: "Records",
		config: null,
		annotations: null,
		...overrides,
	}) as AppTool;

describe("directory no-funds classification", () => {
	it.each([
		"charge",
		"payment",
		"payout",
		"refund",
		"transfer",
		"withdraw",
		"send_money",
		"create_checkout",
		"purchase",
		"subscribe",
		"top_up",
		"stripe",
		"paypal",
		"adyen",
		"wise",
		"mollie",
		"coinbase",
		"crypto",
		"wallet",
	])("denies %s despite a read declaration", (word) => {
		expect(
			isNoFundsToolDenied(
				tool({ toolId: `provider__${word}`, writeCapability: "read" }),
			),
		).toBe(true);
		expect(
			isNoFundsToolDenied(
				tool({
					description: `Perform ${word}`,
					annotations: { readOnlyHint: true },
				}),
			),
		).toBe(true);
	});
	it("checks aliased financial targets while allowing ordinary writes", () => {
		expect(
			isNoFundsToolDenied(
				tool({
					config: { endpoint: "https://api.example.test/refunds" },
					writeCapability: "read",
				}),
			),
		).toBe(true);
		for (const writeCapability of [undefined, "write", "destructive"] as const)
			expect(isNoFundsToolDenied(tool({ writeCapability }))).toBe(false);
		expect(
			isNoFundsToolDenied(
				tool({
					writeCapability: "read",
					annotations: { destructiveHint: true },
				}),
			),
		).toBe(false);
		expect(
			isNoFundsToolDenied(
				tool({ writeCapability: "write", annotations: { readOnlyHint: true } }),
			),
		).toBe(false);
	});
	it("allows explicit unrelated reads without matching substrings inside other words", () => {
		expect(
			isNoFundsToolDenied(
				tool({
					writeCapability: "read",
					description: "Read otherwise unchanged records",
				}),
			),
		).toBe(false);
	});
	it("retains the original Connect boundary after organization routing", () => {
		const payment = tool({ toolId: "create_payment" });
		expect(
			isToolDeniedForConnection(
				{ appSlug: "tenant", connectionAppSlug: "connect" },
				payment,
			),
		).toBe(true);
		expect(isToolDeniedForConnection({ appSlug: "tenant" }, payment)).toBe(
			false,
		);
	});
	it("permits canonical turn ingress with or without a cached tedi UUID", () => {
		const config = {
			transport: "mcp",
			mcpToolName: "run_tedi_turn",
			_aggregateTediId: "tedi-1",
		};
		expect(isNoFundsToolDenied(tool({ config }))).toBe(false);
		expect(
			isNoFundsToolDenied(
				tool({ config: { ...config, _aggregateTediId: null } }),
			),
		).toBe(false);
		expect(
			isNoFundsToolDenied(
				tool({ config: { ...config, mcpToolName: "execute" } }),
			),
		).toBe(false);
	});
	it.each([
		"run_skill",
		"run_skill_workflow",
		"create_os_output",
		"create_work_items",
		"create_connection",
		"submit_home_turn",
	])("allows ordinary execution: %s", (toolId) => {
		expect(
			isNoFundsToolDenied(
				tool({
					toolId,
					writeCapability: "write",
					annotations: { readOnlyHint: false },
				}),
			),
		).toBe(false);
	});
	it("denies x402 paid tools with ordinary names", () => {
		expect(
			isNoFundsToolDenied(
				tool({
					config: {
						payment: {
							enabled: true,
							protocol: "x402",
							amount: "1",
							network: "eip155:8453",
							recipient: "0x0000000000000000000000000000000000000001",
						},
					},
				}),
			),
		).toBe(true);
	});
});
