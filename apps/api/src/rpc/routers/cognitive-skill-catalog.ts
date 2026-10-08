/** CRUD, catalog, validation-preview, repair, and promotion handlers. */

import { getAppById } from "@tedix/db/queries/app-records";
import {
	listSkillSummariesByApp,
	listSkillSummariesByApps,
	listSkillsByApp,
} from "@tedix/db/queries/cognitive/skill-catalog";
import {
	deleteSkillEntry,
	getNonArchivedSkillEntryBySlug,
	getSkillEntry,
	getSkillEntryBySlug,
	getSkillEntryForMcp,
	updateSkillEntry,
} from "@tedix/db/queries/cognitive/skill-crud";
import {
	listAllSkillsForOrg,
	listSkillPromotionCandidates,
} from "@tedix/db/queries/cognitive/skill-inventory";
import { moveSkillToFolder } from "@tedix/db/queries/cognitive/skill-folders";
import {
	computeSkillPromotion,
	computeSkillPromotionBlockers,
} from "@tedix/db/queries/cognitive/skill-promotion";
import { auditLowQualitySkills } from "@tedix/db/queries/cognitive/skill-quality";
import { computeSkillRepairs } from "@tedix/db/queries/cognitive/skill-repair";
import { findSkillForTask } from "@tedix/db/queries/cognitive/skill-search";
import { resolveToolSlugsForApp } from "@tedix/db/queries/cognitive/skill-tool-metadata";
import {
	type SkillValidationIssue,
	slugify,
	validateSkillInput,
} from "@tedix/db/queries/cognitive/skill-validation";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import { sweepExpiredDraftSkills } from "@tedix/db/queries/skill-lifecycle";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import { recordSkillUsageEvent } from "@tedix/db/queries/skill-usage";
import { getTediOrganizationId } from "@tedix/db/queries/tedis";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import { withTransientD1ReadRetry } from "@tedix/db/utils/d1-retry";
import { toJsonRecord } from "@tedix/db/utils/json";
import { assertSkillPromotionPremortem } from "../../services/decision-hygiene";
import {
	AUTHZ,
	createError,
	createScopeMiddleware,
	ErrorCodes,
	withPermission,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import {
	effectiveSkillPaceLayer,
	isSkillContentMutation,
	recordLayerApprovalRequired,
	requireHumanSkillActivation,
	requireLifecycleOverrideAuthority,
	updateSkillEntryGated,
	WORKFLOW_IMPROVEMENT_TAG,
} from "./cognitive-skill-governance";
import {
	applyValidationGate,
	coerceArray,
	coerceArrayOptional,
	compactPromotionCandidate,
	createSkillFromInput,
	expectedSkillScheduleProjection,
	MCP_TOOLS_METADATA_KEY,
	mergeToolSlugsFromInputAndMetadata,
	resolveAppId,
	skillScheduleProjectionMatches,
	storedSkillScheduleProjection,
	stripSkillFrontmatter,
	syncSkillScheduleProjection,
	validatedSkillSchedule,
} from "./cognitive-skill-shared";
import {
	assertScheduleEditAuthority,
	authedSkills,
	isLifecycleOverrideAuthority,
	sha256Digest,
	skillSchedulePolicyChanged,
} from "./cognitive-shared";

export const skillsRecord = authedSkills.record
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { entry, warnings } = await createSkillFromInput(
			context,
			orgId,
			input,
		);
		return { entry, ...(warnings.length ? { warnings } : {}) };
	});

