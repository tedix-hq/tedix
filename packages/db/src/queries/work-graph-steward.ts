/**
 * Work-graph steward — deterministic coherence verifier + repairer for the org
 * `work_items` / `projects` graph.
 *
 * The steward answers "do we need a background workflow that constantly verifies
 * and fixes to keep everyone on track": it detects duplicates, idle accepted
 * specifications, naming defects, and expired attempts. Safe apply mode links
 * duplicate clusters and leaves
 * `steward_flag` comments for everything a human must decide. It NEVER deletes,
 * cancels, or rewrites titles.
 *
 * Everything is deterministic (NO LLM, NO embeddings) and windowed/capped for the
 * 10s D1 gateway budget; `truncated` flags a cap hit. Modeled on the work
 * hierarchy build (88660adfe) and the fact-lifecycle maintenance pattern.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { projects } from "../schema/projects";
import {
	type WorkItemDisposition,
	type WorkItemKind,
	type WorkItemReadiness,
	workAttempts,
	workItemComments,
	workItemRelations,
	workItems,
} from "../schema/work-items";
import { addWorkItemRelation } from "./work-items/relations";
import { chunkForBoundParams } from "../utils/batch";
import { deriveWorkItemReadiness } from "./work-items/readiness";
import { errorMessage } from "@tedix/worker-kit/error-message";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default idle horizon before an accepted specification is flagged. */
const DEFAULT_IDLE_THRESHOLD_DAYS = 14;
/** Default title similarity threshold for near-duplicate clustering. */
const DEFAULT_DUP_THRESHOLD = 0.85;
/** Default cap on items pulled into the (bounded) duplicate/naming scan. */
const DEFAULT_SCAN_CAP = 500;
/** Cap on rows read by idle-work and expired-attempt detectors. */
const DEFAULT_DETECTOR_CAP = 500;
/** Default cap on write actions performed per category on an apply run. */
const DEFAULT_ACTION_LIMIT = 200;
/** IN() chunk size for id batch fetches (D1 100-bound-param cap). */
const IN_LIST_CHUNK = 80;

/**
 * Non-terminal dispositions fed into the duplicate + naming scan.
 */
const NON_TERMINAL_STATUSES: WorkItemDisposition[] = ["proposed", "accepted"];

/**
 * Accepted specifications eligible for the idle-work report.
 */
const IDLE_TARGET_DISPOSITIONS: WorkItemDisposition[] = ["accepted"];

const MAX_TITLE_LENGTH = 200;

export type WorkGraphNamingIssue =
	| "empty_title"
	| "overlong_title"
	| "tier_violation"
	| "orphan_project"
	| "unfiled_project_match"
	| "orphan_parent";

export type WorkGraphStewardActionName = "link_duplicates" | "flag";

export interface WorkGraphDuplicateCluster {
	/** Oldest member (stable canonical) — others are linked as its duplicates. */
	canonicalWorkItemId: string;
	duplicateWorkItemIds: string[];
	/** Every member id, canonical first. */
	workItemIds: string[];
	normalizedTitle: string;
	/** `exact` = every member shares the normalized title; `jaccard` = near-match. */
	method: "exact" | "jaccard";
	suggestedAction: "link_duplicates";
}

/** One accepted WorkSpec whose activity age exceeds the observation horizon. */
export interface WorkGraphIdleAcceptedFinding {
	workItemId: string;
	title: string;
	disposition: WorkItemDisposition;
	readiness: WorkItemReadiness;
	lastActivityAt: string;
	idleDays: number;
	suggestedAction: "review_idle";
}

export interface WorkGraphNamingFinding {
	workItemId: string;
	issue: WorkGraphNamingIssue;
	detail: string;
	suggestedAction: "flag";
}

export interface WorkGraphExpiredAttemptFinding {
	workItemId: string;
	executorType: "tedi" | "external_agent";
	executorId: string;
	executorSessionId: string | null;
	attemptId: string;
	expiresAt: string | null;
	suggestedAction: "flag";
}

