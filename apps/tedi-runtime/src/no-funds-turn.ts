import type { ToolSet } from "ai";
import policy from "./no-funds-turn-policy.json";

export const NO_FUNDS_TURN_MESSAGE =
	"This turn cannot move funds. Provider calls, code, browser actions, delegation, schedules and skill execution are unavailable through this connection.";

/** A new runtime tool is denied until reviewed for this ceiling. */
export function noFundsTurnTools(tools: ToolSet, noFunds?: boolean): ToolSet {
	if (!noFunds) return tools;
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) =>
			policy.allowedTools.includes(name),
		),
	);
}