export const skillsImprove = authedSkills.improve
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const existing = await getSkillEntry(context.db, input.id, orgId);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");

		// Layer-scaled governance: record-layer (crystallized) skills are
		// systems of record. Content/workflow mutations by agent-authenticated
		// callers require human/operator approval (policy-pack
		// paceLayerPolicy.record.approvalRequired, default true) — the same
		// allowlist as the capability-mutation gate. Human users and operator
		// API keys pass.
		if (
			isSkillContentMutation(input) &&
			effectiveSkillPaceLayer(existing) === "record" &&
			!isLifecycleOverrideAuthority(context) &&
			(await recordLayerApprovalRequired(context, existing))
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"record-layer skill mutation requires approval: content/workflow updates to a crystallized (record-layer) skill need a signed-in human or an operator API key; agent-authenticated callers cannot mutate systems of record directly",
				{
					code: "RECORD_LAYER_MUTATION_REQUIRES_APPROVAL",
					skillId: existing.id,
					paceLayer: "record",
				},
			);
		}

		// P5 decision hygiene parity: improve can move lifecycle and mutate
		// record-layer content directly, so it runs the same Klein-2007
		// premortem gate as promote/apply — armed when a lifecycle target is
		// requested or the skill's substance is mutated, required when the
		// promotion touches the record layer. Operators may skip with a logged
		// skipPremortemReason; agent callers can never skip.
		const premortemGate =
			input.lifecycleState !== undefined || isSkillContentMutation(input)
				? assertSkillPromotionPremortem({
						existing,
						// Unlike promote, improve without a lifecycle input leaves the
						// state unchanged — gate on the CURRENT state, not the
						// default-promotion target.
						targetLifecycleState:
							input.lifecycleState ?? existing.lifecycleState ?? "draft",
						premortem: input.premortem,
						skipReason: input.skipPremortemReason,
						operatorAuthority: isLifecycleOverrideAuthority(context),
					})
				: null;
		const revisionReasoningWithPremortem = premortemGate?.auditLine
			? input.revisionReasoning
				? `${input.revisionReasoning}\n${premortemGate.auditLine}`
				: premortemGate.auditLine
			: input.revisionReasoning;

		// Owner-only schedule edits: a free-text agent turn batch-disabled eight
		// schedules on skills it did not own. Structural comparison —
		// prose/formatting edits never trip the gate; only a changed schedule
		// policy does. The attach-only tediId in THIS call counts as the owner for
		// an ownerless skill (same chicken-and-egg rule the schedule validator uses).
		if (
			input.content !== undefined &&
			skillSchedulePolicyChanged(existing.content ?? "", input.content)
		) {
			assertScheduleEditAuthority(context, {
				id: existing.id,
				owningTediId:
					existing.tediId ?? (input.tediId !== undefined ? input.tediId : null),
			});
		}

		if (input.slug !== undefined && input.slug !== existing.slug) {
			const canonicalSlug = slugify(input.slug);
			if (canonicalSlug !== input.slug) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Skill slug must already be canonical lowercase kebab-case",
				);
			}
			const collision = await getNonArchivedSkillEntryBySlug(
				context.db,
				orgId,
				canonicalSlug,
			);
			if (collision && collision.id !== existing.id) {
				throw createError(
					ErrorCodes.CONFLICT,
					`Skill slug ${canonicalSlug} is already owned by a non-archived skill`,
				);
			}
		}

		// Resolve domain if changed
		let domainId: string | undefined;
		if (input.domain !== undefined) {
			const domain = await getOrCreateDomain(context.db, orgId, input.domain);
			domainId = domain.id;
		}

		// Resolve appId (from appId or appSlug). Falls back to existing.appId for toolSlug scope.
		const resolvedAppId = await resolveAppId(context, input);
		const scopeAppId = resolvedAppId ?? existing.appId ?? null;
		const effectiveContent = input.content ?? existing.content;
		// The would-be owner: an attach-only tediId in THIS call must count, or
		// attaching an owner and declaring a schedule in one improve is a
		// chicken-and-egg rejection (observed live: the combined call 400'd on
		// "must have an owning tediId" while the row it was about to fix sat
		// tedi-less).
		const schedule = validatedSkillSchedule(
			effectiveContent,
			input.tediId ?? existing.tediId,
		);
		const { allToolSlugs, metadataToolSlugs } =
			mergeToolSlugsFromInputAndMetadata({
				toolSlugs: input.toolSlugs,
				content: effectiveContent,
			});

		// Guard: explicit toolSlugs requires an app scope. Frontmatter metadata
		// may still be validated as a warning when the scope is missing.
		if (input.toolSlugs?.length && !scopeAppId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"toolSlugs requires appId or appSlug for resolution scope",
			);
		}

		// Validation gate. Improve allows partial input — fall back to existing values.
		const validateMode = input.validate ?? "error";
		let gateWarnings: SkillValidationIssue[] = [];
		if (validateMode !== "skip") {
			const result = await validateSkillInput(
				context.db,
				{
					title: input.title ?? existing.title,
					description: input.description ?? existing.description ?? undefined,
					summary: input.summary ?? existing.summary ?? undefined,
					content: effectiveContent,
					files: input.files ?? existing.files ?? null,
					toolSlugs: allToolSlugs,
					metadataToolSlugs,
					mcpAppBindings: existing.mcpAppBindings,
					organizationId: existing.organizationId,
				},
				scopeAppId,
			);
			gateWarnings = applyValidationGate(result, validateMode);
		}

		// Resolve toolSlugs → UUIDs and merge with toolIds (or existing toolIds).
		let toolIdsUpdate: string[] | undefined;
		if (input.toolIds !== undefined || allToolSlugs.length) {
			const explicit =
				input.toolIds !== undefined
					? (coerceArrayOptional(input.toolIds) ?? [])
					: ((existing.toolIds as string[] | null | undefined) ?? []);
			const slugIds: string[] = [];
			if (allToolSlugs.length && scopeAppId) {
				const { resolvedIds, unresolved } = await resolveToolSlugsForApp(
					context.db,
					scopeAppId,
					allToolSlugs,
				);
				if (unresolved.length > 0 && validateMode === "error") {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`toolSlugs not found in app_tools for app ${scopeAppId}: ${unresolved.join(", ")}`,
					);
				}
				slugIds.push(...resolvedIds);
			}
			const merged = new Set([...explicit, ...slugIds]);
			toolIdsUpdate = [...merged];
		}

		// Attach-only ownership. A tedi-less skill (every skill authored before
		// the skill-native-scheduling ADR) cannot register a schedule — the
		// scheduler executes under the owning tedi identity. Attaching an owner is
		// not an authority escalation: this write already requires org authority
		// over the skill. TRANSFERRING ownership is, and is rejected here.
		if (input.tediId !== undefined) {
			if (existing.tediId && existing.tediId !== input.tediId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Skill ownership transfer is not supported via improve — the skill already has an owning tedi",
				);
			}
			const tediOrg = await getTediOrganizationId(context.db, input.tediId);
			if (tediOrg !== orgId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"tediId does not belong to this organization",
				);
			}
		}

		const forceLifecycle = input.force === true;
		if (forceLifecycle) requireLifecycleOverrideAuthority(context);
		// Manual pace-layer override rides the same force-authority path as
		// lifecycle overrides (auto-derived from lifecycle otherwise).
		if (input.paceLayer !== undefined && !forceLifecycle) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"paceLayer is auto-derived from lifecycle; a manual override requires force: true (human/operator authority)",
				{ code: "SKILL_PACE_LAYER_OVERRIDE_BLOCKED" },
			);
		}
		await updateSkillEntryGated(
			context,
			input.id,
			{
				...(input.slug !== undefined ? { slug: input.slug } : {}),
				...(input.title !== undefined ? { title: input.title } : {}),
				...(input.content !== undefined ? { content: input.content } : {}),
				...(input.files !== undefined ? { files: input.files } : {}),
				...(input.description !== undefined
					? { description: input.description }
					: {}),
				...(input.visibility !== undefined
					? { visibility: input.visibility }
					: {}),
				...(domainId !== undefined ? { domainId } : {}),
				...(revisionReasoningWithPremortem !== undefined
					? { revisionReasoning: revisionReasoningWithPremortem }
					: {}),
				...(input.inputSchema !== undefined
					? { inputSchema: toJsonRecord(input.inputSchema) }
					: {}),
				...(input.agentSkillsFormat !== undefined
					? { agentSkillsFormat: input.agentSkillsFormat }
					: {}),
				...(resolvedAppId !== null ? { appId: resolvedAppId } : {}),
				...(toolIdsUpdate !== undefined ? { toolIds: toolIdsUpdate } : {}),
				...(input.summary !== undefined ? { summary: input.summary } : {}),
				...(input.tags !== undefined
					? { tags: coerceArrayOptional(input.tags) }
					: {}),
				...(input.audience !== undefined
					? { audience: coerceArrayOptional(input.audience) }
					: {}),
				...(input.preconditions !== undefined
					? { preconditions: input.preconditions }
					: {}),
				...(input.lifecycleState !== undefined
					? { lifecycleState: input.lifecycleState }
					: {}),
				...(input.paceLayer !== undefined
					? { paceLayer: input.paceLayer }
					: {}),
				...(input.tediId !== undefined && !existing.tediId
					? { tediId: input.tediId }
					: {}),
				revision: existing.revision + 1,
			},
			// requireLifecycleOverrideAuthority above proved human/apikey.
			forceLifecycle
				? { force: true, forceAuthority: { kind: "operator" } }
				: undefined,
		);

		const updated = await getSkillEntry(context.db, input.id, orgId);

		if (updated) {
			await syncSkillScheduleProjection(context, updated, schedule);
		}

		return {
			entry: updated!,
			...(gateWarnings.length ? { warnings: gateWarnings } : {}),
		};
	});

