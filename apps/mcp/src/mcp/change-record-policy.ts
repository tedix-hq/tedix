/**
 * Which gateway tool calls get a durable ChangeRecord.
 *
 * A change record is for a call that changed something or was refused:
 * - every refused call (`denied`, `needs_approval`) and every call that did
 *   not apply (`not_applied`, `unknown`) is stored, whatever its tier;
 * - an allowed call that applied is not stored when its risk tier is `read`;
 * - nor when the tool declares `skipAppliedChangeRecord` (liveness and
 *   session reports) and its tier is `bounded_write`;
 * - every other applied call is stored, including unclassified ones.
 */
import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import type {
	ChangeRecordInput,
	RiskTier,
} from "@tedix/agent-governance/types";

export interface ChangeRecordFacts {
	outcome: ChangeRecordInput["outcome"];
	riskTier: RiskTier | "unclassified";
	/** The tool's `com.tedix/policy` declares `skipAppliedChangeRecord`. */
	skipAppliedChangeRecord: boolean;
}

export function needsChangeRecord(facts: ChangeRecordFacts): boolean {
	if (facts.outcome !== "applied") return true;
	if (facts.riskTier === "read") return false;
	return !(facts.skipAppliedChangeRecord && facts.riskTier === "bounded_write");
}

/** Read the declaration from a tool row's metadata; absent or invalid is false. */
export function declaresSkipAppliedChangeRecord(
	meta: Record<string, unknown> | null | undefined,
): boolean {
	return parseToolPolicyMetadata(meta)?.skipAppliedChangeRecord === true;
}
