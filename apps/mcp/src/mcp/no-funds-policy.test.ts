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
	it("checks aliased targets and fails closed for missing or contradictory declarations", () => {
		expect(
			isNoFundsToolDenied(
				tool({
					config: { endpoint: "https://api.example.test/refunds" },
					writeCapability: "read",
				}),
			),
		).toBe(true);
		for (const writeCapability of [undefined, "write", "destructive"] as const)
			expect(isNoFundsToolDenied(tool({ writeCapability }))).toBe(true);
		expect(
			isNoFundsToolDenied(
				tool({
					writeCapability: "read",
					annotations: { destructiveHint: true },
				}),
			),
		).toBe(true);
		expect(
			isNoFundsToolDenied(
				tool({ writeCapability: "write", annotations: { readOnlyHint: true } }),
			),
		).toBe(true);
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
		).toBe(true);
	});
});