export interface WorkGraphHealthReport {
	orgId: string;
	projectId: string | null;
	generatedAt: string;
	idleThresholdDays: number;
	dupThreshold: number;
	scannedCount: number;
	duplicates: WorkGraphDuplicateCluster[];
	idleAccepted: WorkGraphIdleAcceptedFinding[];
	naming: WorkGraphNamingFinding[];
	expiredAttempts: WorkGraphExpiredAttemptFinding[];
	counts: {
		duplicateClusters: number;
		duplicateItems: number;
		idleAccepted: number;
		naming: number;
		expiredAttempts: number;
	};
	truncated: {
		/** The recent-items scan hit `scanCap` — dup/naming coverage is partial. */
		scan: boolean;
		idleAccepted: boolean;
		expiredAttempts: boolean;
	};
}

export interface WorkGraphStewardOutcome {
	applied: boolean;
	report: WorkGraphHealthReport;
	actions: {
		linkedDuplicateClusters: number;
		linkedDuplicateRelations: number;
		flaggedNaming: number;
		flaggedExpiredAttempts: number;
		duplicateComments: number;
	};
	errors: string[];
}

export interface GetWorkGraphHealthParams {
	orgId: string;
	projectId?: string;
	idleThresholdDays?: number;
	dupThreshold?: number;
	scanCap?: number;
	/** Cap for the expensive idle-readiness and expired-attempt detectors. */
	detectorCap?: number;
	now?: string;
}

export interface RunWorkGraphStewardParams {
	orgId: string;
	now?: string;
	apply?: boolean;
	projectId?: string;
	idleThresholdDays?: number;
	dupThreshold?: number;
	scanCap?: number;
	actions?: WorkGraphStewardActionName[];
	/** Per-category write cap on an apply run. */
	limit?: number;
}

// ============================================================================
// Deterministic title normalization + similarity (NO LLM, NO embeddings)
// ============================================================================

/**
 * Normalize a title for comparison: lowercase, strip punctuation to spaces,
 * collapse whitespace, trim. Unicode-aware so non-ASCII org titles compare
 * fairly. Pure/deterministic — the whole duplicate detector rests on this.
 */
