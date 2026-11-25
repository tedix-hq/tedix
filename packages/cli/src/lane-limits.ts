import * as z from "zod";

export const laneLimitsSchema = z
	.strictObject({
		maxTurns: z.number().int().positive().optional(),
		timeoutSec: z.number().positive().optional(),
		maxCostUsd: z.number().positive().optional(),
		/** Owner-supplied blended estimate, including cached input and output. */
		usdPerMillionTokens: z.number().positive().optional(),
	})
	.refine((limits) => !limits.maxCostUsd || !!limits.usdPerMillionTokens, {
		message: "maxCostUsd needs usdPerMillionTokens",
	});

export type LaneLimits = z.infer<typeof laneLimitsSchema>;
export interface LaneLimitState {
	startedAt: number;
	turns: number;
	tokens: number;
	transcriptBaseline?: { turns: number; tokens: number };
	reason?: string;
}

export function laneLimitReason(
	limits: LaneLimits,
	state: LaneLimitState,
	now = Date.now(),
) {
	if (state.reason) return state.reason;
	if (limits.timeoutSec && now - state.startedAt >= limits.timeoutSec * 1000)
		return `Attempt wall time limit reached (${limits.timeoutSec} seconds)`;
	if (limits.maxTurns && state.turns >= limits.maxTurns)
		return `Attempt turn limit reached (${limits.maxTurns} model responses)`;
	if (
		limits.maxCostUsd &&
		(state.tokens * limits.usdPerMillionTokens!) / 1_000_000 >=
			limits.maxCostUsd
	)
		return `Attempt estimated cost limit reached ($${limits.maxCostUsd})`;
}
