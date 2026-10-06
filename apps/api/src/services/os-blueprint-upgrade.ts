/**
 * Blueprint upgrade compatibility: what changes between the revision a
 * workspace is PINNED to and a candidate revision of the same blueprint, and
 * whether the candidate resolves in THIS organization.
 *
 * There is no second comparison vocabulary here. Every verdict on this report
 * came out of `resolveOsBlueprintPreflight`, and every requirement row is keyed
 * by the platform's shared `(kind, subject)` decision identity, so a
 * compatibility claim is only ever a restatement of a resolution that actually
 * ran.
 *
 * THE THREE COLUMNS. Skills and policy packs version IN PLACE with no history
 * table, so the envelope recorded at instantiation and a resolution run today
 * can disagree while the pin has not moved at all. Diffing "stored old" against
 * "fresh new" would blame that tenant drift on the upgrade. The report therefore
 * resolves BOTH revisions now — pinned and candidate — and keeps the stored
 * envelope as a third, clearly-labelled column whose only job is to expose
 * drift under the unchanged pin.
 */

import type {
	OsBlueprintDefinition,
	OsBlueprintGadgetChange,
	OsBlueprintPreflight,
	OsBlueprintRequirementChange,
	OsBlueprintUpgradeDecisionSummary,
	OsBlueprintUpgradeReport,
} from "@tedix/api-contract/schemas/os-workspaces";
import type {
	ExecutionPreflightPin,
	WorkItemExecutionPreflightDecision,
} from "@tedix/api-contract/schemas/work-items";
import type { DbClient } from "@tedix/db/client";
import { canonicalJson } from "../lib/blueprint-digest";
import { resolveOsBlueprintPreflight } from "./os-blueprint-preflight";

type Decision = WorkItemExecutionPreflightDecision;

/** One blueprint revision as the report reads it. */
export interface OsBlueprintUpgradeRevision {
	id: string;
	revision: number;
	definition: OsBlueprintDefinition;
}

export interface OsBlueprintUpgradeReportInput {
	db: DbClient;
	env: CloudflareEnv;
	/** The CALLER's organization — both preflights resolve here, never in the publisher's. */
	organizationId: string;
	workspaceId: string;
	blueprintId: string;
	pinned: OsBlueprintUpgradeRevision;
	candidate: OsBlueprintUpgradeRevision;
	/** The envelope stored on the workspace; null when the row carries none or it no longer parses. */
	preflightAtInstantiation: OsBlueprintPreflight | null;
	tediId?: string | null;
	ownerUserId?: string | null;
	now?: string;
}

function decisionKey(decision: Pick<Decision, "kind" | "subject">): string {
	return `${decision.kind}\u0000${decision.subject}`;
}

function indexDecisions(decisions: Decision[]): Map<string, Decision> {
	const index = new Map<string, Decision>();
	for (const decision of decisions) {
		// First writer wins: a preflight emits one decision per declared subject,
		// and a duplicate would be a bug, not a second opinion to merge.
		if (!index.has(decisionKey(decision)))
			index.set(decisionKey(decision), decision);
	}
	return index;
}

function pinOf(pin: Decision["declaredPin"]): ExecutionPreflightPin | null {
	return pin ?? null;
}

function samePin(
	left: ExecutionPreflightPin | null,
	right: ExecutionPreflightPin | null,
): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

/**
 * The raw declaration a decision is about, for kinds whose resolver emits no
 * `declaredPin`.
 *
 * Connection, layout and output decisions carry no pin — there is no version to
 * pin — so a pin-only diff concluded `unchanged` for every one of them. That
 * silently reported "0 requirements changed" for a connection whose scopes
 * broadened, an output repointed at a different gadget and kind, and a whole
 * layout rewrite. The decision record persisted from that report does not keep
 * the raw blobs, so the understatement was unrecoverable after the fact.
 */
