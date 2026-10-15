import type { ToolSet } from "ai";
import policy from "./no-funds-turn-policy.json";

export const NO_FUNDS_TURN_MESSAGE =
	"This turn cannot move funds. Payments and financial operations are unavailable through this connection.";

const financialPattern = new RegExp(
	`(?:^|_)(?:${[...policy.financialTerms, ...policy.paymentProviders].join("|")})[a-z]*(?:_|$)`,
);
export function noFundsTurnTools(tools: ToolSet, noFunds?: boolean): ToolSet {
	if (!noFunds) return tools;
	return Object.fromEntries(
		Object.entries(tools).filter(
			([name]) =>
				!financialPattern.test(
					name
						.replace(/([a-z])([A-Z])/g, "$1_$2")
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "_"),
				),
		),
	);
}
