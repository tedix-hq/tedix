/**
 * Harness Versioning + Trace Bundle Router
 *
 * Tedix-owned write/read surface for the harness-evolution evidence substrate
 * (see docs/engineering/cognition/harness.md). The isolate DO's `HttpPlatformClient` calls
 * `ensureActiveHarnessVersion` (identity load) + `recordTraceBundle` (run close).
 *
 * Version-bump policy lives here so monotonicity stays server-authoritative:
 * a bump happens iff the incoming `components` content-hash set differs from
 * the tedi's current active version (or there is no active version yet).
 */

import { implement } from "@orpc/server";
import { harnessContract } from "@tedix/api-contract/contracts/harness";
import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import type { HarnessVersion } from "@tedix/api-contract/schemas/harness-version";
import { evalGateForCertification } from "@tedix/api-contract/schemas/harness-version";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	getEvalSummaryForVersion,
	recordEvalResult,
	recordEvalRun,
} from "@tedix/db/queries/harness-version/evaluations";
import {
	promoteHarnessVersion,
	updateHarnessVersionMetadata,
} from "@tedix/db/queries/harness-version/promotion";
import { kernelHarnessSubjectId } from "@tedix/db/queries/harness-version/subjects";
import {
	clearHarnessSubjectTraceBundleUri,
	recordTraceBundle,
} from "@tedix/db/queries/harness-version/trace-bundles";
import {
	demoteActiveHarnessVersions,
	recordHarnessVersion,
} from "@tedix/db/queries/harness-version/versions";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	getActiveHarnessVersion,
	getHarnessVersionById,
	listEvalResults,
	listEvalRuns,
	listHarnessSubjectTraceBundles,
	listHarnessVersions,
	listTraceBundles,
} from "../../services/harness-persistence";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import {
	KERNEL_TRACE_BUNDLE_FILE_NAMES,
	kernelTraceBundlePrefix,
	kernelTraceBundleRetentionExpiresAt,
} from "./kernel/kernel-trace-bundle-writer";

const harnessOs = implement(harnessContract).$context<BaseContext>();
const authed = harnessOs.use(withAuth);
const platformAdmin = harnessOs.use(withAuth).use(AUTHZ.platformAdmin);

const MAX_TRACE_FILE_BYTES = 256 * 1024;

async function requireKernelBundle(
	context: BaseContext,
	organizationId: string,
	runId: string,
) {
	if (!isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Platform admin authority required",
		);
	}
	const bundles = await listHarnessSubjectTraceBundles(context.db, {
		subjectKind: "kernel",
		subjectId: kernelHarnessSubjectId(organizationId),
		runId,
		limit: 1,
	});
	const bundle = bundles[0];
	if (!bundle?.bundleUri) {
		throw createError(ErrorCodes.NOT_FOUND, "Kernel trace bundle not found");
	}
	const bundleUri = bundle.bundleUri;
	const expectedPrefix = kernelTraceBundlePrefix(organizationId, runId);
	if (bundleUri !== `r2://tedix-tedi-production/${expectedPrefix}/`) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Kernel trace bundle URI is invalid",
		);
	}
	return { bundle, bundleUri, expectedPrefix };
}

function nowIso() {
	return new Date().toISOString();
}

type HarnessEvalRecorderType =
	| "user"
	| "api_key"
	| "service"
	| "tedi"
	| "external_agent";

/**
 * Stamp immutable server-derived recorder provenance onto a harness eval run.
 * Direct tedis and external agents may write their operational eval ledger, but
 * those rows are not certification sources for earned delegation.
 */
export function stampHarnessEvalRecorder(
	context: BaseContext,
	metadata: unknown,
): Record<string, JsonValue> {
	let type: HarnessEvalRecorderType;
	let id: string;
	if (context.tediId) {
		type = "tedi";
		id = context.tediId;
	} else if (context.externalAgentPrincipalId) {
		type = "external_agent";
		id = context.externalAgentPrincipalId;
	} else if (context.authType === "user" && context.user?.sub) {
		type = "user";
		id = context.user.sub;
	} else if (context.authType === "apikey" && context.apiKey?.id) {
		type = "api_key";
		id = context.apiKey.id;
	} else if (
		(context.authType === "service-binding" || context.authType === "m2m") &&
		context.serviceAccount?.clientId
	) {
		type = "service";
		id = context.serviceAccount.clientId;
	} else {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A stable eval-recorder principal is required",
		);
	}
	const parsedMetadata = JsonValueSchema.safeParse(metadata ?? {});
	if (
		!parsedMetadata.success ||
		parsedMetadata.data === null ||
		typeof parsedMetadata.data !== "object" ||
		Array.isArray(parsedMetadata.data)
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Harness eval metadata must be a JSON object",
		);
	}
	return {
		...parsedMetadata.data,
		recordedByPrincipalType: type,
		recordedByPrincipalId: id,
		trustedForEarnedDelegation:
			type === "user" || type === "api_key" || type === "service",
	};
}