function declarationFor(
	requirements: OsBlueprintPreflight["requirements"],
	decision: Pick<Decision, "kind" | "subject">,
): unknown {
	if (!requirements) return null;
	switch (decision.kind) {
		case "connection":
			return (
				requirements.connections.find(
					(entry) => entry.providerId === decision.subject,
				) ?? null
			);
		case "layout":
			return requirements.layout ?? null;
		case "output":
			return (
				requirements.outputs.find(
					(entry) => entry.title === decision.subject,
				) ?? null
			);
		default:
			// skill / policy_pack / model carry a declaredPin, which is the
			// stronger comparison — the pin IS the identity there.
			return null;
	}
}

function diffRequirements(input: {
	pinnedNow: OsBlueprintPreflight;
	candidateNow: OsBlueprintPreflight;
	atInstantiation: OsBlueprintPreflight | null;
}): OsBlueprintRequirementChange[] {
	const pinnedIndex = indexDecisions(input.pinnedNow.decisions);
	const candidateIndex = indexDecisions(input.candidateNow.decisions);
	const storedIndex = indexDecisions(input.atInstantiation?.decisions ?? []);
	const changes: OsBlueprintRequirementChange[] = [];
	const seen = new Set<string>();
	for (const decision of [
		...input.pinnedNow.decisions,
		...input.candidateNow.decisions,
	]) {
		const key = decisionKey(decision);
		if (seen.has(key)) continue;
		seen.add(key);
		const pinned = pinnedIndex.get(key) ?? null;
		const candidate = candidateIndex.get(key) ?? null;
		const stored = storedIndex.get(key) ?? null;
		const pinnedDeclaredPin = pinned ? pinOf(pinned.declaredPin) : null;
		const candidateDeclaredPin = candidate
			? pinOf(candidate.declaredPin)
			: null;
		// When neither side carries a pin, fall back to the DECLARATION itself.
		// Concluding "unchanged" from two absent pins is what let a scope
		// broadening read as no change at all.
		const pinsComparable =
			pinnedDeclaredPin !== null || candidateDeclaredPin !== null;
		const declarationsMatch = pinsComparable
			? samePin(pinnedDeclaredPin, candidateDeclaredPin)
			: canonicalJson(
					declarationFor(input.pinnedNow.requirements, decision),
				) ===
				canonicalJson(
					declarationFor(input.candidateNow.requirements, decision),
				);
		const change: OsBlueprintRequirementChange["change"] = !pinned
			? "added"
			: !candidate
				? "removed"
				: declarationsMatch
					? "unchanged"
					: "repinned";
		// The row reports the decision it is about: the candidate's when the
		// candidate declares the subject, otherwise the pinned revision's. Both
		// are real reads; neither is synthesized.
		const reported = candidate ?? pinned;
		if (!reported) continue;
		changes.push({
			kind: decision.kind,
			subject: decision.subject,
			change,
			verdictAtInstantiation: stored?.verdict ?? null,
			pinnedVerdict: pinned?.verdict ?? null,
			candidateVerdict: candidate?.verdict ?? null,
			driftedSinceInstantiation: Boolean(
				stored && pinned && stored.verdict !== pinned.verdict,
			),
			pinnedDeclaredPin,
			candidateDeclaredPin,
			candidateResolvedPin: candidate ? pinOf(candidate.resolvedPin) : null,
			reason: reported.reason,
		});
	}
	return changes;
}

/**
 * Gadget-set delta. Names are the identity of a declared gadget (the
 * instantiation path refuses a revision that declares one twice), and a
 * manifest counts as changed only when its canonical JSON differs.
 */
export function diffBlueprintGadgets(
	pinned: OsBlueprintDefinition,
	candidate: OsBlueprintDefinition,
): OsBlueprintGadgetChange[] {
	const pinnedByName = new Map(
		pinned.gadgets.map((gadget) => [gadget.name, gadget]),
	);
	const candidateByName = new Map(
		candidate.gadgets.map((gadget) => [gadget.name, gadget]),
	);
	const changes: OsBlueprintGadgetChange[] = [];
	for (const [name, candidateGadget] of candidateByName) {
		const pinnedGadget = pinnedByName.get(name);
		if (!pinnedGadget) {
			changes.push({ name, change: "added" });
			continue;
		}
		changes.push({
			name,
			change:
				canonicalJson(pinnedGadget.manifest) ===
				canonicalJson(candidateGadget.manifest)
					? "unchanged"
					: "changed",
		});
	}
	for (const name of pinnedByName.keys()) {
		if (!candidateByName.has(name)) changes.push({ name, change: "removed" });
	}
	return changes;
}