export const skillsDelete = authedSkills.delete
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const existing = await getSkillEntry(context.db, input.id, orgId);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		await deleteSkillEntry(context.db, input.id, orgId);
		return { success: true };
	});

export const skillsGet = authedSkills.get
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const entry = await getSkillEntry(context.db, input.id, orgId);
		return { entry: entry ?? null };
	});

export const skillsMove = authedSkills.move
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const existing = await getSkillEntry(context.db, input.id, orgId);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		await moveSkillToFolder(context.db, orgId, input.id, input.folderPath);
		const entry = await getSkillEntry(context.db, input.id, orgId);
		if (!entry) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		return { entry };
	});

/**
 * Summary projection for skill listings: a listing scan needs identity +
 * lifecycle + counters, not every row's full SKILL.md. `content` is required by SkillEntrySchema, so it becomes a marked preview
 * rather than being omitted — the marker points at read_skill so a truncated
 * body can never be mistaken for the real one. `files` is nullable and large;
 * summary nulls it.
 *
 * The marker names the SKILL, never a tool: `read_skill` is a tedi-runtime
 * native tool that is NOT mounted on tenant aggregates (a live tenant-gateway
 * call returns `Tool "read_skill" not found`), so pointing agents at it sent them
 * after a tool their surface does not have. Which lookup resolves a skill is
 * surface-dependent — on a tenant gateway it is `preview_skill({ id })` — so
 * the marker states the fact (this body is truncated) and leaves the caller to
 * use whatever fetch its own surface exposes.
 */
