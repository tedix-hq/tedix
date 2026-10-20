import { getOrganizationById } from "@tedix/db/queries/organizations";
import { parseJevSettings } from "@tedix/api-contract/schemas/jev";
import {
	listSkillRunEffectObservations,
	recordSkillRunEffectObservation,
} from "@tedix/db/queries/skill-run-effects";
import { type SkillRun } from "@tedix/db/queries/skill-runs";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import { verifiedActiveUserMembership } from "../work-items-principal";
import { assessSkillUtility } from "../../../services/jev-skill-utility";
import { getSkillRunForEnvironment, requireWorkflowRunTedi } from "./shared";

function mediaKindFromMimeType(
	mimeType: string | null | undefined,
): "image" | "video" | "audio" | "other" | null {
	if (!mimeType) return null;
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	return "other";
}

const MEDIA_URL_METADATA_MAX_BYTES = 2 * 1024 * 1024;

async function acceptedOutcomeForRun(
	context: BaseContext,
	run: SkillRun,
): Promise<{ workItemId: string; doneLooksLike: string } | null> {
	if (!run.workItemId) return null;
	const workItem = await getWorkItemById(context.db, run.workItemId);
	if (
		!workItem ||
		workItem.orgId !== run.organizationId ||
		!workItem.acceptedAt ||
		!workItem.acceptanceContract?.doneLooksLike?.trim()
	)
		return null;
	return {
		workItemId: workItem.id,
		doneLooksLike: workItem.acceptanceContract.doneLooksLike.trim(),
	};
}

const TERMINAL_SKILL_RUN_STATUSES = new Set([
	"completed",
	"failed",
	"canceled",
]);

/** A human reports an observed effect; neither the write nor the status proves it. */
export const skillsRecordRunEffectObservation =
	authedSkills.recordRunEffectObservation
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			if (context.authType !== "user")
				throw createError(
					ErrorCodes.FORBIDDEN,
					"A signed-in organization user must observe the effect",
				);
			const membership = await verifiedActiveUserMembership(context, orgId);
			const run = await getSkillRunForEnvironment(context, input.runId, orgId);
			if (!run || run.organizationId !== orgId)
				throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
			if (!TERMINAL_SKILL_RUN_STATUSES.has(run.status))
				throw createError(ErrorCodes.CONFLICT, "Skill run is not terminal");
			const accepted = await acceptedOutcomeForRun(context, run);
			if (!accepted)
				throw createError(
					ErrorCodes.CONFLICT,
					"Skill run needs an accepted Work Item outcome",
				);
			const now = new Date().toISOString();
			const observation = await recordSkillRunEffectObservation(context.db, {
				id: crypto.randomUUID(),
				organizationId: orgId,
				skillRunId: run.id,
				workItemId: accepted.workItemId,
				source: "human_attestation",
				observerUserId: membership.userId,
				observedState: input.observedState,
				evidenceRef: input.evidenceRef,
				effectNote: input.effectNote,
				observedAt: now,
				createdAt: now,
			});
			return {
				id: observation.id,
				runId: run.id,
				workItemId: accepted.workItemId,
				observedState: observation.observedState,
				source: "human_attestation" as const,
				observedAt: observation.observedAt,
			};
		});

/** Assessment never changes the run, skill, Work Item, or usage ledger. */
export const skillsGetRunUsefulness = authedSkills.getRunUsefulness
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run || run.organizationId !== orgId)
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		const unknown = (
			reason:
				| "unlinked"
				| "not_terminal"
				| "no_accepted_outcome"
				| "no_observation"
				| "evidence_overflow"
				| "model_unavailable",
			observationIds: string[] = [],
		) => ({
			runId: run.id,
			workItemId: run.workItemId,
			alignment: "unknown" as const,
			reason,
			evidenceSource: observationIds.length
				? ("human_attestation" as const)
				: ("none" as const),
			observationIds,
		});
		if (!run.workItemId) return unknown("unlinked");
		if (!TERMINAL_SKILL_RUN_STATUSES.has(run.status))
			return unknown("not_terminal");
		const accepted = await acceptedOutcomeForRun(context, run);
		if (!accepted) return unknown("no_accepted_outcome");
		const evidence = await listSkillRunEffectObservations(context.db, {
			organizationId: orgId,
			skillRunId: run.id,
			limit: 5,
		});
		if (evidence.truncated) return unknown("evidence_overflow");
		const rows = evidence.rows.filter(
			(row) =>
				row.source === "human_attestation" &&
				row.workItemId === accepted.workItemId,
		);
		if (!rows.length) return unknown("no_observation");
		const ids = rows.map((row) => row.id);
		const organization = await getOrganizationById(context.db, orgId);
		const settings = parseJevSettings(organization?.metadata);
		if (!settings.enabled) return unknown("model_unavailable", ids);
		const alignment = await assessSkillUtility({
			db: context.db,
			env: context.env,
			context: {
				organizationId: orgId,
				tediId: run.tediId,
				runId: run.id,
				executionAttempts: [],
			},
			doneLooksLike: accepted.doneLooksLike,
			observations: rows.map((row) => ({
				id: row.id,
				observedState: row.observedState,
				effectNote: row.effectNote,
				evidenceRef: row.evidenceRef,
			})),
			transport: settings.transport,
			timeoutMs: settings.timeoutMs,
		});
		return alignment === "unknown"
			? unknown("model_unavailable", ids)
			: {
					...unknown("model_unavailable", ids),
					alignment,
					reason: "assessment" as const,
				};
	});

