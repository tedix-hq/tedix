import type { DecisionCardKind } from "@/components/work-decision-card";
import { OS_COPY } from "@/shared/os-copy";
import { decisionEnvelope } from "@/lib/decision-deck";

export function connectorApproval(metadata?: Record<string, unknown> | null) {
	return typeof metadata?.approvalOperation === "string" &&
		metadata.approvalOperation.trim() &&
		typeof metadata.approvalTarget === "string" &&
		metadata.approvalTarget.trim()
		? { operation: metadata.approvalOperation, target: metadata.approvalTarget }
		: null;
}

/** Older connector approvals use question storage with an exact operation. */
export function interactionCardKind(request: {
	kind: string;
	metadata?: Record<string, unknown> | null;
}): DecisionCardKind {
	const metadata = request.metadata;
	if (connectorApproval(metadata)) return "approval";
	const decision = decisionEnvelope(metadata);
	return (
		decision?.kind ??
		(metadata?.schema === "tedix.outbound.v1"
			? "outbound"
			: request.kind === "handoff"
				? "proposal"
				: metadata?.decisionCard
					? "decision"
					: "question")
	);
}

export function connectorApprovalSummary(
	request: { metadata?: Record<string, unknown> | null; prompt: string },
	source: string,
) {
	const name = source.replace(/\s+session$/i, "");
	return connectorApproval(request.metadata)?.operation ===
		"tests_write.GenerateMagicLinkForTestUser" &&
		/non-delivered test-only link|not emailed/i.test(request.prompt)
		? OS_COPY.decisionDeck.testLoginSummary(name)
		: OS_COPY.decisionDeck.approvalSummary(name);
}