export function summarizeSkillEntry<
	T extends { content: string; files?: Record<string, string> | null },
>(entry: T): T {
	const preview = entry.content.slice(0, 280);
	return {
		...entry,
		content:
			entry.content.length > 280
				? `${preview}…\n[summary view — truncated; fetch this skill by id or slug for the full SKILL.md]`
				: entry.content,
		files: null,
	};
}

export const skillsListByOrg = authedSkills.listByOrg
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const project = input.summary ? summarizeSkillEntry : <T>(e: T) => e;

		const domainId = input.domain
			? (await getOrCreateDomain(context.db, orgId, input.domain)).id
			: undefined;

		const page = await listAllSkillsForOrg(context.db, orgId, {
			limit: input.limit,
			offset: input.offset,
			visibility: input.visibility,
			appId: input.appId,
			lifecycleState: input.lifecycleState,
			query: input.query,
			folderPath: input.folderPath,
			recursive: input.recursive,
			domainId,
			tediId: input.tediId,
		});
		return { ...page, entries: page.entries.map(project) };
	});

export const skillsFind = authedSkills.find
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const entries = await findSkillForTask(context.db, orgId, input.query, {
			tediId: input.tediId,
			appId: input.appId,
			limit: input.limit,
		});
		// Compact by default (GATEWAY-UX skills polish): a broad find over a
		// 100-skill library returned every full SKILL.md — the skills-layer
		// twin of the includeParameters discovery problem. summary: false is
		// the explicit full-body opt-out.
		const project =
			input.summary === false ? <T>(e: T) => e : summarizeSkillEntry;
		return { entries: entries.map(project) };
	});

export const skillsListByApp = authedSkills.listByApp
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const appId = await resolveAppId(context, input);
		if (!appId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Either appId or appSlug is required",
			);
		}

		if (input.summaryOnly) {
			const summaries = await withTransientD1ReadRetry(
				`skill summaries for app ${appId}`,
				() =>
					listSkillSummariesByApp(context.db, orgId, appId, {
						limit: input.limit,
						tediId: input.tediId,
						lifecycleState: input.lifecycleState,
					}),
			);
			return { skills: [], summaries };
		}

		const skills = await withTransientD1ReadRetry(
			`skills for app ${appId}`,
			() =>
				listSkillsByApp(context.db, orgId, appId, {
					limit: input.limit,
					tediId: input.tediId,
					lifecycleState: input.lifecycleState,
					slugs: input.slugs,
				}),
		);
		return { skills };
	});

