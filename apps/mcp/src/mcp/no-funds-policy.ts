import policy from "./no-funds-policy.json";
import type { AppTool, ServerContext } from "./server-context";
import { isNonPayingConnection } from "./connect-payment-policy";
import { getToolPaymentPolicy } from "./payments-policy";

const financialPattern = new RegExp(
	`(?:^|_)(?:${policy.moneyMovingOperations.join("|")})$`,
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

/** Match operation identifiers, not prose mentioning payment or a provider. */
export function isNoFundsToolDenied(tool: AppTool): boolean {
	if (getToolPaymentPolicy(tool)) return true;
	const targets = [
		tool.toolId,
		tool.config?.endpoint,
		tool.config?.mcpToolName,
	];
	if (
		targets.some(
			(target) =>
				typeof target === "string" && financialPattern.test(normalized(target)),
		)
	)
		return true;
	return (
		tool.config?.transport === "rest" &&
		tool.config?.method === "POST" &&
		typeof tool.config?.endpoint === "string" &&
		/(?:^|_)(?:charges|payments|payment_intents|payouts|refunds|transfers|withdrawals)$/.test(
			normalized(tool.config.endpoint),
		)
	);
}

export function isToolDeniedForConnection(
	context: Pick<ServerContext, "appSlug" | "connectionAppSlug">,
	tool: AppTool,
): boolean {
	return hasNoFundsRestriction(context) && isNoFundsToolDenied(tool);
}
