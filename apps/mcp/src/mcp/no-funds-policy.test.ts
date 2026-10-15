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
		"create_charge",
		"capture_payment",
		"confirm_payment_intent",
		"create_payout",
		"create_refund",
		"create_transfer",
		"create_withdrawal",
		"send_money",
		"transfer_funds",
		"withdraw_money",
		"charge_customer",
		"refund_payment",
		"pay_invoice",
		"top_up_funds",
	])("denies money-moving operation %s even with read hints", (operation) => {
		expect(
			isNoFundsToolDenied(
				tool({ toolId: `provider__${operation}`, writeCapability: "read" }),
			),
		).toBe(true);
		expect(
			isNoFundsToolDenied(
				tool({ config: { endpoint: `provider.${operation}` } }),
			),
		).toBe(true);
		expect(
			isNoFundsToolDenied(tool({ config: { mcpToolName: operation } })),
		).toBe(true);
	});
	it.each([
		"list_payments",
		"list_topups",
		"get_top_up",
		"get_charge",
		"list_refunds",
		"get_transfer",
		"get_wallet",
		"list_crypto",
		"create_subscription",
		"subscribe",
		"purchase",
		"create_payment_method",
		"create_payment_link",
		"create_checkout",
		"create_portal",
		"update_subscription",
		"stripe_list_customers",
		"paypal_get_balance",
		"adyen_list_records",
		"wise_get_profile",
		"mollie_list_customers",
		"coinbase_get_wallet",
		"transfer_file",
		"create_work_comment",
	])("allows operations that do not move money: %s", (toolId) => {
		expect(
			isNoFundsToolDenied(
				tool({
					toolId,
					description:
						"Manage payment, charge, wallet and subscription records",
					config: { transport: "code" },
				}),
			),
		).toBe(false);
	});
	it.each([
		"createCheckout",
		"createPortal",
		"createInferenceCapacityCheckout",
		"setOverageSettings",
		"setCreditBudget",
		"grantCredit",
		"configureCreditBilling",
		"getOverview",
	])("allows Tedix billing links/settings/grants: %s", (method) => {
		expect(
			isNoFundsToolDenied(
				tool({
					toolId: "billing_alias",
					config: { transport: "rpc", endpoint: `billing/${method}` },
				}),
			),
		).toBe(false);
	});
	it("distinguishes REST money creation from reads", () => {
		for (const resource of [
			"payments",
			"charges",
			"refunds",
			"payouts",
			"transfers",
			"withdrawals",
		]) {
			expect(
				isNoFundsToolDenied(
					tool({
						config: {
							transport: "rest",
							method: "POST",
							endpoint: `https://api.example.test/${resource}`,
						},
					}),
				),
			).toBe(true);
			expect(
				isNoFundsToolDenied(
					tool({
						config: {
							transport: "rest",
							method: "GET",
							endpoint: `https://api.example.test/${resource}`,
						},
					}),
				),
			).toBe(false);
		}
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
