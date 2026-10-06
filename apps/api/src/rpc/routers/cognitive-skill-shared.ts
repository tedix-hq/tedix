/** Shared skill-entry mechanics for the cognitive router slices. */

import {
	nextSkillScheduleFireAt,
	type SkillSchedulePolicy,
	validateSkillSchedulePolicy,
} from "@tedix/api-contract/utils/skill-schedule";
import {
	formatAdjacencyRefusal,
	scoreSkillAdjacency,
} from "@tedix/context-core/skill-adjacency";
import { getAppBySlug } from "@tedix/db/queries/apps";
import { createSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { listSkillsForAdjacency } from "@tedix/db/queries/cognitive/skill-search";
import { resolveToolSlugsForApp } from "@tedix/db/queries/cognitive/skill-tool-metadata";
import {
	type SkillValidationIssue,
	type SkillValidationResult,
	validateSkillInput,
} from "@tedix/db/queries/cognitive/skill-validation";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import {
	deleteSkillSchedule,
	getSkillSchedule,
	upsertSkillSchedule,
} from "@tedix/db/queries/skill-schedules";
import type { SkillEntry, SkillSchedule } from "@tedix/db/schema/cognitive";
import { toJsonRecord } from "@tedix/db/utils/json";
import { parseDocument } from "yaml";
import { episodeTraceId } from "../episode-trace";
import { type BaseContext, createError, ErrorCodes } from "../orpc";
import { insertRuntimeEvent } from "./cognitive-runtime/events-policy";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { adviseSkillAdjacency } from "../../services/jev-skill-adjacency";
import { JevUsagePersistenceError } from "../../services/jev-judgment";

export function compactPromotionCandidate(entry: SkillEntry) {
	return {
		id: entry.id,
		title: entry.title,
		slug: entry.slug,
		summary: entry.summary,
		description: entry.description,
		tags: entry.tags,
		toolIds: entry.toolIds,
		successCount: entry.successCount,
		revision: entry.revision,
		audience: entry.audience,
		appId: entry.appId,
		r2Path: entry.r2Path,
		lifecycleState: entry.lifecycleState,
		paceLayer: entry.paceLayer,
		tediId: entry.tediId,
		domainId: entry.domainId,
		failureCount: entry.failureCount,
		lastUsedAt: entry.lastUsedAt,
		avgDurationMs: entry.avgDurationMs,
		visibility: entry.visibility,
		preconditions: entry.preconditions,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
}

/** Coerce comma-separated strings to arrays (MCP tools may send strings). Returns null for falsy values. */
export function coerceArray(val: unknown): string[] | null {
	if (!val) return null;
	if (Array.isArray(val)) return val as string[];
	if (typeof val === "string")
		return val
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	return null;
}

/** Like coerceArray but returns undefined instead of null — for partial update objects where undefined means "omit field". */
export function coerceArrayOptional(val: unknown): string[] | undefined {
	if (val === undefined) return undefined;
	if (!val) return undefined;
	if (Array.isArray(val)) return val as string[];
	if (typeof val === "string")
		return val
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	return undefined;
}

export const MCP_TOOLS_METADATA_KEY = "io.modelcontextprotocol/tools";

function uniqueStrings(values: Iterable<string | null | undefined>): string[] {
	return [
		...new Set(
			[...values].map((value) => value?.trim()).filter(Boolean) as string[],
		),
	];
}

function coerceToolNames(value: unknown): string[] {
	if (Array.isArray(value)) {
		return uniqueStrings(value.flatMap((item) => coerceToolNames(item)));
	}
	if (typeof value !== "string") return [];
	return uniqueStrings(
		value
			.split(/[\s,]+/)
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

function parseSkillFrontmatter(content?: string): Record<string, unknown> {
	if (!content?.startsWith("---")) return {};
	const end = content.indexOf("\n---", 3);
	if (end === -1) return {};
	const raw = content.slice(3, end);
	try {
		const parsed = parseDocument(raw, { prettyErrors: false }).toJSON();
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function stripSkillFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	let body = content.slice(end + "\n---".length);
	if (body.startsWith("\r\n")) body = body.slice(2);
	else if (body.startsWith("\n")) body = body.slice(1);
	return body.trimStart();
}

export function extractMcpToolMetadata(content?: string): string[] {
	const frontmatter = parseSkillFrontmatter(content);
	const metadata = isRecord(frontmatter.metadata)
		? frontmatter.metadata
		: undefined;
	return uniqueStrings([
		...coerceToolNames(metadata?.[MCP_TOOLS_METADATA_KEY]),
		...coerceToolNames(frontmatter[MCP_TOOLS_METADATA_KEY]),
	]);
}

export function mergeToolSlugsFromInputAndMetadata(input: {
	toolSlugs?: string[];
	content?: string;
}): { allToolSlugs: string[]; metadataToolSlugs: string[] } {
	const metadataToolSlugs = extractMcpToolMetadata(input.content);
	return {
		metadataToolSlugs,
		allToolSlugs: uniqueStrings([
			...(input.toolSlugs ?? []),
			...metadataToolSlugs,
		]),
	};
}

// =============================================================================
// SKILLS
// =============================================================================

/**
 * Resolve appId from `input.appId` or `input.appSlug` (slug → UUID lookup).
 * Throws BAD_REQUEST if appSlug is given but unresolvable, or if both differ.
 */
export async function resolveAppId(
	context: BaseContext,
	input: { appId?: string; appSlug?: string },
): Promise<string | null> {
	if (input.appId) return input.appId;
	if (input.appSlug) {
		const app = await getAppBySlug(context.db, input.appSlug);
		if (!app)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`appSlug "${input.appSlug}" not found`,
			);
		return app.id;
	}
	return null;
}

/**
 * Apply validation result against the gate mode. Throws BAD_REQUEST for "error",
 * logs warnings for "warn", silent for "skip". Returns the non-blocking issues
 * so record/improve can surface them in the response body — CLI/tedi callers
 * never see Worker console logs.
 */
export function applyValidationGate(
	result: SkillValidationResult,
	mode: "error" | "warn" | "skip",
): SkillValidationIssue[] {
	if (mode === "skip") return [];
	if (mode === "warn") {
		const all = [...result.errors, ...result.warnings];
		if (all.length > 0) {
			console.warn(
				"[skills.validate]",
				all.map((i) => `${i.code}:${i.message}`).join("; "),
			);
		}
		return all;
	}
	// mode === "error"
	if (result.errors.length > 0) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Skill validation failed: ${result.errors.map((e) => e.code).join(", ")}`,
			{ errors: result.errors, warnings: result.warnings },
		);
	}
	if (result.warnings.length > 0) {
		// Don't block, but surface in logs
		console.warn(
			"[skills.validate.warnings]",
			result.warnings.map((w) => `${w.code}:${w.message}`).join("; "),
		);
	}
	return result.warnings;
}

export function validatedSkillSchedule(
	skillDoc: string,
	tediId: string | null | undefined,
): SkillSchedulePolicy | null {
	const { schedule, issues } = validateSkillSchedulePolicy(skillDoc);
	if (issues.length > 0) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Skill schedule validation failed: ${issues.map(({ code }) => code).join(", ")}`,
			{ errors: issues },
		);
	}
	if (schedule && !tediId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"SKILL_SCHEDULE_INVALID: a scheduled skill must have an owning tediId",
		);
	}
	return schedule;
}

export async function syncSkillScheduleProjection(
	context: BaseContext,
	entry: SkillEntry,
	schedule: SkillSchedulePolicy | null,
): Promise<void> {
	if (
		!schedule ||
		entry.lifecycleState === "draft" ||
		entry.lifecycleState === "stale" ||
		entry.lifecycleState === "archived"
	) {
		await deleteSkillSchedule(context.db, entry.id);
		return;
	}
	if (!entry.tediId) {
		throw new Error("scheduled skill lost its owning tedi identity");
	}
	const existing = await getSkillSchedule(context.db, entry.id);
	const nextFireAt =
		existing?.cron === schedule.cron &&
		existing.nextFireAt > new Date().toISOString()
			? existing.nextFireAt
			: nextSkillScheduleFireAt(schedule.cron, Date.now());
	await upsertSkillSchedule(context.db, {
		organizationId: entry.organizationId,
		skillId: entry.id,
		tediId: entry.tediId,
		cron: schedule.cron,
		params: toJsonRecord(schedule.params),
		enabled: schedule.enabled,
		nextFireAt,
	});
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

export function expectedSkillScheduleProjection(
	entry: SkillEntry,
	schedule: SkillSchedulePolicy | null,
) {
	if (
		!schedule ||
		entry.lifecycleState === "draft" ||
		entry.lifecycleState === "stale" ||
		entry.lifecycleState === "archived"
	) {
		return null;
	}
	return {
		skillId: entry.id,
		tediId: entry.tediId,
		cron: schedule.cron,
		params: schedule.params,
		enabled: schedule.enabled,
	};
}

export function storedSkillScheduleProjection(
	schedule: SkillSchedule | undefined,
) {
	return schedule
		? {
				skillId: schedule.skillId,
				tediId: schedule.tediId,
				cron: schedule.cron,
				params: schedule.params,
				enabled: schedule.enabled,
			}
		: null;
}

export function skillScheduleProjectionMatches(
	entry: SkillEntry,
	manifestSchedule: SkillSchedulePolicy | null,
	storedSchedule: SkillSchedule | undefined,
): boolean {
	return (
		canonicalJson(expectedSkillScheduleProjection(entry, manifestSchedule)) ===
		canonicalJson(storedSkillScheduleProjection(storedSchedule))
	);
}

export async function createSkillFromInput(
	context: BaseContext,
	orgId: string,
	input: {
		title: string;
		folderPath?: string;
		description?: string;
		content: string;
		files?: Record<string, string>;
		domain?: string;
		tediId?: string;
		inputSchema?: Record<string, unknown>;
		visibility?: "private" | "shared" | "org";
		revisionReasoning?: string;
		agentSkillsFormat?: string;
		r2Path?: string;
		appId?: string;
		appSlug?: string;
		toolIds?: string[] | string;
		toolSlugs?: string[];
		summary?: string;
		tags?: string[] | string;
		audience?: string[];
		preconditions?: {
			requires?: string[];
			notWhen?: string[];
			validUntil?: string;
			staleSince?: string;
		};
		lifecycleState?: SkillEntry["lifecycleState"];
		validate?: "error" | "warn" | "skip";
		/** Bypass the create-vs-modify adjacency gate for a genuinely new procedure. */
		force?: boolean;
		sourceSkillId?: string;
		sourceRevision?: number;
	},
): Promise<{ entry: SkillEntry; warnings: SkillValidationIssue[] }> {
	if (input.lifecycleState != null && input.lifecycleState !== "draft") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"new skills must start as draft; execute the draft before promotion, or use the existing human/operator override on skills.improve or Skill Workshop apply",
			{
				code: "SKILL_LIFECYCLE_TRANSITION_BLOCKED",
				from: "draft",
				to: input.lifecycleState,
				rule: "new_skills_start_draft",
			},
		);
	}
	const schedule = validatedSkillSchedule(input.content, input.tediId);
	const domain = await getOrCreateDomain(
		context.db,
		orgId,
		input.domain ?? "general",
	);
	const visibility = input.visibility ?? (input.tediId ? "private" : "org");

	const appId = await resolveAppId(context, input);
	const { allToolSlugs, metadataToolSlugs } =
		mergeToolSlugsFromInputAndMetadata(input);

	if (input.toolSlugs?.length && !appId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"toolSlugs requires appId or appSlug for resolution scope",
		);
	}

	const validateMode = input.validate ?? "error";
	let gateWarnings: SkillValidationIssue[] = [];
	if (validateMode !== "skip") {
		const result = await validateSkillInput(
			context.db,
			{
				title: input.title,
				description: input.description,
				summary: input.summary,
				content: input.content,
				files: input.files ?? null,
				toolSlugs: allToolSlugs,
				metadataToolSlugs,
			},
			appId,
		);
		gateWarnings = applyValidationGate(result, validateMode);
	}

	const explicitToolIds = coerceArray(input.toolIds) ?? [];
	let mergedToolIds: string[] | null = explicitToolIds.length
		? [...explicitToolIds]
		: null;
	if (allToolSlugs.length && appId) {
		const { resolvedIds, unresolved } = await resolveToolSlugsForApp(
			context.db,
			appId,
			allToolSlugs,
		);
		if (unresolved.length > 0 && validateMode === "error") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`toolSlugs not found in app_tools for app ${appId}: ${unresolved.join(", ")}`,
			);
		}
		const merged = new Set([...(mergedToolIds ?? []), ...resolvedIds]);
		mergedToolIds = merged.size ? [...merged] : null;
	}

	// ADJACENCY GATE (create-vs-modify). `record_skills` and `improve_skills` are
	// both available to every agent and the choice is left to the model, so the
	// recurring failure is a near-identical twin that splits retrieval ranking
	// and makes a later `improve_skills` ambiguous. Refuse the create and point
	// at the modify call instead. Lexical on purpose — a create-blocking gate
	// must not depend on the vector index, which can (and did) fail open.
	// Fail-soft on lookup error: never block authoring because a search failed.
	let adjacencyWarning: string | null = null;
	let semanticAdjacencyWarning: string | null = null;
	let adjacencyRefusal: string | null = null;
	if (!input.force) {
		// The lookup is the only fallible part; scoring is pure. Keep the throw
		// OUTSIDE the catch so a refusal can never be mistaken for a lookup error.
		try {
			const allCandidates = await listSkillsForAdjacency(context.db, orgId, {
				tediId: input.tediId,
			});
			// Derivatives intentionally resemble their sourceSkillId baseline and
			// sibling proposals. Exclude that lineage from duplicate scoring;
			// adjacency compares the derivative against the rest of the library.
			const candidates = input.sourceSkillId
				? allCandidates.filter(
						(candidate) =>
							candidate.id !== input.sourceSkillId &&
							candidate.sourceSkillId !== input.sourceSkillId,
					)
				: allCandidates;
			const verdict = scoreSkillAdjacency(
				{ title: input.title, description: input.description ?? null },
				candidates,
			);
			if (verdict.blocked && verdict.nearest) {
				adjacencyRefusal = formatAdjacencyRefusal(verdict.nearest);
			} else if (verdict.adjacent.length > 0) {
				adjacencyWarning = `Similar existing skill(s): ${verdict.adjacent
					.slice(0, 3)
					.map(
						(m) =>
							`${m.candidate.slug ?? m.candidate.id} (${(m.score * 100).toFixed(0)}%)`,
					)
					.join(", ")}`;
				// Ask Jev whether a near miss is the same reusable procedure.
				// It can only advise: the lexical refusal above remains the
				// deterministic creation gate and no model verdict changes lifecycle.
				try {
					const episodeTrace = episodeTraceId(context.headers);
					const semanticMatch = await adviseSkillAdjacency({
						db: context.db,
						env: context.env,
						context: {
							organizationId: orgId,
							...(context.tediId ? { tediId: context.tediId } : {}),
							...(episodeTrace ? { runId: episodeTrace } : {}),
						},
						proposed: {
							title: input.title,
							description: input.description,
						},
						candidates: verdict.adjacent.map((match) => match.candidate),
					});
					if (semanticMatch)
						semanticAdjacencyWarning = `This skill may repeat ${semanticMatch.slug ?? semanticMatch.id}; review that skill and consider improve_skills before creating another procedure.`;
				} catch (error) {
					// Provider unavailability cannot turn a warning into a write gate.
					// A paid response whose usage could not be persisted is different:
					// the caller must see the reconciliation failure.
					if (error instanceof JevUsagePersistenceError) throw error;
					console.warn(
						"[skills.record] semantic adjacency unavailable:",
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		} catch (error) {
			if (error instanceof JevUsagePersistenceError) throw error;
			console.warn(
				"[skills.record] adjacency lookup failed; allowing create:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	if (adjacencyRefusal) {
		throw createError(ErrorCodes.CONFLICT, adjacencyRefusal);
	}

	const entry = await createSkillEntry(context.db, {
		id: crypto.randomUUID(),
		organizationId: orgId,
		tediId: input.tediId ?? null,
		domainId: domain.id,
		title: input.title,
		folderPath: input.folderPath ?? null,
		description: input.description ?? null,
		content: input.content,
		files: input.files ?? null,
		inputSchema:
			input.inputSchema === undefined ? null : toJsonRecord(input.inputSchema),
		visibility,
		revisionReasoning: input.revisionReasoning ?? null,
		agentSkillsFormat: input.agentSkillsFormat ?? null,
		r2Path: input.r2Path ?? null,
		appId: appId ?? null,
		toolIds: mergedToolIds,
		summary: input.summary ?? null,
		tags: coerceArray(input.tags),
		audience: coerceArray(input.audience),
		preconditions: input.preconditions ?? null,
		lifecycleState: "draft",
		sourceSkillId: input.sourceSkillId ?? null,
		sourceRevision: input.sourceRevision ?? null,
		// Disposer separation: record the authoring agent identity so
		// apply-time gating can mechanically reject self-approval. Null when a
		// human/operator authored the entry.
		proposedByTediId: context.tediId ?? null,
	});
	await syncSkillScheduleProjection(context, entry, schedule);
	// Cognitive-event bridge — put skill crystallization on the runtime
	// spine. Tedi-scoped skills only (org-level skills have no tediId to key on).
	if (entry.tediId) {
		const episodeTrace = episodeTraceId(context.headers);
		context.waitUntil?.(
			insertRuntimeEvent(context, {
				organizationId: orgId,
				tediId: entry.tediId,
				kind: "skill.crystallized",
				...(episodeTrace ? { runtimeMetadata: { traceId: episodeTrace } } : {}),
				payload: {
					skillEntryId: entry.id,
					title: entry.title,
					domainId: entry.domainId,
				},
				createdAt: entry.createdAt ?? undefined,
			}).catch((err) =>
				console.warn("[CognitiveBridge] skill.crystallized emit failed:", err),
			),
		);
	}
	return {
		entry,
		// Near-misses that did not cross the block floor are reported, never
		// silently dropped — the author should still consider improve_skills.
		warnings: [
			...gateWarnings,
			...(adjacencyWarning
				? [{ code: "SKILL_ADJACENCY_NEAR_MISS", message: adjacencyWarning }]
				: []),
			...(semanticAdjacencyWarning
				? [
						{
							code: "SKILL_SEMANTIC_ADJACENCY",
							message: semanticAdjacencyWarning,
						},
					]
				: []),
		],
	};
}