export const skillsListSummariesByApps = authedSkills.listSummariesByApps
	.use(withPermission("tedis:read"))
	// Two-plane by construction (lint:authz --strict is shrink-only, so a new
	// rbac-only procedure is a hard fail). Safe for the caller that motivated
	// this endpoint: hasRequiredScope() short-circuits true for service-binding
	// auth, which is how apps/mcp reaches apps/api.
	.use(createScopeMiddleware("tedis:read"))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const byApp = await withTransientD1ReadRetry(
			`skill summaries for ${input.appIds.length} app(s)`,
			() =>
				listSkillSummariesByApps(context.db, orgId, input.appIds, {
					limit: input.limit,
					tediId: input.tediId,
					lifecycleState: input.lifecycleState,
				}),
		);
		return { summariesByApp: Object.fromEntries(byApp) };
	});

export const skillsListPromotionCandidates =
	authedSkills.listPromotionCandidates
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			const appId = await resolveAppId(context, input);
			const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
			const offset = Math.max(input.offset ?? 0, 0);
			const minSuccessCount = Math.max(input.minSuccessCount ?? 1, 0);
			const lifecycleStates =
				input.lifecycleStates?.length > 0
					? input.lifecycleStates
					: (["active", "proven"] as const);
			const { entries, total } = await listSkillPromotionCandidates(
				context.db,
				orgId,
				{
					appId: appId ?? undefined,
					tediId: input.tediId,
					lifecycleStates: [...lifecycleStates],
					minSuccessCount,
					limit,
					offset,
				},
			);
			return {
				entries: entries.map(compactPromotionCandidate),
				total,
				limit,
				offset,
				minSuccessCount,
				lifecycleStates: [...lifecycleStates],
			};
		});

export const skillsAuditLowQuality = authedSkills.auditLowQuality
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.archive && !input.slug && !input.confirmBulkArchive) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"archive=true requires slug or confirmBulkArchive=true",
			);
		}
		const ownership = input.ownership ?? "all";
		if (ownership === "baseline" && input.tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId cannot be combined with ownership=baseline",
			);
		}

		const appId = await resolveAppId(context, input);
		const result = await auditLowQualitySkills(context.db, orgId, {
			appId: appId ?? undefined,
			tediId: input.tediId,
			ownership,
			slug: input.slug,
			lifecycleStates: input.lifecycleStates,
			maxSuccessCount: input.maxSuccessCount,
			minSlugLength: input.minSlugLength,
			orphanOlderThanDays: input.orphanOlderThanDays,
			limit: input.limit,
			offset: input.offset,
		});

		let archivedCount = 0;
		if (input.archive) {
			for (const candidate of result.candidates) {
				const entry = candidate.entry;
				const existingReasoning = entry.revisionReasoning?.trim();
				const note = `Archived by audit_low_quality_skills: ${candidate.reasons.map((reason) => reason.code).join(", ")}`;
				await updateSkillEntry(context.db, entry.id, {
					lifecycleState: "archived",
					revision: (entry.revision ?? 1) + 1,
					revisionReasoning: existingReasoning
						? `${existingReasoning}\n${note}`
						: note,
				});
				archivedCount += 1;
			}
		}

		return {
			applied: input.archive,
			archivedCount,
			candidates: result.candidates.map((candidate) => {
				const entry = candidate.entry;
				return {
					id: entry.id,
					title: entry.title,
					slug: entry.slug,
					description: entry.description,
					tediId: entry.tediId,
					appId: entry.appId,
					lifecycleState: entry.lifecycleState,
					visibility: entry.visibility,
					successCount: entry.successCount,
					failureCount: entry.failureCount,
					lastUsedAt: entry.lastUsedAt,
					createdAt: entry.createdAt,
					updatedAt: entry.updatedAt,
					score: candidate.score,
					reasons: candidate.reasons,
				};
			}),
			limit: result.limit,
			offset: result.offset,
			ownership,
			scanned: result.scanned,
			total: result.total,
			warnings:
				result.scanned >= 1000
					? [
							"Audit scanned the first 1000 matching skills; narrow the app, tedi, slug, or lifecycle filters if results look incomplete.",
						]
					: [],
		};
	});

