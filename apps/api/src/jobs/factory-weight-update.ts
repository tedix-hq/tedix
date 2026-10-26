import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type {
	CardReviewSource,
	FactoryWeightProposal,
} from "@tedix/api-contract/schemas/os-card-review";
import {
	OsGadgetManifestSchema,
	OsOutputContentSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	cellText,
	columnIndex,
	factorySourcesFromManifest,
	rowWrite,
} from "@tedix/api-contract/utils/card-review";
import {
	factoryWeightSamples,
	proposeFactoryWeights,
	weightProposalText,
} from "@tedix/api-contract/utils/card-review-weights";
import { applySheetRange } from "@tedix/api-contract/utils/sheet-range";
import type { DbClient } from "@tedix/db/client";
import {
	listFactoryWeightProposals,
	saveFactoryWeightProposals,
} from "@tedix/db/queries/factory-weights";
import { listFactoryVerdictEvents } from "@tedix/db/queries/learning-feedback";
import {
	createOsGadgetRevision,
	listCardSourceApps,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	createOsOutputRevision,
	getActiveSheetByTitle,
} from "@tedix/db/queries/os-workspaces/outputs";

/**
 * Weekly factory weight update. For every Card review or Deck factory source
 * whose `scoring.weightUpdate.mode` is shadow or enforce, it fits new feature
 * weights from that source's verdicts and keeps the proposal and its report
 * on the organization. Shadow stops there. Enforce also writes the proposal
 * into the source's rules sheet as a proposed rule; once a person accepts
 * that row, a later pass writes the stored weights into the app's config as
 * a new app revision. Nothing is applied without that acceptance.
 */

const JOB_ACTOR = "factory-weight-update";
const DAY_MS = 86_400_000;
/** Weekly cadence; an hour of slack keeps a daily tick from slipping a day. */
const CADENCE_MS = 7 * DAY_MS - 3_600_000;
const LOOKBACK_MS = 90 * DAY_MS;
const EVENT_LIMIT = 2_000;
const APP_LIMIT = 200;
const EMPTY_ACCESS_ENVELOPE = JSON.stringify({ version: 1, sources: [] });

type Manifest = Record<string, unknown> & {
	config?: Record<string, unknown>;
};
type SourcePath = "sources" | "factorySources";

export type WeightUnit = {
	organizationId: string;
	gadgetId: string;
	revision: number;
	manifest: Manifest;
	path: SourcePath;
	index: number;
	source: CardReviewSource;
};

export type WeightUpdateCounts = {
	sources: number;
	insufficient: number;
	noChange: number;
	shadow: number;
	proposed: number;
	pending: number;
	applied: number;
	rejected: number;
	stale: number;
	skipped: number;
	failed: number;
};

/** One factory source across apps: its workspace and label name its verdicts. */
export function factoryKey(
	source: Pick<CardReviewSource, "workspaceId" | "label">,
) {
	return `${source.workspaceId}|${source.label}`;
}

/** Sources with a shadow or enforce weight update, one unit per app source. */
export function weightUnits(
	rows: readonly {
		gadget: { id: string; organizationId: string };
		revision: { revision: number; manifest: string };
	}[],
): WeightUnit[] {
	return rows.flatMap((row) => {
		let manifest: Manifest;
		try {
			manifest = JSON.parse(row.revision.manifest) as Manifest;
		} catch {
			return [];
		}
		const found = factorySourcesFromManifest(manifest);
		if (!found) return [];
		return found.sources.flatMap((source, index) => {
			const mode = source.scoring?.weightUpdate?.mode;
			return mode === "shadow" || mode === "enforce"
				? [
						{
							organizationId: row.gadget.organizationId,
							gadgetId: row.gadget.id,
							revision: row.revision.revision,
							manifest,
							path: found.path,
							index,
							source,
						},
					]
				: [];
		});
	});
}

function sameWeights(
	a: Record<string, number> | undefined,
	b: Record<string, number> | undefined,
) {
	const left = a ?? {};
	const right = b ?? {};
	const names = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...names].every((name) => left[name] === right[name]);
}

function sameReviewerWeights(
	a: Record<string, Record<string, number>> | undefined,
	b: Record<string, Record<string, number>> | undefined,
) {
	const left = a ?? {};
	const right = b ?? {};
	const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...ids].every((id) => sameWeights(left[id], right[id]));
}

/**
 * The app's manifest with the proposal's weights written into every source
 * of this factory, or null when a source's weights changed since the
 * proposal (it is stale) or the result is not a valid manifest.
 */
