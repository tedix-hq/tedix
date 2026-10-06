// TedixPay/x402 payment ledger and budget tool specs.
import { READ_ONLY, type TediToolSpec } from "./aggregate-tedis-shared";

export const PAYMENT_TOOLS: TediToolSpec[] = [
	{
		name: "payments_list_accounts",
		remoteName: "payments_list_accounts",
		description: "List TedixPay payment accounts scoped to this tedi.",
		inputSchema: {
			type: "object",
			properties: {
				appSlug: { type: "string" },
				status: { type: "string" },
				network: { type: "string" },
				asset: { type: "string" },
				limit: { type: "integer" },
			},
			additionalProperties: false,
		},
		annotations: READ_ONLY,
		paramMap: {
			appSlug: "appSlug",
			status: "status",
			network: "network",
			asset: "asset",
			limit: "limit",
		},
		rpcEndpoint: "mcpPayments/listAccounts",
	},
	{
		name: "payments_list_reservations",
		remoteName: "payments_list_reservations",
		description: "List TedixPay/x402 reservations scoped to this tedi.",
		inputSchema: {
			type: "object",
			properties: {
				appSlug: { type: "string" },
				toolId: { type: "string" },
				requirementId: { type: "string" },
				status: { type: "string" },
				limit: { type: "integer" },
			},
			additionalProperties: false,
		},
		annotations: READ_ONLY,
		paramMap: {
			appSlug: "appSlug",
			toolId: "toolId",
			requirementId: "requirementId",
			status: "status",
			limit: "limit",
		},
		rpcEndpoint: "mcpPayments/listReservations",
	},
];
