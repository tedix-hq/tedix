import type {
	WorkItem,
	WorkItemAcceptanceContract,
} from "../../schema/work-items";

/**
 * What a proposed Work Item still lacks before it can leave triage as accepted
 * work: a project to live in, a statement of what done looks like, and an
 * accountable owner. The rule judges the proposed-to-accepted transition only;
 * rows accepted earlier are not re-judged.
 */
export function missingForAcceptance(
	item: Pick<WorkItem, "projectId" | "accountableOwnerId">,
	contract: Pick<WorkItemAcceptanceContract, "doneLooksLike"> | null,
	options: { systemEnvelope?: boolean } = {},
): string[] {
	return [
		...(item.projectId || options.systemEnvelope ? [] : ["a project"]),
		...(contract?.doneLooksLike?.trim()
			? []
			: ["a statement of what done looks like"]),
		...(item.accountableOwnerId ? [] : ["an accountable owner"]),
	];
}

export function acceptanceRefusal(missing: string[]): string {
	return `Accepting this Work Item needs a project, a statement of what done looks like and an accountable owner. Missing: ${missing.join(", ")}. Add what is missing and accept again, or decline the proposal.`;
}