export function manifestWithWeights(
	manifest: Manifest,
	units: readonly WeightUnit[],
	proposal: FactoryWeightProposal,
): Manifest | null {
	const next = structuredClone(manifest);
	for (const unit of units) {
		const list = next.config?.[unit.path];
		const raw = Array.isArray(list)
			? (list[unit.index] as Record<string, unknown> | undefined)
			: undefined;
		const scoring = raw?.scoring as Record<string, unknown> | undefined;
		if (!scoring) return null;
		if (
			!sameWeights(
				scoring.weights as Record<string, number> | undefined,
				proposal.previousWeights,
			) ||
			!sameReviewerWeights(
				scoring.reviewerWeights as
					| Record<string, Record<string, number>>
					| undefined,
				proposal.previousReviewerWeights,
			)
		)
			return null;
		scoring.weights = proposal.weights;
		if (Object.keys(proposal.reviewerWeights).length > 0)
			scoring.reviewerWeights = proposal.reviewerWeights;
		else delete scoring.reviewerWeights;
	}
	if (!OsGadgetManifestSchema.safeParse(next).success) return null;
	return factorySourcesFromManifest(next) ? next : null;
}

async function rulesSheet(
	db: DbClient,
	organizationId: string,
	source: CardReviewSource,
) {
	if (!source.rules) return null;
	const sheet = await getActiveSheetByTitle(db, {
		organizationId,
		workspaceId: source.workspaceId,
		title: source.rules.sheetTitle,
	});
	if (!sheet) return null;
	const content = OsOutputContentSchema.safeParse(
		JSON.parse(sheet.revision.content),
	);
	if (!content.success || content.data.kind !== "sheet") return null;
	return { sheet, content: content.data, rules: source.rules };
}

/** The rules row status for a proposal's rule id, lowercased; "" when absent. */
async function ruleStatus(
	db: DbClient,
	organizationId: string,
	source: CardReviewSource,
	ruleId: string,
) {
	const found = await rulesSheet(db, organizationId, source);
	if (!found) return "";
	const { content, rules } = found;
	const id = columnIndex(content.columns, rules.idColumn);
	const status = columnIndex(content.columns, rules.statusColumn);
	if (id < 0 || status < 0) return "";
	const row = content.rows.find((cells) => cellText(cells[id]) === ruleId);
	return row ? cellText(row[status]).toLowerCase() : "";
}

/** Append the proposal as a proposed rule; false when the sheet cannot take it. */
async function proposeRule(
	db: DbClient,
	organizationId: string,
	source: CardReviewSource,
	ruleId: string,
	text: string,
) {
	const found = await rulesSheet(db, organizationId, source);
	if (!found) return false;
	const { sheet, content, rules } = found;
	const body = { columns: content.columns, rows: content.rows };
	let range: ReturnType<typeof rowWrite>;
	try {
		range = rowWrite(body, content.rows.length, {
			[rules.idColumn]: ruleId,
			[rules.textColumn]: text,
			[rules.statusColumn]: "proposed",
		});
	} catch {
		return false;
	}
	const next = OsOutputContentSchema.safeParse(
		applySheetRange(
			content,
			content.rows.length,
			range.startColumn,
			range.cells,
		),
	);
	if (!next.success) return false;
	const result = await createOsOutputRevision(db, {
		id: crypto.randomUUID(),
		organizationId,
		outputId: sheet.output.id,
		content: JSON.stringify(next.data),
		note: `Weekly weight proposal ${ruleId} for ${source.label}`,
		createdByKind: "service",
		createdById: JOB_ACTOR,
		accessEnvelope: EMPTY_ACCESS_ENVELOPE,
		expectedRevision: sheet.revision.revision,
	});
	return result.ok;
}

/** Write accepted weights into every enforce app source of this factory. */
async function applyProposal(
	db: DbClient,
	units: readonly WeightUnit[],
	proposal: FactoryWeightProposal,
) {
	const enforce = units.filter(
		(unit) => unit.source.scoring?.weightUpdate?.mode === "enforce",
	);
	const byGadget = new Map<string, WeightUnit[]>();
	for (const unit of enforce)
		byGadget.set(unit.gadgetId, [...(byGadget.get(unit.gadgetId) ?? []), unit]);
	const appliedTo: { gadgetId: string; revision: number }[] = [];
	for (const [gadgetId, own] of byGadget) {
		const first = own[0]!;
		const manifest = manifestWithWeights(first.manifest, own, proposal);
		if (!manifest) return { status: "stale" as const, appliedTo };
		const result = await createOsGadgetRevision(db, {
			id: crypto.randomUUID(),
			organizationId: first.organizationId,
			gadgetId,
			manifest: JSON.stringify(manifest),
			sourceArtifactRef: `factory-weights:${proposal.id}`,
			createdByKind: "service",
			createdById: JOB_ACTOR,
			expectedRevision: first.revision,
		});
		if (!result.ok) return { status: "stale" as const, appliedTo };
		appliedTo.push({ gadgetId, revision: result.revision.revision });
	}
	return {
		status: appliedTo.length > 0 ? ("applied" as const) : ("stale" as const),
		appliedTo,
	};
}

