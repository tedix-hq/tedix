import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { DelegationAuthorityEnvelope } from "@tedix/api-contract/schemas/kernel-runtime";
import type {
	DelegationAuthorityMode,
	DelegationAuthorityVerdict,
} from "./delegation-authority";
import { errorMessage } from "@tedix/worker-kit/error-message";

type RuntimeEventRecorder = {
	recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown>;
};

/**
 * One verdict of a delegated tool call against the earned-delegation grant the
 * turn carries. Emitted only for turns that have an envelope; see
 * `delegatedTurnAuthority`.
 */
export function delegationAuthorityRuntimeEvent(input: {
	tediId: string;
	runId: string;
	stepNumber: number;
	tool: string;
	mode: DelegationAuthorityMode;
	envelope: DelegationAuthorityEnvelope;
	verdict: DelegationAuthorityVerdict;
	createdAt?: string;
}): TediRuntimeEvent {
	return {
		id: `${input.runId}:delegation-authority:${input.stepNumber}`,
		tediId: input.tediId,
		kind: "delegation.authority.evaluated",
		runId: input.runId,
		sequence: input.stepNumber,
		payload: {
			source: "delegation-authority",
			mode: input.mode,
			enforced: input.mode === "enforce",
			allowed: input.verdict.allowed,
			wouldHaveDenied: input.verdict.wouldHaveDenied,
			requestedSurface: input.verdict.requestedSurface,
			requestedTool: input.tool,
			activityId: input.envelope.activityId,
			grantId: input.envelope.grantId,
			reason: input.verdict.reason ?? null,
		},
		runtime: { backend: "cloudflare-agents" },
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}

export async function emitDelegationAuthorityRuntimeEvent(
	input: Parameters<typeof delegationAuthorityRuntimeEvent>[0] & {
		getRecorder: () => Promise<RuntimeEventRecorder | null>;
	},
): Promise<void> {
	try {
		const recorder = await input.getRecorder();
		if (recorder) {
			await recorder.recordRuntimeEvent(delegationAuthorityRuntimeEvent(input));
		}
	} catch (error) {
		console.warn("[delegation-authority] verdict emit failed", {
			error: errorMessage(error),
		});
	}
}
