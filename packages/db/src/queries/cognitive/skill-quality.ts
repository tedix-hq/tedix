import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DbClient } from "../../client";
import { type SkillEntry, skillEntries } from "../../schema/cognitive";
import type { SkillLifecycleState } from "../skill-lifecycle";

export const LOW_QUALITY_SKILL_REASON_CODES = [
	"LONG_SENTENCE_SLUG",
	"ORPHANED_UNUSED",
	"UNPROVEN_ACTIVE",
	"WEAK_DESCRIPTION",
] as const;

export type LowQualitySkillReasonCode =
	(typeof LOW_QUALITY_SKILL_REASON_CODES)[number];
export type SkillOwnershipFilter = "all" | "baseline" | "tedi-scoped";

export interface LowQualitySkillReason {
	code: LowQualitySkillReasonCode;
	note: string;
}

export interface LowQualitySkillAuditCandidate {
	entry: SkillEntry;
	reasons: LowQualitySkillReason[];
	score: number;
}

const SENTENCE_SLUG_TOKENS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"completed",
	"failed",
	"for",
	"from",
	"had",
	"handled",
	"has",
	"have",
	"is",
	"ran",
	"run",
	"successfully",
	"that",
	"the",
	"was",
	"were",
	"when",
	"with",
]);

function countSentenceSlugTokens(slug: string): number {
	return slug.split("-").filter((token) => SENTENCE_SLUG_TOKENS.has(token))
		.length;
}

function isOlderThanDays(
	value: string | null | undefined,
	days: number,
): boolean {
	if (!value) return false;
	const createdAt = new Date(value).getTime();
	if (Number.isNaN(createdAt)) return false;
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	return createdAt < cutoff;
}

export function classifyLowQualitySkill(
	entry: SkillEntry,
	options: {
		maxSuccessCount?: number;
		minSlugLength?: number;
		orphanOlderThanDays?: number;
	} = {},
): LowQualitySkillAuditCandidate | null {
	const reasons: LowQualitySkillReason[] = [];
	const slug = entry.slug ?? "";
	const successCount = entry.successCount ?? 0;
	const failureCount = entry.failureCount ?? 0;
	const description = entry.description?.trim() ?? "";
	const title = entry.title.trim();
	const maxSuccessCount = Math.max(options.maxSuccessCount ?? 1, 0);
	const minSlugLength = Math.max(options.minSlugLength ?? 60, 1);
	const orphanOlderThanDays = Math.max(options.orphanOlderThanDays ?? 30, 1);

	if (slug.length >= minSlugLength && countSentenceSlugTokens(slug) >= 3) {
		reasons.push({
			code: "LONG_SENTENCE_SLUG",
			note: `Slug has ${slug.length} characters and reads like an observation sentence.`,
		});
	}

	if (
		successCount === 0 &&
		failureCount === 0 &&
		!entry.lastUsedAt &&
		isOlderThanDays(entry.createdAt, orphanOlderThanDays)
	) {
		reasons.push({
			code: "ORPHANED_UNUSED",
			note: `No usage after ${orphanOlderThanDays} days.`,
		});
	}

	if (entry.lifecycleState === "active" && successCount <= maxSuccessCount) {
		reasons.push({
			code: "UNPROVEN_ACTIVE",
			note: `Active with ${successCount} successful use${successCount === 1 ? "" : "s"}.`,
		});
	}

	if (description.length < 40 || description === title) {
		reasons.push({
			code: "WEAK_DESCRIPTION",
			note:
				description.length < 40
					? "Description is missing or too short to explain task fit."
					: "Description repeats the title.",
		});
	}

	if (reasons.length === 0) return null;
	const score = reasons.reduce((total, reason) => {
		if (
			reason.code === "LONG_SENTENCE_SLUG" ||
			reason.code === "ORPHANED_UNUSED"
		) {
			return total + 2;
		}
		return total + 1;
	}, 0);
	return { entry, reasons, score };
}

export async function auditLowQualitySkills(
	db: DbClient,
	orgId: string,
	options?: {
		appId?: string;
		lifecycleStates?: SkillLifecycleState[];
		limit?: number;
		maxSuccessCount?: number;
		minSlugLength?: number;
		offset?: number;
		orphanOlderThanDays?: number;
		ownership?: SkillOwnershipFilter;
		slug?: string;
		tediId?: string;
	},
): Promise<{
	candidates: LowQualitySkillAuditCandidate[];
	limit: number;
	offset: number;
	scanned: number;
	total: number;
}> {
	const lifecycleStates = options?.lifecycleStates?.length
		? options.lifecycleStates
		: (["active"] satisfies SkillLifecycleState[]);
	const ownership = options?.ownership ?? "all";
	const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
	const offset = Math.max(options?.offset ?? 0, 0);
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		// bound-params: subset of the closed SkillLifecycleState enum
		inArray(skillEntries.lifecycleState, lifecycleStates),
	];
	if (ownership === "baseline") {
		conditions.push(isNull(skillEntries.tediId));
	} else if (ownership === "tedi-scoped") {
		conditions.push(isNotNull(skillEntries.tediId));
	}
	if (options?.slug) {
		conditions.push(eq(skillEntries.slug, options.slug));
	}
	if (options?.tediId) {
		conditions.push(eq(skillEntries.tediId, options.tediId));
	}
	if (options?.appId) {
		conditions.push(eq(skillEntries.appId, options.appId));
	}

	const scanLimit = Math.max(limit + offset, 1000);
	const rows = await db
		.select()
		.from(skillEntries)
		.where(and(...conditions))
		.orderBy(desc(skillEntries.updatedAt), desc(skillEntries.createdAt))
		.limit(scanLimit);
	const candidates = rows
		.map((entry) =>
			classifyLowQualitySkill(entry, {
				maxSuccessCount: options?.maxSuccessCount,
				minSlugLength: options?.minSlugLength,
				orphanOlderThanDays: options?.orphanOlderThanDays,
			}),
		)
		.filter(
			(candidate): candidate is LowQualitySkillAuditCandidate =>
				candidate !== null,
		)
		.sort(
			(a, b) =>
				b.score - a.score ||
				(b.entry.successCount ?? 0) - (a.entry.successCount ?? 0) ||
				a.entry.title.localeCompare(b.entry.title),
		);

	return {
		candidates: candidates.slice(offset, offset + limit),
		limit,
		offset,
		scanned: rows.length,
		total: candidates.length,
	};
}