export const skillsSweepDraftTtl = authedSkills.sweepDraftTtl
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const result = await sweepExpiredDraftSkills(context.db, {
			organizationId: orgId,
			olderThanDays: input.olderThanDays,
			limit: input.limit,
			dryRun: input.dryRun,
		});
		if (!input.dryRun && result.archived > 0) {
			console.log(
				`[Skills] draft-TTL sweep archived ${result.archived} zero-use draft(s) for org ${orgId}: ${result.entries
					.map((entry) => entry.slug ?? entry.id)
					.join(", ")}`,
			);
		}
		return {
			applied: !input.dryRun,
			archived: result.archived,
			cutoff: result.cutoff,
			entries: result.entries,
		};
	});

export const skillsGetForMcp = authedSkills.getForMcp
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const entry = await getSkillEntryForMcp(context.db, orgId, input);
		return { entry: entry ?? null };
	});

export const skillsUsage = authedSkills.usage
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		// Verify ownership before updating
		const existing = await getSkillEntry(context.db, input.id, orgId);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		// Canonical-slot protection: a direct self-report whose runId names an
		// existing skill_runs row is rejected inside recordSkillUsageEvent
		// (recorded=false, reason "run_reserved") so it can never pre-claim the
		// (runId, executionEpoch) slot and suppress the terminal workflow stamp
		// — including failure stamps. Workflow outcomes only enter the ledger
		// via recordSkillRunOutcome at the skill-runtime terminal CAS.
		const outcome = await recordSkillUsageEvent(context.db, {
			organizationId: orgId,
			tediId: input.tediId ?? existing.tediId,
			skillId: existing.id,
			source: "direct",
			success: input.success,
			runId: input.runId,
			error: input.error,
			durationMs: input.durationMs,
		});
		const updated = await getSkillEntry(context.db, input.id, orgId);
		if (updated) {
			await syncSkillScheduleProjection(
				context,
				updated,
				validatedSkillSchedule(updated.content, updated.tediId),
			);
		}
		return {
			success: true,
			recorded: outcome.recorded,
			runId: outcome.runId,
			promotionEligible: false,
		};
	});