export function canAccessHarnessTedi(
	context: BaseContext,
	tedi: { id: string; organizationId: string },
): boolean {
	if (context.tediId) return context.tediId === tedi.id;
	if (
		context.organizationId &&
		tedi.organizationId === context.organizationId
	) {
		return true;
	}
	return isPlatformPrincipal(context);
}

async function requireTediAccess(context: BaseContext, tediId: string) {
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
	if (!canAccessHarnessTedi(context, tedi)) {
		if (
			!context.organizationId &&
			!context.tediId &&
			!isPlatformPrincipal(context)
		) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"Organization context required",
			);
		}
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	return tedi;
}

export function harnessVersionBelongsToTedi(
	tedi: { id: string; organizationId: string },
	version: { tediId: string; orgId?: string | null },
): boolean {
	return (
		version.tediId === tedi.id &&
		(version.orgId == null || version.orgId === tedi.organizationId)
	);
}

async function requireHarnessVersionAccess(
	context: BaseContext,
	tediId: string,
	harnessVersionId: string,
) {
	const tedi = await requireTediAccess(context, tediId);
	const version = await getHarnessVersionById(context.db, harnessVersionId);
	if (!version) {
		throw createError(ErrorCodes.NOT_FOUND, "Harness version not found");
	}
	if (!harnessVersionBelongsToTedi(tedi, version)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Harness version does not belong to this tedi",
		);
	}
	return { tedi, version };
}

export function canAccessHarnessKernelSubject(
	context: BaseContext,
): { subjectKind: "kernel"; subjectId: string } | null {
	if (!context.organizationId) return null;
	return {
		subjectKind: "kernel",
		subjectId: kernelHarnessSubjectId(context.organizationId),
	};
}

function requireKernelHarnessSubject(context: BaseContext): {
	subjectKind: "kernel";
	subjectId: string;
} {
	const subject = canAccessHarnessKernelSubject(context);
	if (!subject) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	return subject;
}

/**
 * Canonical, order-independent serialization of a component map for diffing.
 * Two component sets are equal iff this string is equal. Sorting the keys makes
 * the comparison insensitive to record insertion order.
 */
export function serializeComponents(
	components: Record<string, string>,
): string {
	const keys = Object.keys(components).sort();
	return JSON.stringify(keys.map((k) => [k, components[k]]));
}

export function componentsEqual(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	return serializeComponents(a) === serializeComponents(b);
}

export interface HarnessComponentDiff {
	component: string;
	base: string | null;
	candidate: string | null;
	status: "added" | "removed" | "changed";
}

export function diffHarnessComponents(
	base: Record<string, string>,
	candidate: Record<string, string>,
): HarnessComponentDiff[] {
	const keys = [
		...new Set([...Object.keys(base), ...Object.keys(candidate)]),
	].sort();
	const diffs: HarnessComponentDiff[] = [];
	for (const component of keys) {
		const baseValue = base[component];
		const candidateValue = candidate[component];
		if (baseValue === candidateValue) continue;
		diffs.push({
			component,
			base: baseValue ?? null,
			candidate: candidateValue ?? null,
			status:
				baseValue === undefined
					? "added"
					: candidateValue === undefined
						? "removed"
						: "changed",
		});
	}
	return diffs;
}

/**
 * Next monotonic-int version string. The active version's `version` is parsed
 * as an int when possible; otherwise we fall back to counting from 1. Kept as
 * a string in the schema so semver callers are unaffected.
 */
export function nextVersionString(current: string | null | undefined): string {
	if (!current) return "1";
	const n = Number.parseInt(current, 10);
	return Number.isFinite(n) ? String(n + 1) : "1";
}

