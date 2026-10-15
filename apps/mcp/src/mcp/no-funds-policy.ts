import policy from "./no-funds-policy.json";
import type { AppTool, ServerContext } from "./server-context";
import {
	isFinancialBillingTool,
	isNonPayingConnection,
} from "./connect-payment-policy";
import { getToolPaymentPolicy } from "./payments";
import { resolveToolAnnotations } from "@tedix/api-contract/schemas/tools";

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
	// The native tedi ingress stamps a restricted turn; other execution and
	// configuration writes cannot prove preservation of that ceiling.
	if (
		tool.config?.transport === "mcp" &&
		(tool.config?._aggregateTediRemoteName ?? tool.config?.mcpToolName) ===
			"run_tedi_turn"
	)
		return false;
	const text = normalized(
		[
			tool.toolId,
			tool.title,
			tool.description,
			JSON.stringify(tool.config),
		].join(" "),
	);
	if (financialPattern.test(text)) return true;
	const annotations = resolveToolAnnotations(tool);
	if (
		annotations?.destructiveHint === true ||
		annotations?.readOnlyHint === false
	)
		return true;
	if (tool.writeCapability) return tool.writeCapability !== "read";
	return annotations?.readOnlyHint !== true;
}

export function isToolDeniedForConnection(
	context: Pick<ServerContext, "appSlug" | "connectionAppSlug">,
	tool: AppTool,
): boolean {
	return hasNoFundsRestriction(context) && isNoFundsToolDenied(tool);
}
