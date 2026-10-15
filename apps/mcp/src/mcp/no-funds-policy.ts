import policy from "./no-funds-policy.json";
import type { AppTool, ServerContext } from "./server-context";
import {
	isFinancialBillingTool,
	isNonPayingConnection,
} from "./connect-payment-policy";
import { getToolPaymentPolicy } from "./payments";

const financialPattern = new RegExp(
	`(?:^|_)(?:${[...policy.financialTerms, ...policy.paymentProviders].join("|")})[a-z]*(?:_|$)`,
);

export function hasNoFundsRestriction(
	context: Pick<ServerContext, "appSlug" | "connectionAppSlug">,
): boolean {
	return isNonPayingConnection(context.connectionAppSlug ?? context.appSlug);
}

function normalized(value: string): string {
	return value
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_");
}

/** A read declaration cannot override a financial name or target. */
export function isNoFundsToolDenied(tool: AppTool): boolean {
	if (isFinancialBillingTool(tool) || getToolPaymentPolicy(tool)) return true;
	if (policy.deniedTransports.includes(String(tool.config?.transport)))
		return true;
	const text = normalized(
		[
			tool.toolId,
			tool.title,
			tool.description,
			JSON.stringify(tool.config),
		].join(" "),
	);
	return financialPattern.test(text);
}

export function isToolDeniedForConnection(
	context: Pick<ServerContext, "appSlug" | "connectionAppSlug">,
	tool: AppTool,
): boolean {
	return hasNoFundsRestriction(context) && isNoFundsToolDenied(tool);
}