export const skillsGetRunArtifact = authedSkills.getRunArtifact
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		if (input.skillId && run.skillId !== input.skillId) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}
		const { getRunArtifact } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const artifact = await getRunArtifact(context.db, input.runId, input.path);
		if (!artifact) {
			throw createError(ErrorCodes.NOT_FOUND, "Artifact not found");
		}
		const artifactRecord = artifact;

		let resolvedContent: string | null | undefined;
		async function resolveContent(): Promise<string | null> {
			if (resolvedContent !== undefined) return resolvedContent;
			if (artifactRecord.contentInline != null) {
				resolvedContent = artifactRecord.contentInline;
				return resolvedContent;
			}
			if (!artifactRecord.contentR2Key) {
				resolvedContent = null;
				return resolvedContent;
			}
			const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
			if (!env.SKILL_ARTIFACTS) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"SKILL_ARTIFACTS R2 binding not configured",
				);
			}
			const obj = await env.SKILL_ARTIFACTS.get(artifactRecord.contentR2Key);
			if (!obj) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					`Artifact R2 object missing: ${artifactRecord.contentR2Key}`,
				);
			}
			resolvedContent = await obj.text();
			return resolvedContent;
		}

		let resolvedMedia: { base64: string; mimeType: string } | null | undefined;
		async function resolveMedia(): Promise<{
			base64: string;
			mimeType: string;
		} | null> {
			if (resolvedMedia !== undefined) return resolvedMedia;
			if (
				input.mediaUrl &&
				!input.mediaInline &&
				artifactRecord.sizeBytes > MEDIA_URL_METADATA_MAX_BYTES
			) {
				resolvedMedia = null;
				return resolvedMedia;
			}
			const content = await resolveContent();
			if (!content) {
				resolvedMedia = null;
				return resolvedMedia;
			}
			const { extractMediaBase64 } =
				await import("../../../lib/skill-media-url");
			resolvedMedia = extractMediaBase64(content);
			return resolvedMedia;
		}

		// Optional signed media URL (browser-viewable, short-lived). Minted with
		// SECRETS_MASTER_KEY as the HMAC key; served by the public
		// GET /skill-media/:runId/*path route.
		let url: string | null = null;
		let urlExpiresAt: string | null = null;
		if (input.mediaUrl) {
			const { signMediaUrl } = await import("../../../lib/skill-media-url");
			const { untrustedContentBaseUrl } =
				await import("../../../lib/untrusted-origin");
			const signed = await signMediaUrl({
				// See events-artifacts.ts: the untrusted-content origin when one is
				// provisioned, the shared API origin (sandbox-CSP mitigated) when not.
				baseUrl: untrustedContentBaseUrl(context.env, context.env.API_URL),
				secret: context.env.SECRETS_MASTER_KEY,
				runId: input.runId,
				path: input.path,
				nowMs: Date.now(),
			});
			url = signed.url;
			urlExpiresAt = signed.expiresAt;
		}

		const media =
			input.mediaUrl || input.mediaInline ? await resolveMedia() : null;
		const mediaKind = mediaKindFromMimeType(media?.mimeType);
		const meta = {
			path: artifactRecord.path,
			mimeType: artifactRecord.mimeType,
			sizeBytes: artifactRecord.sizeBytes,
			outcome: artifactRecord.outcome,
			attempt: artifactRecord.attempt,
			createdAt: artifactRecord.createdAt ?? null,
			sha256: artifactRecord.sha256 ?? null,
			url,
			urlExpiresAt,
			mediaMimeType: media?.mimeType ?? null,
			mediaPath: mediaKind
				? `/skill-runs/${input.runId}/media/${input.path}?kind=${mediaKind}`
				: null,
			mediaKind,
		};

		// Session-authed inline media: resolve content (inline or R2), extract the
		// base64 + mime, and return them ready for a `data:` URL. No expiring token,
		// so the reference survives transcript scrollback (unlike `mediaUrl`). The
		// decode-from-base64 happens client-side, not here — we pass the base64
		// through, avoiding any in-handler decode work.
		if (input.mediaInline) {
			return {
				...meta,
				content: null,
				r2Available:
					artifactRecord.contentInline == null && !!artifactRecord.contentR2Key,
				mediaBase64: media?.base64 ?? null,
			};
		}

		if (artifactRecord.contentInline != null) {
			// When a URL was requested, skip echoing the (possibly large) inline body.
			return {
				...meta,
				content: input.mediaUrl ? null : artifactRecord.contentInline,
				r2Available: false,
			};
		}
		if (!artifactRecord.contentR2Key) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Artifact has neither inline content nor R2 key",
			);
		}
		// With a signed URL the route streams the bytes; no need to pull the
		// large R2 object back through this RPC.
		if (input.mediaUrl) {
			return { ...meta, content: null, r2Available: true };
		}
		const text = await resolveContent();
		return { ...meta, content: text, r2Available: true };
	});

export const skillsListRunArtifacts = authedSkills.listRunArtifacts
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		if (input.skillId && run.skillId !== input.skillId) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}
		const { listRunArtifactsPage } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const fetched = await listRunArtifactsPage(context.db, input.runId, {
			limit: input.limit + 1,
			offset: input.offset,
		});
		const truncated = fetched.length > input.limit;
		const artifacts = fetched.slice(0, input.limit);
		return {
			artifacts: artifacts.map((a) => ({
				path: a.path,
				mimeType: a.mimeType,
				sizeBytes: a.sizeBytes,
				outcome: a.outcome,
				attempt: a.attempt,
				storage: (a.contentR2Key ? "r2" : "inline") as "inline" | "r2",
				createdAt: a.createdAt ?? null,
				sha256: a.sha256 ?? null,
			})),
			truncated,
			nextOffset: truncated ? input.offset + artifacts.length : null,
		};
	});