/**
 * Read a version's stamped `metadata.latestEval.meanScore`, or null when it has
 * none yet. The active version's stamped meanScore is the bar a candidate's
 * meanScore must STRICTLY exceed to be MARKED promotable (a mark only — promotion
 * to `active` is a separate runtime/operator step, never done here).
 */
function stampedMeanScore(
	metadata: Record<string, unknown> | null | undefined,
): number | null {
	const latest = metadata?.latestEval;
	if (!latest || typeof latest !== "object" || Array.isArray(latest)) {
		return null;
	}
	const score = (latest as Record<string, unknown>).meanScore;
	return typeof score === "number" && Number.isFinite(score) ? score : null;
}

export const harnessContractRouter = harnessOs.router({
	readKernelTraceBundleFile: platformAdmin.readKernelTraceBundleFile.handler(
		async ({ context, input }) => {
			const { bundle, bundleUri, expectedPrefix } = await requireKernelBundle(
				context,
				input.organizationId,
				input.runId,
			);
			const object = await context.env.TEDI_R2_BUCKET.get(
				`${expectedPrefix}/${input.fileName}`,
			);
			if (!object) {
				throw createError(ErrorCodes.NOT_FOUND, "Trace file not found");
			}
			if (object.size > MAX_TRACE_FILE_BYTES) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Trace file exceeds the replay read limit",
				);
			}
			const content = await object.text();
			const actor = auditActor(context);
			await emitAuditEvent(context.db, {
				organizationId: input.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "harness.trace_bundle_file.read",
				resourceType: "harness_trace_bundle",
				resourceId: bundle.id,
				metadata: {
					...actor.actorMetadata,
					runId: input.runId,
					fileName: input.fileName,
				},
			});
			return {
				bundleId: bundle.id,
				bundleUri,
				fileName: input.fileName,
				contentType:
					object.httpMetadata?.contentType ?? "application/octet-stream",
				content,
				createdAt: bundle.createdAt,
				retentionExpiresAt: kernelTraceBundleRetentionExpiresAt(
					bundle.createdAt,
				),
			};
		},
	),

	deleteKernelTraceBundle: platformAdmin.deleteKernelTraceBundle.handler(
		async ({ context, input }) => {
			const { bundle, expectedPrefix } = await requireKernelBundle(
				context,
				input.organizationId,
				input.runId,
			);
			const deletedKeys = KERNEL_TRACE_BUNDLE_FILE_NAMES.map(
				(fileName) => `${expectedPrefix}/${fileName}`,
			);
			await context.env.TEDI_R2_BUCKET.delete(deletedKeys);
			const deletedAt = nowIso();
			await clearHarnessSubjectTraceBundleUri(context.db, bundle.id, {
				...bundle.metadata,
				retentionDeletion: { deletedAt, reason: input.reason, deletedKeys },
			});
			const actor = auditActor(context);
			await emitAuditEvent(context.db, {
				organizationId: input.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "harness.trace_bundle.deleted",
				resourceType: "harness_trace_bundle",
				resourceId: bundle.id,
				metadata: {
					...actor.actorMetadata,
					runId: input.runId,
					reason: input.reason,
					deletedKeys,
				},
			});
			return {
				bundleId: bundle.id,
				deletedKeys,
				deletedAt,
				reason: input.reason,
			};
		},
	),
	ensureActiveHarnessVersion: authed.ensureActiveHarnessVersion
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const tedi = await requireTediAccess(context, input.tediId);
			const orgId = input.orgId ?? tedi.organizationId;

			const active = await getActiveHarnessVersion(context.db, input.tediId);
			// The trace-safety policy in force is part of the version's identity:
			// a policy change must bump the version exactly like a component change.
			// `undefined` (caller did not supply one) preserves the active value so
			// older callers that never stamp a policy are not treated as a change.
			const traceSafetyPolicyId =
				input.traceSafetyPolicyId ?? active?.traceSafetyPolicyId ?? null;
			const traceSafetyPolicyChanged =
				input.traceSafetyPolicyId !== undefined &&
				(active?.traceSafetyPolicyId ?? null) !== traceSafetyPolicyId;
			// No-op when the active version already pins this exact component set AND
			// the same trace-safety policy.
			if (
				active &&
				componentsEqual(active.components, input.components) &&
				!traceSafetyPolicyChanged
			) {
				return { version: active, bumped: false };
			}

			const version: HarnessVersion = {
				id: crypto.randomUUID(),
				tediId: input.tediId,
				orgId,
				version: nextVersionString(active?.version),
				runtimeKind: input.runtimeKind ?? tedi.runtimeKind ?? undefined,
				components: input.components,
				parentVersionId: active?.id ?? null,
				reason:
					input.reason ??
					(active
						? traceSafetyPolicyChanged &&
							componentsEqual(active.components, input.components)
							? "trace-safety policy changed"
							: "harness components changed"
						: "initial baseline harness"),
				traceSafetyPolicyId,
				promotionStatus: "active",
				createdAt: nowIso(),
			};

			// Demote any previously-active version(s) for this tedi to promoted so
			// the active pointer is single-valued. Done before the insert so a
			// concurrent reader never sees two active rows for long.
			if (active) {
				await demoteActiveHarnessVersions(context.db, input.tediId);
			}

			await recordHarnessVersion(context.db, version);
			return { version, bumped: true };
		}),

	getActiveHarnessVersion: authed.getActiveHarnessVersion
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await requireTediAccess(context, input.tediId);
			const version = await getActiveHarnessVersion(context.db, input.tediId);
			return { version };
		}),

	listHarnessVersions: authed.listHarnessVersions
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await requireTediAccess(context, input.tediId);
			const versions = await listHarnessVersions(context.db, {
				tediId: input.tediId,
				promotionStatus: input.promotionStatus,
				runtimeKind: input.runtimeKind,
				limit: input.limit,
			});
			return { versions };
		}),

	compareHarnessVersions: authed.compareHarnessVersions
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await requireTediAccess(context, input.tediId);
			const candidate = await getHarnessVersionById(
				context.db,
				input.candidateHarnessVersionId,
			);
			if (!candidate || candidate.tediId !== input.tediId) {
				throw createError(ErrorCodes.NOT_FOUND, "Harness version not found");
			}
			const base = input.baseHarnessVersionId
				? await getHarnessVersionById(context.db, input.baseHarnessVersionId)
				: await getActiveHarnessVersion(context.db, input.tediId);
			if (
				input.baseHarnessVersionId &&
				(!base || base.tediId !== input.tediId)
			) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Base harness version not found",
				);
			}
			const componentDiffs = diffHarnessComponents(
				base?.components ?? {},
				candidate.components,
			);
			return {
				base,
				candidate,
				componentDiffs,
				changed: componentDiffs.length > 0,
			};
		}),

	recordTraceBundle: authed.recordTraceBundle
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const { tedi } = await requireHarnessVersionAccess(
				context,
				input.tediId,
				input.harnessVersionId,
			);
			const bundle = {
				...input,
				orgId: tedi.organizationId,
				createdAt: input.createdAt || nowIso(),
			};
			if (!(await recordTraceBundle(context.db, bundle))) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Trace bundle ownership conflict",
				);
			}
			return { bundle };
		}),

	listTraceBundles: authed.listTraceBundles
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await requireTediAccess(context, input.tediId);
			const bundles = await listTraceBundles(context.db, {
				tediId: input.tediId,
				runId: input.runId,
				harnessVersionId: input.harnessVersionId,
				limit: input.limit,
			});
			return { bundles };
		}),

	listKernelTraceBundles: authed.listKernelTraceBundles
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			const subject = requireKernelHarnessSubject(context);
			const bundles = await listHarnessSubjectTraceBundles(context.db, {
				...subject,
				runId: input.runId,
				harnessVersionId: input.harnessVersionId,
				limit: input.limit,
			});
			return { bundles };
		}),

	recordEvalResult: authed.recordEvalResult
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const { tedi } = await requireHarnessVersionAccess(
				context,
				input.tediId,
				input.harnessVersionId,
			);
			const result = {
				...input,
				orgId: tedi.organizationId,
				createdAt: input.createdAt || nowIso(),
			};
			if (!(await recordEvalResult(context.db, result))) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Eval result ownership conflict",
				);
			}
			return { result };
		}),

	listEvalResults: authed.listEvalResults
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await requireTediAccess(context, input.tediId);
			const results = await listEvalResults(context.db, {
				tediId: input.tediId,
				harnessVersionId: input.harnessVersionId,
				limit: input.limit,
			});
			return { results };
		}),

	getEvalSummaryForVersion: authed.getEvalSummaryForVersion
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await requireHarnessVersionAccess(
				context,
				input.tediId,
				input.harnessVersionId,
			);
			const summary = await getEvalSummaryForVersion(
				context.db,
				input.harnessVersionId,
			);
			const gate = evalGateForCertification(summary);
			return { summary, gate };
		}),

	recordEvalRun: authed.recordEvalRun
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			const { tedi } = await requireHarnessVersionAccess(
				context,
				input.tediId,
				input.harnessVersionId,
			);
			const run = {
				...input,
				orgId: tedi.organizationId,
				metadata: stampHarnessEvalRecorder(context, input.metadata),
				createdAt: input.createdAt || nowIso(),
			};
			if (!(await recordEvalRun(context.db, run))) {
				throw createError(ErrorCodes.FORBIDDEN, "Eval run ownership conflict");
			}

			// Post-write stamp (Slice B): roll this version's full eval ledger into a
			// summary and MERGE a `latestEval` snapshot onto the version's metadata
			// JSON (read-modify-write — never clobbers other keys, no schema change),
			// then MARK whether this version is a promotion candidate. This is a
			// MARK ONLY: it writes `metadata.promotable` and NEVER flips
			// `promotion_status` to `active`. Best-effort: a stamp failure must not
			// fail the durable run write the caller depends on.
			try {
				const summary = await getEvalSummaryForVersion(
					context.db,
					input.harnessVersionId,
				);
				const meanScore = summary.latestScore ?? run.meanScore;
				// The active version is the bar a candidate must beat. When THIS row is
				// the active version, there is nothing to promote past — it is not a
				// candidate against itself.
				const active = await getActiveHarnessVersion(context.db, input.tediId);
				const activeMeanScore =
					active && active.id !== input.harnessVersionId
						? stampedMeanScore(active.metadata)
						: null;
				// Candidate iff this is NOT the active version AND its meanScore
				// strictly exceeds the active version's stamped meanScore. A null
				// active score (active never scored) is not a bar to beat → not yet
				// promotable, so the live pointer stays read-only by default.
				const promotable =
					active !== null &&
					active.id !== input.harnessVersionId &&
					activeMeanScore !== null &&
					meanScore > activeMeanScore;
				await updateHarnessVersionMetadata(context.db, input.harnessVersionId, {
					latestEval: {
						evalRunId: run.id,
						meanScore,
						passed: run.eligible,
						recordedAt: run.createdAt,
					},
					promotable,
				});
				// Autonomous promotion (eval-result → HarnessVersion promotion): advance
				// a NON-active CANDIDATE up the ladder from its accumulated evals. Gated
				// to candidates because production self-scoring always targets the active
				// version, which decidePromotion treats as terminal anyway — this skips
				// the redundant read on the hot self-scoring path while still climbing a
				// candidate scored by the eval runner (validation → locked-test → canary →
				// promoted). NEVER writes promotion_status=active: making a `promoted`
				// version the live pointer stays a gated operator/runtime step (increment 3).
				if (active && active.id !== input.harnessVersionId) {
					const decision = await promoteHarnessVersion(
						context.db,
						input.harnessVersionId,
					);
					if (decision?.applied) {
						console.log(
							`[harness.recordEvalRun] promoted ${input.harnessVersionId} → ${decision.nextStatus}: ${decision.reasons.join("; ")}`,
						);
					}
				}
			} catch (err) {
				console.warn(
					`[harness.recordEvalRun] metadata stamp failed for ${input.harnessVersionId}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			return { run };
		}),

	listEvalRuns: authed.listEvalRuns
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await requireTediAccess(context, input.tediId);
			const runs = await listEvalRuns(context.db, {
				tediId: input.tediId,
				harnessVersionId: input.harnessVersionId,
				limit: input.limit,
			});
			return { runs };
		}),

	promoteHarnessVersion: authed.promoteHarnessVersion
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			// Resolve the version's tedi for access control (input carries only the
			// version id; promotion is org-scoped to that tedi). Use the db query
			// (not raw drizzle in the router) to avoid the peer-instance hazard.
			const version = await getHarnessVersionById(
				context.db,
				input.harnessVersionId,
			);
			if (!version) return { decision: null };
			await requireTediAccess(context, version.tediId);
			const decision = await promoteHarnessVersion(
				context.db,
				input.harnessVersionId,
			);
			return { decision };
		}),
});