export function normalizeWorkItemTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Token set of a normalized title. Exported as the single source of truth for
 * "how a normalized title becomes comparison tokens" so re-users (the campaign
 * decomposer's near-duplicate skip) share the steward's exact tokenization
 * rather than re-deriving it.
 */
export function tokenSet(normalized: string): Set<string> {
	return new Set(normalized.split(" ").filter(Boolean));
}

/** Token-set Jaccard similarity in [0,1]. Two empty sets are identical (1). */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection += 1;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

interface ScannedItem {
	id: string;
	title: string;
	workKind: WorkItemKind;
	disposition: WorkItemDisposition;
	projectId: string | null;
	parentWorkItemId: string | null;
	createdAt: string;
	updatedAt: string | null;
}

interface DupCluster {
	contextKey: string;
	normalizedTitle: string;
	tokens: Set<string>;
	members: ScannedItem[];
	hasNearMatch: boolean;
}

/**
 * Greedy deterministic clustering over the scanned items sorted oldest-first, so
 * the first (canonical) member of each cluster is the ORIGINAL. An item joins the
 * first cluster it either exactly matches (normalized) or is Jaccard-similar to
 * at least `dupThreshold`; otherwise it seeds a new cluster. Items with an empty
 * normalized title are skipped (the naming detector owns `empty_title`).
 */
export function clusterDuplicateTitles(
	items: ScannedItem[],
	dupThreshold: number,
): WorkGraphDuplicateCluster[] {
	const sorted = [...items].sort((a, b) => {
		if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	const clusters: DupCluster[] = [];
	for (const item of sorted) {
		const normalized = normalizeWorkItemTitle(item.title);
		if (!normalized) continue;
		const tokens = tokenSet(normalized);
		// Duplicate prevention is sibling-scoped. The same action title can be
		// legitimate in two campaigns, two epics, or at different hierarchy tiers.
		const contextKey = [
			item.projectId ?? "no-project",
			item.parentWorkItemId ?? "root",
			item.workKind,
		].join(":");
		let placed = false;
		for (const cluster of clusters) {
			if (cluster.contextKey !== contextKey) continue;
			const exact = cluster.normalizedTitle === normalized;
			if (exact || jaccardSimilarity(tokens, cluster.tokens) >= dupThreshold) {
				cluster.members.push(item);
				if (!exact) cluster.hasNearMatch = true;
				placed = true;
				break;
			}
		}
		if (!placed) {
			clusters.push({
				contextKey,
				normalizedTitle: normalized,
				tokens,
				members: [item],
				hasNearMatch: false,
			});
		}
	}

	return clusters
		.filter((cluster) => cluster.members.length >= 2)
		.map((cluster) => {
			const ids = cluster.members.map((member) => member.id);
			return {
				canonicalWorkItemId: ids[0]!,
				duplicateWorkItemIds: ids.slice(1),
				workItemIds: ids,
				normalizedTitle: cluster.normalizedTitle,
				method: cluster.hasNearMatch ? "jaccard" : "exact",
				suggestedAction: "link_duplicates",
			} satisfies WorkGraphDuplicateCluster;
		});
}

// ============================================================================
// Detectors
// ============================================================================

/**
 * Long-idle accepted WorkSpecs. This is an observation, not a business-state
 * transition: disposition remains accepted and readiness is derived by the
 * canonical readiness evaluator. Capped + `truncated` reported.
 */
export async function findIdleAcceptedWorkItems(
	db: DbClient,
	params: {
		orgId: string;
		now: string;
		idleThresholdDays: number;
		projectId?: string;
		limit?: number;
	},
): Promise<{ findings: WorkGraphIdleAcceptedFinding[]; truncated: boolean }> {
	const limit = params.limit ?? DEFAULT_DETECTOR_CAP;
	const nowMs = Date.parse(params.now);
	const cutoff = new Date(
		nowMs - params.idleThresholdDays * DAY_MS,
	).toISOString();
	const conditions = [
		eq(workItems.orgId, params.orgId),
		inArray(workItems.disposition, IDLE_TARGET_DISPOSITIONS),
		lt(sql`coalesce(${workItems.updatedAt}, ${workItems.createdAt})`, cutoff),
	];
	if (params.projectId) {
		conditions.push(eq(workItems.projectId, params.projectId));
	}
	const rows = await db
		.select({
			id: workItems.id,
			title: workItems.title,
			disposition: workItems.disposition,
			createdAt: workItems.createdAt,
			updatedAt: workItems.updatedAt,
		})
		.from(workItems)
		.where(and(...conditions))
		.orderBy(sql`coalesce(${workItems.updatedAt}, ${workItems.createdAt}) asc`)
		.limit(limit + 1);

	const truncated = rows.length > limit;
	const findings = await Promise.all(
		rows.slice(0, limit).map(async (row) => {
			const lastActivityAt = row.updatedAt ?? row.createdAt;
			const idleDays = Math.max(
				0,
				Math.floor((nowMs - Date.parse(lastActivityAt)) / DAY_MS),
			);
			const readiness = await deriveWorkItemReadiness(db, {
				orgId: params.orgId,
				workItemId: row.id,
				derivedAt: params.now,
			});
			return {
				workItemId: row.id,
				title: row.title,
				disposition: row.disposition,
				readiness: readiness.state,
				lastActivityAt,
				idleDays,
				suggestedAction: "review_idle" as const,
			};
		}),
	);
	return { findings, truncated };
}

/**
 * Active attempts whose authoritative expiry has elapsed. The steward only
 * reports them; atomic attempt replacement owns the expiry transition.
 */
export async function findExpiredAttempts(
	db: DbClient,
	params: { orgId: string; now: string; projectId?: string; limit?: number },
): Promise<{ findings: WorkGraphExpiredAttemptFinding[]; truncated: boolean }> {
	const limit = params.limit ?? DEFAULT_DETECTOR_CAP;
	const conditions = [
		eq(workAttempts.orgId, params.orgId),
		inArray(workAttempts.runtimeState, [
			"queued",
			"running",
			"waiting",
			"retrying",
		]),
	];
	if (params.projectId)
		conditions.push(eq(workItems.projectId, params.projectId));
	const attempts = await db
		.select({
			id: workAttempts.id,
			workItemId: workAttempts.workItemId,
			executorType: workAttempts.executorType,
			executorId: workAttempts.executorId,
			executorSessionId: workAttempts.executorSessionId,
			expiresAt: workAttempts.expiresAt,
		})
		.from(workAttempts)
		.innerJoin(
			workItems,
			and(
				eq(workItems.id, workAttempts.workItemId),
				eq(workItems.orgId, params.orgId),
			),
		)
		.where(and(...conditions))
		.orderBy(workAttempts.startedAt)
		.limit(limit + 1);

	const truncated = attempts.length > limit;
	const scoped = attempts.slice(0, limit);
	if (scoped.length === 0) return { findings: [], truncated };

	const findings: WorkGraphExpiredAttemptFinding[] = [];
	for (const attempt of scoped) {
		if (attempt.expiresAt && attempt.expiresAt < params.now) {
			findings.push({
				workItemId: attempt.workItemId,
				executorType: attempt.executorType,
				executorId: attempt.executorId,
				executorSessionId: attempt.executorSessionId,
				attemptId: attempt.id,
				expiresAt: attempt.expiresAt,
				suggestedAction: "flag",
			});
		}
	}
	return { findings, truncated };
}

/**
 * Full read-only coherence report over an org's work graph. Every query is
 * windowed/capped for the 10s gateway budget; `truncated` flags a cap hit.
 */
export async function getWorkGraphHealth(
	db: DbClient,
	params: GetWorkGraphHealthParams,
): Promise<WorkGraphHealthReport> {
	const now = params.now ?? new Date().toISOString();
	const idleThresholdDays =
		params.idleThresholdDays ?? DEFAULT_IDLE_THRESHOLD_DAYS;
	const dupThreshold = params.dupThreshold ?? DEFAULT_DUP_THRESHOLD;
	const scanCap = params.scanCap ?? DEFAULT_SCAN_CAP;
	const detectorCap = params.detectorCap ?? DEFAULT_DETECTOR_CAP;

	// One bounded scan of the most-recent non-terminal items feeds BOTH the
	// duplicate clustering and the naming detector.
	const scanConditions = [
		eq(workItems.orgId, params.orgId),
		inArray(workItems.disposition, NON_TERMINAL_STATUSES),
	];
	if (params.projectId) {
		scanConditions.push(eq(workItems.projectId, params.projectId));
	}
	const scanRows = await db
		.select({
			id: workItems.id,
			title: workItems.title,
			workKind: workItems.workKind,
			disposition: workItems.disposition,
			projectId: workItems.projectId,
			parentWorkItemId: workItems.parentWorkItemId,
			createdAt: workItems.createdAt,
			updatedAt: workItems.updatedAt,
		})
		.from(workItems)
		.where(and(...scanConditions))
		.orderBy(desc(workItems.createdAt))
		.limit(scanCap + 1);

	const scanTruncated = scanRows.length > scanCap;
	const scanned: ScannedItem[] = scanRows.slice(0, scanCap);

	const duplicates = clusterDuplicateTitles(scanned, dupThreshold);
	const naming = await detectNamingIssues(db, params.orgId, scanned);
	const idleResult = await findIdleAcceptedWorkItems(db, {
		orgId: params.orgId,
		now,
		idleThresholdDays,
		projectId: params.projectId,
		limit: detectorCap,
	});
	const expiredAttemptResult = await findExpiredAttempts(db, {
		orgId: params.orgId,
		now,
		projectId: params.projectId,
		limit: detectorCap,
	});

	return {
		orgId: params.orgId,
		projectId: params.projectId ?? null,
		generatedAt: now,
		idleThresholdDays,
		dupThreshold,
		scannedCount: scanned.length,
		duplicates,
		idleAccepted: idleResult.findings,
		naming,
		expiredAttempts: expiredAttemptResult.findings,
		counts: {
			duplicateClusters: duplicates.length,
			duplicateItems: duplicates.reduce(
				(sum, cluster) => sum + cluster.duplicateWorkItemIds.length,
				0,
			),
			idleAccepted: idleResult.findings.length,
			naming: naming.length,
			expiredAttempts: expiredAttemptResult.findings.length,
		},
		truncated: {
			scan: scanTruncated,
			idleAccepted: idleResult.truncated,
			expiredAttempts: expiredAttemptResult.truncated,
		},
	};
}

/**
 * Naming / structural-consistency defects over the scanned set: empty or
 * overlong titles, an orphan project ref (missing / cross-org / archived), and
 * an orphan parent ref (missing / cross-org). Parent and project rows are
 * batch-fetched by id (chunked) so this stays inside the gateway budget; the
 * org's project keys are fetched once, and only when an unlinked row is present.
 */
/** Project identity usable for title matching: its key and its name. */
interface ProjectTitleEntry {
	id: string;
	key: string;
	needles: string[];
}

/** Words too generic to identify a project from a title mention. */
const TITLE_MATCH_MIN_LENGTH = 4;

/**
 * Does this title name a project?
 *
 * Deliberately conservative and REPORT-ONLY. A title mention is evidence that a
 * human should look, never grounds to move work: "Compare Acme visibility
 * with direct competitors" mentions a client but legitimately belongs to a
 * marketing project, and auto-filing it would be wrong. The steward's job here
 * is to end the silence, not to decide ownership.
 *
 * Matches on word boundaries against the project key and name so `ACME` does
 * not match `acmesearch`, and skips needles under
 * {@link TITLE_MATCH_MIN_LENGTH} because two- and three-letter keys produce
 * noise rather than signal.
 */
function projectNamedInTitle(
	title: string,
	index: ProjectTitleEntry[],
): ProjectTitleEntry | null {
	const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
	for (const entry of index) {
		for (const needle of entry.needles) {
			if (haystack.includes(` ${needle} `)) return entry;
		}
	}
	return null;
}

async function detectNamingIssues(
	db: DbClient,
	orgId: string,
	scanned: ScannedItem[],
): Promise<WorkGraphNamingFinding[]> {
	const findings: WorkGraphNamingFinding[] = [];

	const parentIds = [
		...new Set(
			scanned
				.map((item) => item.parentWorkItemId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	const projectIds = [
		...new Set(
			scanned
				.map((item) => item.projectId)
				.filter((id): id is string => Boolean(id)),
		),
	];

	const parentMap = new Map<
		string,
		{ orgId: string; workKind: WorkItemKind }
	>();
	for (const ids of chunkForBoundParams(parentIds, IN_LIST_CHUNK)) {
		const rows = await db
			.select({
				id: workItems.id,
				orgId: workItems.orgId,
				workKind: workItems.workKind,
			})
			.from(workItems)
			.where(inArray(workItems.id, ids));
		for (const row of rows) {
			parentMap.set(row.id, { orgId: row.orgId, workKind: row.workKind });
		}
	}

	const projectMap = new Map<string, { orgId: string; status: string }>();
	for (const ids of chunkForBoundParams(projectIds, IN_LIST_CHUNK)) {
		const rows = await db
			.select({
				id: projects.id,
				orgId: projects.orgId,
				status: projects.status,
			})
			.from(projects)
			.where(inArray(projects.id, ids));
		for (const row of rows) {
			projectMap.set(row.id, { orgId: row.orgId, status: row.status });
		}
	}

	const projectTitleIndex: ProjectTitleEntry[] = [];
	// One read serves both the label resolver and the title matcher.
	if (scanned.some((item) => !item.projectId)) {
		const rows = await db
			.select({ id: projects.id, key: projects.key, name: projects.name })
			.from(projects)
			.where(and(eq(projects.orgId, orgId), ne(projects.status, "archived")));
		for (const row of rows) {
			const needles = [row.key, row.name]
				.flatMap((value) =>
					String(value ?? "")
						.toLowerCase()
						.split(/[^a-z0-9]+/),
				)
				.filter((word) => word.length >= TITLE_MATCH_MIN_LENGTH);
			if (needles.length > 0) {
				projectTitleIndex.push({
					id: row.id,
					key: row.key,
					needles: [...new Set(needles)],
				});
			}
		}
	}

	for (const item of scanned) {
		if (item.title.trim().length === 0) {
			findings.push({
				workItemId: item.id,
				issue: "empty_title",
				detail: "Work item has an empty or whitespace-only title.",
				suggestedAction: "flag",
			});
		} else if (item.title.length > MAX_TITLE_LENGTH) {
			findings.push({
				workItemId: item.id,
				issue: "overlong_title",
				detail: `Title is ${item.title.length} chars (> ${MAX_TITLE_LENGTH}).`,
				suggestedAction: "flag",
			});
		}

		if (item.parentWorkItemId) {
			const parent = parentMap.get(item.parentWorkItemId);
			if (!parent) {
				findings.push({
					workItemId: item.id,
					issue: "orphan_parent",
					detail: `parentWorkItemId ${item.parentWorkItemId} does not exist.`,
					suggestedAction: "flag",
				});
			} else if (parent.orgId !== orgId) {
				findings.push({
					workItemId: item.id,
					issue: "orphan_parent",
					detail: `parentWorkItemId ${item.parentWorkItemId} belongs to another org.`,
					suggestedAction: "flag",
				});
			}
		}

		if (item.projectId) {
			const project = projectMap.get(item.projectId);
			if (!project) {
				findings.push({
					workItemId: item.id,
					issue: "orphan_project",
					detail: `projectId ${item.projectId} does not exist.`,
					suggestedAction: "flag",
				});
			} else if (project.orgId !== orgId) {
				findings.push({
					workItemId: item.id,
					issue: "orphan_project",
					detail: `projectId ${item.projectId} belongs to another org.`,
					suggestedAction: "flag",
				});
			} else if (project.status === "archived") {
				findings.push({
					workItemId: item.id,
					issue: "orphan_project",
					detail: `projectId ${item.projectId} is archived.`,
					suggestedAction: "flag",
				});
			}
		} else {
			// Neither FK nor label, but the TITLE names a project. This is the gap
			// `unlinked_project` cannot see: a batch of items carried no project
			// reference at all and simply drifted, so a whole client engagement
			// rolled up as two items until someone went looking.
			const named = projectNamedInTitle(item.title, projectTitleIndex);
			if (named) {
				findings.push({
					workItemId: item.id,
					issue: "unfiled_project_match",
					detail: `Title names project "${named.key}" (${named.id}) but the item is filed under no project. Confirm before linking — a title mention is a hint, not ownership.`,
					suggestedAction: "flag",
				});
			}
		}
	}

	return findings;
}

// ============================================================================
// Actions (gated by `apply`)
// ============================================================================

/**
 * Insert a deterministic-id steward comment, deduped on the primary key so a
 * re-run never double-flags. Returns true only when a NEW row was written.
 */
async function insertStewardComment(
	db: DbClient,
	params: {
		id: string;
		workItemId: string;
		orgId: string;
		body: string;
		metadata: Record<string, JsonValue>;
		createdAt: string;
	},
): Promise<boolean> {
	const rows = await db
		.insert(workItemComments)
		.values({
			id: params.id,
			workItemId: params.workItemId,
			orgId: params.orgId,
			authorType: "system",
			authorId: "work-graph-steward",
			body: params.body,
			metadata: params.metadata,
			createdAt: params.createdAt,
		})
		.onConflictDoNothing()
		.returning({ id: workItemComments.id });
	return rows.length > 0;
}

/** Does a `duplicates` relation from → to already exist? (idempotency guard) */
async function duplicateRelationExists(
	db: DbClient,
	fromWorkItemId: string,
	toWorkItemId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: workItemRelations.id })
		.from(workItemRelations)
		.where(
			and(
				eq(workItemRelations.fromWorkItemId, fromWorkItemId),
				eq(workItemRelations.toWorkItemId, toWorkItemId),
				eq(workItemRelations.relationType, "duplicates"),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * Run the steward. `apply=false` (default) is a pure dry-run preview — it returns
 * the report and zeroed action counts, mutating nothing. `apply=true` performs
 * only SAFE, idempotent repairs for the requested `actions`:
 *   - `link_duplicates`: link each cluster's duplicates → its canonical original
 *     with a `duplicates` relation (unique-index deduped) and drop a
 *     `steward_flag` comment. It NEVER cancels a duplicate — that stays a human
 *     call.
 *   - `flag`: leave a `steward_flag` comment on naming findings and expired
 *     attempts.
 * Titles are never rewritten and nothing is deleted. Each category is fail-soft
 * (errors collected, never thrown) and capped at `limit` writes.
 */
export async function runWorkGraphSteward(
	db: DbClient,
	params: RunWorkGraphStewardParams,
): Promise<WorkGraphStewardOutcome> {
	const now = params.now ?? new Date().toISOString();
	const apply = params.apply ?? false;
	const limit = params.limit ?? DEFAULT_ACTION_LIMIT;
	const actions = new Set<WorkGraphStewardActionName>(
		params.actions ?? ["link_duplicates", "flag"],
	);

	const report = await getWorkGraphHealth(db, {
		orgId: params.orgId,
		projectId: params.projectId,
		idleThresholdDays: params.idleThresholdDays,
		dupThreshold: params.dupThreshold,
		scanCap: params.scanCap,
		detectorCap: limit,
		now,
	});

	const outcome: WorkGraphStewardOutcome = {
		applied: apply,
		report,
		actions: {
			linkedDuplicateClusters: 0,
			linkedDuplicateRelations: 0,
			flaggedNaming: 0,
			flaggedExpiredAttempts: 0,
			duplicateComments: 0,
		},
		errors: [],
	};

	if (!apply) return outcome;

	// (b) Link duplicate clusters (safe) — never auto-cancel a duplicate.
	if (actions.has("link_duplicates")) {
		let relationBudget = limit;
		for (const cluster of report.duplicates) {
			if (relationBudget <= 0) break;
			let clusterLinked = false;
			for (const duplicateId of cluster.duplicateWorkItemIds) {
				if (relationBudget <= 0) break;
				try {
					const already = await duplicateRelationExists(
						db,
						duplicateId,
						cluster.canonicalWorkItemId,
					);
					if (!already) {
						await addWorkItemRelation(db, {
							id: crypto.randomUUID(),
							orgId: params.orgId,
							fromWorkItemId: duplicateId,
							toWorkItemId: cluster.canonicalWorkItemId,
							relationType: "duplicates",
							metadata: {
								source: "work-graph-steward",
								method: cluster.method,
							},
							createdAt: now,
						});
						outcome.actions.linkedDuplicateRelations += 1;
						relationBudget -= 1;
						clusterLinked = true;
					}
					const commented = await insertStewardComment(db, {
						id: `${duplicateId}:steward:duplicate_of:${cluster.canonicalWorkItemId}`,
						workItemId: duplicateId,
						orgId: params.orgId,
						body: `Work-graph steward flagged this as a likely duplicate of ${cluster.canonicalWorkItemId} (${cluster.method} title match). Linked as \`duplicates\`; cancellation is a human/operator decision.`,
						metadata: {
							kind: "duplicate",
							canonicalWorkItemId: cluster.canonicalWorkItemId,
							method: cluster.method,
						},
						createdAt: now,
					});
					if (commented) outcome.actions.duplicateComments += 1;
				} catch (error) {
					outcome.errors.push(
						`link_duplicates ${duplicateId}: ${errorMessage(error)}`,
					);
				}
			}
			if (clusterLinked) outcome.actions.linkedDuplicateClusters += 1;
		}
	}

	// (c) Flag naming findings + expired attempts (never mutate disposition).
	if (actions.has("flag")) {
		let flagBudget = limit;
		for (const finding of report.naming) {
			if (flagBudget <= 0) break;
			try {
				const commented = await insertStewardComment(db, {
					id: `${finding.workItemId}:steward:naming:${finding.issue}`,
					workItemId: finding.workItemId,
					orgId: params.orgId,
					body: `Work-graph steward flagged a naming/consistency issue (${finding.issue}): ${finding.detail}`,
					metadata: { kind: "naming", issue: finding.issue },
					createdAt: now,
				});
				if (commented) {
					outcome.actions.flaggedNaming += 1;
					flagBudget -= 1;
				}
			} catch (error) {
				outcome.errors.push(
					`flag_naming ${finding.workItemId}: ${errorMessage(error)}`,
				);
			}
		}
		for (const finding of report.expiredAttempts) {
			if (flagBudget <= 0) break;
			try {
				const commented = await insertStewardComment(db, {
					id: `${finding.workItemId}:steward:expired-attempt:${finding.attemptId}`,
					workItemId: finding.workItemId,
					orgId: params.orgId,
					body: `Work-graph steward flagged an expired attempt held by ${finding.executorType} ${finding.executorId}. This comment records the recovery gap.`,
					metadata: {
						kind: "expired_attempt",
						executorType: finding.executorType,
						executorId: finding.executorId,
						executorSessionId: finding.executorSessionId,
						attemptId: finding.attemptId,
					},
					createdAt: now,
				});
				if (commented) {
					outcome.actions.flaggedExpiredAttempts += 1;
					flagBudget -= 1;
				}
			} catch (error) {
				outcome.errors.push(
					`flag_expired_attempt ${finding.workItemId}: ${errorMessage(error)}`,
				);
			}
		}
	}

	return outcome;
}

/**
 * Distinct org ids that currently hold at least one non-terminal work item —
 * the fleet enumeration the daily steward cron loops over (mirrors the
 * fact-lifecycle sweep's per-org groupBy). Capped so one dark org can't unbound
 * the scheduled handler.
 */
export async function listOrgIdsWithOpenWorkItems(
	db: DbClient,
	params?: { limit?: number },
): Promise<string[]> {
	const rows = await db
		.select({ orgId: workItems.orgId })
		.from(workItems)
		.where(inArray(workItems.disposition, NON_TERMINAL_STATUSES))
		.groupBy(workItems.orgId)
		.limit(params?.limit ?? 100);
	return rows.map((row) => row.orgId);
}