export const skillsPreview = authedSkills.preview
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		// Resolve appId (from appId or appSlug)
		const resolvedAppId = await resolveAppId(context, input);

		// If updating an existing skill, hydrate fallback values from the stored row.
		const existing = input.id
			? await getSkillEntry(context.db, input.id, orgId)
			: input.slug
				? await getSkillEntryBySlug(context.db, orgId, input.slug)
				: null;
		if ((input.id || input.slug) && !existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		}

		const scopeAppId = resolvedAppId ?? existing?.appId ?? null;

		const effectiveContent = input.content ?? existing?.content ?? "";
		const { allToolSlugs, metadataToolSlugs } =
			mergeToolSlugsFromInputAndMetadata({
				toolSlugs: input.toolSlugs,
				content: effectiveContent,
			});

		// Guard: explicit toolSlugs requires an app scope. Frontmatter metadata
		// remains previewable without a scope and is surfaced as a warning.
		if (input.toolSlugs?.length && !scopeAppId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"toolSlugs requires appId or appSlug for resolution scope",
			);
		}

		// Effective draft (input overrides existing for previewed updates).
		const effective = {
			title: input.title ?? existing?.title ?? "",
			description: input.description ?? existing?.description ?? undefined,
			summary: input.summary ?? existing?.summary ?? undefined,
			content: effectiveContent,
			files:
				input.files ??
				(existing?.files as Record<string, string> | undefined) ??
				null,
		};

		// Always validate (preview returns issues; never throws).
		const validation = await validateSkillInput(
			context.db,
			{
				title: effective.title,
				description: effective.description,
				summary: effective.summary,
				content: effective.content,
				files: effective.files,
				toolSlugs: allToolSlugs,
				metadataToolSlugs,
				mcpAppBindings: existing?.mcpAppBindings,
				organizationId: existing?.organizationId,
			},
			scopeAppId,
		);

		// Compute slug — prefer existing slug on update, else slugify title.
		const slug = existing?.slug ?? slugify(effective.title) ?? "";

		// Resolve toolSlugs → UUIDs and merge with explicit toolIds (and existing).
		const explicitToolIds = coerceArray(input.toolIds) ?? [];
		const baseToolIds: string[] =
			input.toolIds !== undefined
				? explicitToolIds
				: ((existing?.toolIds as string[] | null | undefined) ?? []);
		const slugToolIds: string[] = [];
		if (allToolSlugs.length && scopeAppId) {
			const { resolvedIds } = await resolveToolSlugsForApp(
				context.db,
				scopeAppId,
				allToolSlugs,
			);
			slugToolIds.push(...resolvedIds);
		}
		const resolvedToolIds = [...new Set([...baseToolIds, ...slugToolIds])];

		// Resolve appSlug for skill:// URI (input.appSlug → fetched app slug).
		let appSlug: string | null = input.appSlug ?? null;
		if (!appSlug && scopeAppId) {
			const app = await getAppById(context.db, scopeAppId);
			appSlug = app?.slug ?? null;
		}

		const skillUri = appSlug
			? `skill://${appSlug}/${slug}/SKILL.md`
			: `skill://${slug}/SKILL.md`;

		// Build frontmatter object (matches mcp/tool-registration rendering).
		const description =
			effective.description || effective.summary || effective.title || slug;
		const tags = coerceArray(input.tags) ?? existing?.tags ?? [];
		const audience = input.audience ?? existing?.audience ?? ["assistant"];
		const revision = (existing?.revision ?? 0) + 1;
		const provenance = `${appSlug ?? "tedix"}.mcp.tedix.dev`;

		const frontmatter: Record<string, unknown> = {
			name: slug,
			description,
			...(effective.title ? { title: effective.title } : {}),
			...(effective.summary && effective.summary !== description
				? { summary: effective.summary }
				: {}),
			version: revision,
			...(tags.length ? { tags } : {}),
			...(resolvedToolIds.length ? { tools: resolvedToolIds } : {}),
			...(allToolSlugs.length
				? {
						metadata: {
							[MCP_TOOLS_METADATA_KEY]: allToolSlugs,
						},
					}
				: {}),
			...(audience.length ? { audience } : {}),
			provenance,
		};

		// Render YAML (mirrors tool-registration.ts inline list format).
		const fmLines = [
			"---",
			`name: ${slug}`,
			`description: ${JSON.stringify(description)}`,
		];
		if (effective.title)
			fmLines.push(`title: ${JSON.stringify(effective.title)}`);
		if (effective.summary && effective.summary !== description)
			fmLines.push(`summary: ${JSON.stringify(effective.summary)}`);
		fmLines.push(`version: ${revision}`);
		if (tags.length)
			fmLines.push(
				`tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
			);
		if (resolvedToolIds.length)
			fmLines.push(
				`tools: [${resolvedToolIds
					.map((toolId) => JSON.stringify(toolId))
					.join(", ")}]`,
			);
		if (allToolSlugs.length) {
			fmLines.push("metadata:");
			fmLines.push(
				`  ${JSON.stringify(MCP_TOOLS_METADATA_KEY)}: [${allToolSlugs
					.map((tool) => JSON.stringify(tool))
					.join(", ")}]`,
			);
		}
		if (audience.length)
			fmLines.push(
				`audience: [${audience
					.map((audienceItem) => JSON.stringify(audienceItem))
					.join(", ")}]`,
			);
		fmLines.push(`provenance: ${provenance}`);
		fmLines.push("---");
		const skillBody = stripSkillFrontmatter(effective.content);
		const skillMd = `${fmLines.join("\n")}\n\n${skillBody}`;

		const indexEntry = {
			url: skillUri,
			digest: await sha256Digest(skillMd),
			frontmatter,
		};

		return {
			valid: validation.valid,
			errors: validation.errors,
			warnings: validation.warnings,
			rendered: {
				slug,
				skillUri,
				frontmatter,
				skillMd,
				indexEntry,
				resolvedToolIds,
				...(input.files ? { files: input.files } : {}),
			},
		};
	});

export const skillsRepair = authedSkills.repair
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (!input.id && !input.slug) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Either id or slug is required",
			);
		}

		const existing = input.id
			? await getSkillEntry(context.db, input.id, orgId)
			: await getSkillEntryBySlug(context.db, orgId, input.slug!);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");

		const { changes, patch } = await computeSkillRepairs(context.db, existing);
		const projectedEntry = { ...existing, ...patch } as SkillEntry;
		const manifestSchedule = validatedSkillSchedule(
			projectedEntry.content,
			projectedEntry.tediId,
		);
		const storedSchedule = await getSkillSchedule(context.db, existing.id);
		const scheduleProjectionChanged = !skillScheduleProjectionMatches(
			projectedEntry,
			manifestSchedule,
			storedSchedule,
		);
		if (scheduleProjectionChanged) {
			changes.push({
				code: "SYNC_SCHEDULE_PROJECTION",
				field: "schedule",
				before: storedSkillScheduleProjection(storedSchedule),
				after: expectedSkillScheduleProjection(
					projectedEntry,
					manifestSchedule,
				),
				note: "reconciled from the canonical skill manifest",
			});
		}

		if (input.dryRun) {
			return { id: existing.id, applied: false, changes, entry: null };
		}

		const hasPatch = Object.keys(patch).length > 0;
		if (!hasPatch && !scheduleProjectionChanged) {
			return { id: existing.id, applied: false, changes, entry: existing };
		}

		if (hasPatch) {
			await updateSkillEntry(context.db, existing.id, patch);
		}
		const updated = hasPatch
			? ((await getSkillEntry(context.db, existing.id, orgId)) ??
				projectedEntry)
			: existing;
		if (scheduleProjectionChanged) {
			await syncSkillScheduleProjection(context, updated, manifestSchedule);
		}
		return {
			id: existing.id,
			applied: true,
			changes,
			entry: updated,
		};
	});

export const skillsPromote = authedSkills.promote
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (!input.id && !input.slug) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Either id or slug is required",
			);
		}

		const existing = input.id
			? await getSkillEntry(context.db, input.id, orgId)
			: await getSkillEntryBySlug(context.db, orgId, input.slug!);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");

		const forceLifecycle = input.force === true;
		if (forceLifecycle) requireLifecycleOverrideAuthority(context);

		// P5 decision hygiene: record-layer promotions/mutations require a
		// Klein-2007 premortem; operators may skip with a logged reason. Dry
		// runs preview the requirement without blocking.
		const premortemGate = assertSkillPromotionPremortem({
			existing,
			targetLifecycleState: input.lifecycleState,
			premortem: input.premortem,
			skipReason: input.skipPremortemReason,
			operatorAuthority: isLifecycleOverrideAuthority(context),
			dryRun: input.dryRun === true,
		});

		const { changes, patch } = computeSkillPromotion(existing, {
			visibility: input.visibility,
			lifecycleState: input.lifecycleState,
			supersedesId: input.supersedesId,
			revisionReasoning:
				premortemGate.auditLine && input.revisionReasoning
					? `${input.revisionReasoning}\n${premortemGate.auditLine}`
					: (premortemGate.auditLine ?? input.revisionReasoning),
		});
		const blockers = await computeSkillPromotionBlockers(context.db, existing);
		const allChanges = [...blockers, ...changes];

		if (input.dryRun) {
			return {
				id: existing.id,
				applied: false,
				changes: allChanges,
				entry: null,
			};
		}
		if (existing.tags?.includes(WORKFLOW_IMPROVEMENT_TAG)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Workflow improvement proposals must use activateWorkflowImprovement",
			);
		}
		if (existing.tediId) requireHumanSkillActivation(context);
		validatedSkillSchedule(existing.content, null);

		if (blockers.length > 0) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Skill promotion blocked: ${blockers.map((change) => change.code).join(", ")}`,
				{ blockers },
			);
		}

		if (Object.keys(patch).length === 0) {
			return {
				id: existing.id,
				applied: false,
				changes: allChanges,
				entry: existing,
			};
		}

		await updateSkillEntryGated(
			context,
			existing.id,
			patch,
			// requireLifecycleOverrideAuthority above proved human/apikey.
			forceLifecycle
				? { force: true, forceAuthority: { kind: "operator" } }
				: undefined,
		);
		const updated = await getSkillEntry(context.db, existing.id, orgId);

		return {
			id: existing.id,
			applied: true,
			changes: allChanges,
			entry: updated ?? null,
		};
	});