/** One organization's pass; returns its proposals after the pass. */
export async function updateOrganizationFactoryWeights(
	db: DbClient,
	organizationId: string,
	units: readonly WeightUnit[],
	now: Date,
	counts: WeightUpdateCounts,
) {
	const proposals = await listFactoryWeightProposals(db, organizationId);
	const groups = new Map<string, WeightUnit[]>();
	for (const unit of units)
		groups.set(factoryKey(unit.source), [
			...(groups.get(factoryKey(unit.source)) ?? []),
			unit,
		]);
	let changed = false;
	const upsert = (proposal: FactoryWeightProposal) => {
		const index = proposals.findIndex(
			(entry) => entry.factoryKey === proposal.factoryKey,
		);
		if (index >= 0) proposals[index] = proposal;
		else proposals.push(proposal);
		changed = true;
	};
	for (const [key, group] of groups) {
		counts.sources += 1;
		const primary = group.find((unit) => unit.source.rules) ?? group[0]!;
		const mode = group.some(
			(unit) => unit.source.scoring?.weightUpdate?.mode === "enforce",
		)
			? ("enforce" as const)
			: ("shadow" as const);
		const latest = proposals.find((entry) => entry.factoryKey === key);
		if (latest?.status === "proposed" && latest.ruleId) {
			const status = await ruleStatus(
				db,
				organizationId,
				primary.source,
				latest.ruleId,
			);
			if (status === "accepted") {
				const applied =
					mode === "enforce"
						? await applyProposal(db, group, latest)
						: { status: "stale" as const, appliedTo: [] };
				upsert({
					...latest,
					status: applied.status,
					decidedAt: now.toISOString(),
					...(applied.appliedTo.length ? { appliedTo: applied.appliedTo } : {}),
				});
				counts[applied.status] += 1;
			} else if (status === "rejected") {
				upsert({ ...latest, status: "rejected", decidedAt: now.toISOString() });
				counts.rejected += 1;
			} else counts.pending += 1;
			continue;
		}
		if (latest && now.getTime() - Date.parse(latest.createdAt) < CADENCE_MS) {
			counts.skipped += 1;
			continue;
		}
		const events = await listFactoryVerdictEvents(db, {
			organizationId,
			classPrefix: `factory:${primary.source.label}:`,
			since: new Date(now.getTime() - LOOKBACK_MS).toISOString(),
			limit: EVENT_LIMIT,
		});
		const fitted = proposeFactoryWeights({
			source: primary.source,
			samples: factoryWeightSamples(primary.source, events),
		});
		const { status: fitStatus, ...fit } = fitted;
		const ruleId = `weights-${now.toISOString().slice(0, 10)}`;
		let status: FactoryWeightProposal["status"] =
			fitStatus === "ready" ? "shadow" : fitStatus;
		let note = fit.report.note;
		if (fitStatus === "ready" && mode === "enforce") {
			const written = await proposeRule(
				db,
				organizationId,
				primary.source,
				ruleId,
				weightProposalText(fit),
			);
			if (written) status = "proposed";
			else
				note = "No rules sheet with id, text and status columns to propose in";
		}
		upsert({
			id: crypto.randomUUID(),
			factoryKey: key,
			sourceLabel: primary.source.label,
			workspaceId: primary.source.workspaceId,
			mode,
			createdAt: now.toISOString(),
			status,
			ruleId: status === "proposed" ? ruleId : null,
			...fit,
			report: { ...fit.report, ...(note ? { note } : {}) },
		});
		if (status === "insufficient") counts.insufficient += 1;
		else if (status === "no_change") counts.noChange += 1;
		else if (status === "proposed") counts.proposed += 1;
		else counts.shadow += 1;
	}
	if (changed) await saveFactoryWeightProposals(db, organizationId, proposals);
	return proposals;
}

export async function updateFactoryWeights(db: DbClient, now: Date) {
	const counts: WeightUpdateCounts = {
		sources: 0,
		insufficient: 0,
		noChange: 0,
		shadow: 0,
		proposed: 0,
		pending: 0,
		applied: 0,
		rejected: 0,
		stale: 0,
		skipped: 0,
		failed: 0,
	};
	const rows = await listCardSourceApps(db, {
		weightUpdateOnly: true,
		limit: APP_LIMIT,
	});
	const byOrg = new Map<string, WeightUnit[]>();
	for (const unit of weightUnits(rows))
		byOrg.set(unit.organizationId, [
			...(byOrg.get(unit.organizationId) ?? []),
			unit,
		]);
	for (const [organizationId, units] of byOrg) {
		try {
			await updateOrganizationFactoryWeights(
				db,
				organizationId,
				units,
				now,
				counts,
			);
		} catch (error) {
			counts.failed += 1;
			console.error(
				JSON.stringify({
					event: "factory_weight_update_failed",
					organizationId,
					exception: safeExceptionTopology(error),
				}),
			);
		}
	}
	return counts;
}