export async function resolveOsBlueprintUpgradeReport(
	input: OsBlueprintUpgradeReportInput,
): Promise<OsBlueprintUpgradeReport> {
	const resolvedAt = input.now ?? new Date().toISOString();
	const shared = {
		db: input.db,
		env: input.env,
		organizationId: input.organizationId,
		blueprintId: input.blueprintId,
		tediId: input.tediId ?? null,
		ownerUserId: input.ownerUserId ?? null,
		now: resolvedAt,
	};
	const [pinnedPreflightNow, candidatePreflightNow] = await Promise.all([
		resolveOsBlueprintPreflight({
			...shared,
			revisionId: input.pinned.id,
			revision: input.pinned.revision,
			definition: input.pinned.definition,
		}),
		resolveOsBlueprintPreflight({
			...shared,
			revisionId: input.candidate.id,
			revision: input.candidate.revision,
			definition: input.candidate.definition,
		}),
	]);
	const factoryBlockers = factoryUpgradeBlockers(
		input.pinned.definition,
		input.candidate.definition,
	);
	return {
		workspaceId: input.workspaceId,
		blueprintId: input.blueprintId,
		pinnedRevisionId: input.pinned.id,
		pinnedRevision: input.pinned.revision,
		candidateRevisionId: input.candidate.id,
		candidateRevision: input.candidate.revision,
		upToDate: input.candidate.id === input.pinned.id,
		preflightAtInstantiation: input.preflightAtInstantiation,
		pinnedPreflightNow,
		candidatePreflightNow,
		requirementChanges: diffRequirements({
			pinnedNow: pinnedPreflightNow,
			candidateNow: candidatePreflightNow,
			atInstantiation: input.preflightAtInstantiation,
		}),
		gadgetChanges: diffBlueprintGadgets(
			input.pinned.definition,
			input.candidate.definition,
		),
		applyAllowed:
			candidatePreflightNow.instantiateAllowed && factoryBlockers.length === 0,
		blockingReasons: [
			...candidatePreflightNow.blockingReasons,
			...factoryBlockers,
		],
		consentReasons: candidatePreflightNow.consentReasons,
		resolvedAt,
	};
}

/** Factory migrations need scenario proof; the gadget-only upgrader cannot provide it. */
export function factoryUpgradeBlockers(
	pinned: OsBlueprintDefinition,
	candidate: OsBlueprintDefinition,
): string[] {
	return canonicalJson(pinned.factory ?? null) ===
		canonicalJson(candidate.factory ?? null)
		? []
		: [
				"Factory operating contract changed. Certify a new pinned Workspace before migrating intake; existing Work retains its original contract.",
			];
}

/** Reasons are bounded before they are persisted beside a decision; the full lists stay on the report. */
const SUMMARY_REASON_LIMIT = 50;
const SUMMARY_REASON_LENGTH = 2000;

function boundedReasons(reasons: string[]): string[] {
	return reasons
		.slice(0, SUMMARY_REASON_LIMIT)
		.map((reason) => reason.slice(0, SUMMARY_REASON_LENGTH));
}

/** The bounded evidence recorded with a decision; every count is derived from the report that was actually resolved. */
export function summarizeOsBlueprintUpgradeReport(
	report: OsBlueprintUpgradeReport,
): OsBlueprintUpgradeDecisionSummary {
	const gadgetCount = (change: OsBlueprintGadgetChange["change"]): number =>
		report.gadgetChanges.filter((entry) => entry.change === change).length;
	return {
		candidateStatus: report.candidatePreflightNow.status,
		applyAllowed: report.applyAllowed,
		requirementsChanged: report.requirementChanges.filter(
			(change) => change.change !== "unchanged",
		).length,
		gadgetsAdded: gadgetCount("added"),
		gadgetsChanged: gadgetCount("changed"),
		gadgetsRemoved: gadgetCount("removed"),
		blockingReasons: boundedReasons(report.blockingReasons),
		consentReasons: boundedReasons(report.consentReasons),
		resolvedAt: report.resolvedAt,
	};
}
