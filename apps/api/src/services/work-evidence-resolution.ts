import type { WorkEvidence } from "@tedix/db/schema/work-items";
import { getTediArtifact } from "@tedix/db/queries/cognitive-runtime";
import {
	getActiveArtifactReleaseApproval,
	getArtifactRedactionCandidate,
	getArtifactReleaseReviewHead,
} from "@tedix/db/queries/artifact-policy/releases";
import {
	getOsOutput,
	getOsOutputRevision,
	getOsOutputRevisionByNumber,
} from "@tedix/db/queries/os-workspaces/outputs";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { authorizePublicArtifactBytes } from "../lib/artifact-access";
import {
	isBundleArtifact,
	resolveBundleObject,
	streamArtifactObject,
} from "../lib/artifact-serve";
import { isOwnedArtifactR2Uri } from "../lib/artifact-uri-ownership";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "./os-derived-resource-access";
import type { BaseContext } from "../rpc/orpc";
import { readVerifiedPrivateTextArtifact } from "./artifact-immutable-publication";

const MAX_PREVIEW_BYTES = 50 * 1024;
const MAX_OPAQUE_ENCODED_LENGTH = 1024;
const MAX_OPAQUE_DECODED_BYTES = 512;
const SHA256 = /^[a-f0-9]{64}$/;
const OUTPUT_REF = /^output:\/\/([0-9a-f-]{36})\/revisions\/([0-9a-f-]{36})$/i;
const LEGACY_EXPORT =
	/^\/os-exports\/([0-9a-f-]{36})\/rev-(\d+)\.(pdf|png|xlsx|docx|pptx)$/i;
const RESERVED_METADATA = new Set([
	"_tedixevidence",
	"reference",
	"verified",
	"verification",
	"digest",
	"canonicaldigest",
	"preview",
	"organization",
	"organizationid",
	"provenance",
]);

export type EvidenceReference =
	| {
			kind: "artifact";
			status: "available" | "unavailable" | "unverified_legacy" | "ambiguous";
			canonicalUri: string | null;
			artifactId: string | null;
			digest: string | null;
			mediaType: string | null;
			reason: string | null;
			bundleDigestKind: "bytes" | "manifest" | null;
	  }
	| {
			kind: "output_revision";
			status: "available" | "unavailable";
			canonicalUri: string | null;
			outputId: string | null;
			revisionId: string | null;
			digest: string | null;
			mediaType: string | null;
			reason: string | null;
	  }
	| {
			kind: "external_https";
			status: "unverified";
			href: string;
			digest: null;
			reason: "unverified_external";
	  }
	| {
			kind: "unsupported";
			status: "unavailable";
			digest: null;
			reason: string;
	  };

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

type ValidBundleManifest = {
	entrypoint: string;
	files: Array<{
		path: string;
		sha256: string;
		sizeBytes: number;
		contentType: string;
	}>;
};

async function validateImmutableArtifactBody(artifact: {
	publicationState: string | null;
	contentDigest: string | null;
	uri: string | null;
	organizationId: string;
	tediId: string;
	metadata: unknown;
}): Promise<{ bundle: ValidBundleManifest | null } | null> {
	if (
		artifact.publicationState !== "ready" ||
		!SHA256.test(artifact.contentDigest ?? "") ||
		!isOwnedArtifactR2Uri(artifact)
	)
		return null;
	if (!isBundleArtifact(artifact.metadata)) return { bundle: null };
	if (
		!artifact.uri?.endsWith("/") ||
		typeof artifact.metadata !== "object" ||
		artifact.metadata === null
	)
		return null;
	const metadata = artifact.metadata as {
		entrypoint?: unknown;
		contentManifest?: unknown;
	};
	if (
		typeof metadata.entrypoint !== "string" ||
		!Array.isArray(metadata.contentManifest)
	)
		return null;
	const files: ValidBundleManifest["files"] = [];
	for (const value of metadata.contentManifest) {
		if (typeof value !== "object" || value === null) return null;
		const file = value as Record<string, unknown>;
		if (
			typeof file.path !== "string" ||
			typeof file.sha256 !== "string" ||
			!SHA256.test(file.sha256) ||
			typeof file.sizeBytes !== "number" ||
			!Number.isSafeInteger(file.sizeBytes) ||
			file.sizeBytes < 0 ||
			typeof file.contentType !== "string" ||
			!file.contentType ||
			!resolveBundleObject(artifact, file.path)
		)
			return null;
		files.push({
			path: file.path,
			sha256: file.sha256,
			sizeBytes: file.sizeBytes,
			contentType: file.contentType,
		});
	}
	if (
		new Set(files.map((file) => file.path)).size !== files.length ||
		!files.some((file) => file.path === metadata.entrypoint)
	)
		return null;
	files.sort((a, b) => a.path.localeCompare(b.path));
	const digest = await sha256(
		JSON.stringify({ version: 1, entrypoint: metadata.entrypoint, files }),
	);
	return digest === artifact.contentDigest
		? { bundle: { entrypoint: metadata.entrypoint, files } }
		: null;
}

export function decodeUtf8Preview(
	bytes: Uint8Array,
	truncated: boolean,
): string | null {
	const maxTrim = truncated ? 3 : 0;
	for (let trim = 0; trim <= maxTrim && trim <= bytes.length; trim += 1) {
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
				bytes.slice(0, bytes.length - trim),
			);
		} catch {}
	}
	return null;
}

export function stripReservedEvidenceMetadata(
	metadata: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> {
	return Object.fromEntries(
		Object.entries(metadata ?? {}).filter(
			([key]) => !RESERVED_METADATA.has(key.toLowerCase()),
		),
	);
}

function canonicalArtifactUri(id: string): string {
	return `artifact://${encodeURIComponent(id)}`;
}

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0)!;
		return code <= 31 || code === 127;
	});
}

async function resolveArtifact(context: BaseContext, uri: string) {
	const raw = uri.slice("artifact://".length);
	if (
		!raw ||
		raw.length > MAX_OPAQUE_ENCODED_LENGTH ||
		containsControlCharacter(raw)
	)
		return {
			reference: {
				kind: "artifact",
				status: "unavailable",
				canonicalUri: null,
				artifactId: null,
				digest: null,
				mediaType: null,
				reason: "malformed_reference",
				bundleDigestKind: null,
			} as EvidenceReference,
		};
	let decoded: string | null = null;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return {
			reference: {
				kind: "artifact",
				status: "unavailable",
				canonicalUri: null,
				artifactId: null,
				digest: null,
				mediaType: null,
				reason: "malformed_reference",
				bundleDigestKind: null,
			} as EvidenceReference,
		};
	}
	if (
		!decoded ||
		new TextEncoder().encode(decoded).byteLength > MAX_OPAQUE_DECODED_BYTES ||
		containsControlCharacter(decoded)
	)
		return {
			reference: {
				kind: "artifact",
				status: "unavailable",
				canonicalUri: null,
				artifactId: null,
				digest: null,
				mediaType: null,
				reason: "malformed_reference",
				bundleDigestKind: null,
			} as EvidenceReference,
		};
	const ids = [
		...new Set([decoded, raw].filter((id): id is string => Boolean(id))),
	];
	const rows = (
		await Promise.all(
			ids.map((artifactId) =>
				getTediArtifact(context.db, {
					organizationId: context.organizationId!,
					artifactId,
				}),
			),
		)
	).filter((row) => row !== null);
	if (rows.length > 1 && rows[0]!.id !== rows[1]!.id) {
		return {
			reference: {
				kind: "artifact",
				status: "ambiguous",
				canonicalUri: null,
				artifactId: null,
				digest: null,
				mediaType: null,
				reason: "ambiguous_opaque_id",
				bundleDigestKind: null,
			} as EvidenceReference,
		};
	}
	const artifact = rows[0];
	if (!artifact)
		return {
			reference: {
				kind: "artifact",
				status: "unavailable",
				canonicalUri: null,
				artifactId: null,
				digest: null,
				mediaType: null,
				reason: "not_found",
				bundleDigestKind: null,
			} as EvidenceReference,
		};
	if (artifact.accessClassification == null) {
		return {
			artifact,
			reference: {
				kind: "artifact",
				status: "unverified_legacy",
				canonicalUri: canonicalArtifactUri(artifact.id),
				artifactId: artifact.id,
				digest: null,
				mediaType: artifact.mimeType,
				reason: "mutable_legacy_artifact",
				bundleDigestKind: null,
			} as EvidenceReference,
		};
	}
	const immutableBody = await validateImmutableArtifactBody(artifact);
	if (artifact.accessClassification === "runtime_private") {
		let releasedText: string | undefined;
		try {
			const organizationId = context.organizationId!;
			const candidate = await getArtifactRedactionCandidate(context.db, {
				organizationId,
				childArtifactId: artifact.id,
			});
			if (
				candidate &&
				artifact.organizationId === organizationId &&
				candidate.organizationId === organizationId &&
				candidate.tediId === artifact.tediId &&
				candidate.childArtifactId === artifact.id &&
				candidate.parentArtifactId !== artifact.id &&
				candidate.childContentDigest === artifact.contentDigest &&
				immutableBody &&
				context.env.TEDI_R2_BUCKET
			) {
				const head = await getArtifactReleaseReviewHead(context.db, {
					organizationId,
					candidateId: candidate.id,
				});
				if (head?.eventType === "approved") {
					const approvalInput = {
						organizationId,
						childArtifactId: artifact.id,
						approvalId: head.id,
						childContentDigest: candidate.childContentDigest,
					};
					if (
						await getActiveArtifactReleaseApproval(context.db, approvalInput)
					) {
						const body = await readVerifiedPrivateTextArtifact(
							context.env.TEDI_R2_BUCKET,
							artifact,
						);
						// Bind the returned text to this same read; never reopen via a
						// generic range stream after checking the approved digest.
						if (
							await getActiveArtifactReleaseApproval(context.db, approvalInput)
						)
							releasedText = body.text;
					}
				}
			}
		} catch {
			// Receipt/owner/storage failures cannot turn private bytes into evidence.
		}
		return {
			artifact,
			releasedText,
			validatedBundle: null,
			reference: {
				kind: "artifact",
				status: releasedText === undefined ? "unavailable" : "available",
				canonicalUri: canonicalArtifactUri(artifact.id),
				artifactId: artifact.id,
				digest: artifact.contentDigest,
				mediaType: "text/plain; charset=utf-8",
				reason:
					releasedText === undefined ? "private_release_unavailable" : null,
				bundleDigestKind: releasedText === undefined ? null : "bytes",
			} as EvidenceReference,
		};
	}
	const access = authorizePublicArtifactBytes(artifact);
	const available = access.allowed && immutableBody !== null;
	return {
		artifact,
		validatedBundle: immutableBody?.bundle ?? null,
		reference: {
			kind: "artifact",
			status: available ? "available" : "unavailable",
			canonicalUri: canonicalArtifactUri(artifact.id),
			artifactId: artifact.id,
			digest: artifact.contentDigest,
			mediaType: artifact.mimeType,
			reason: available
				? null
				: access.allowed
					? "immutable_body_unavailable"
					: access.reason,
			bundleDigestKind: immutableBody?.bundle
				? "manifest"
				: immutableBody
					? "bytes"
					: null,
		} as EvidenceReference,
	};
}

async function resolveOutput(
	context: BaseContext,
	input: { outputId: string; revisionId?: string; revisionNumber?: number },
) {
	const output = await getOsOutput(context.db, {
		organizationId: context.organizationId!,
		outputId: input.outputId,
	});
	const revision = input.revisionId
		? await getOsOutputRevision(context.db, {
				organizationId: context.organizationId!,
				revisionId: input.revisionId,
			})
		: await getOsOutputRevisionByNumber(context.db, {
				organizationId: context.organizationId!,
				outputId: input.outputId,
				revision: input.revisionNumber!,
			});
	if (!output || !revision || revision.outputId !== input.outputId) return null;
	const digest = await sha256(revision.content);
	const envelope = parseDerivedAccessEnvelope(revision.accessEnvelope);
	const available = Boolean(
		envelope &&
		(await authorizeDerivedOutputSources(context, {
			organizationId: context.organizationId!,
			accessEnvelope: envelope,
		})),
	);
	return {
		output,
		revision,
		reference: {
			kind: "output_revision",
			status: available ? "available" : "unavailable",
			canonicalUri: `output://${output.id}/revisions/${revision.id}`,
			outputId: output.id,
			revisionId: revision.id,
			digest,
			mediaType: "application/vnd.tedix.output+json",
			reason: available ? null : "source_access_unavailable",
		} as EvidenceReference,
	};
}

export async function resolveWorkEvidenceReference(
	context: BaseContext,
	uri: string,
) {
	if (!context.organizationId) throw new Error("Organization context required");
	if (uri.startsWith("artifact://")) return resolveArtifact(context, uri);
	const outputMatch = OUTPUT_REF.exec(uri);
	if (outputMatch?.[1] && outputMatch[2])
		return (
			(await resolveOutput(context, {
				outputId: outputMatch[1],
				revisionId: outputMatch[2],
			})) ?? {
				reference: {
					kind: "output_revision",
					status: "unavailable",
					canonicalUri: null,
					outputId: null,
					revisionId: null,
					digest: null,
					mediaType: null,
					reason: "not_found",
				} as EvidenceReference,
			}
		);
	try {
		const url = new URL(uri);
		let apiOrigin: string | null = null;
		try {
			apiOrigin = new URL(context.env.API_URL).origin;
		} catch {}
		const legacy =
			url.origin === apiOrigin &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
				? LEGACY_EXPORT.exec(url.pathname)
				: null;
		if (legacy?.[1] && legacy[2])
			return (
				(await resolveOutput(context, {
					outputId: legacy[1],
					revisionNumber: Number(legacy[2]),
				})) ?? {
					reference: {
						kind: "output_revision",
						status: "unavailable",
						canonicalUri: null,
						outputId: null,
						revisionId: null,
						digest: null,
						mediaType: null,
						reason: "not_found",
					} as EvidenceReference,
				}
			);
		if (url.protocol === "https:" && !url.username && !url.password)
			return {
				reference: {
					kind: "external_https",
					status: "unverified",
					href: url.href,
					digest: null,
					reason: "unverified_external",
				} as EvidenceReference,
			};
	} catch {}
	return {
		reference: {
			kind: "unsupported",
			status: "unavailable",
			digest: null,
			reason: "unsupported_reference",
		} as EvidenceReference,
	};
}

export async function resolveWorkEvidenceRow(
	context: BaseContext,
	row: WorkEvidence,
) {
	let resolved;
	try {
		resolved = await resolveWorkEvidenceReference(context, row.uri);
	} catch {
		resolved = {
			reference: {
				kind: "unsupported",
				status: "unavailable",
				digest: null,
				reason: "resolution_failed",
			} as EvidenceReference,
		};
	}
	return { ...row, reference: resolved.reference };
}

export async function normalizeSubmittedEvidence(
	context: BaseContext,
	input: { uri: string; metadata?: Record<string, JsonValue> },
) {
	let resolved;
	try {
		resolved = await resolveWorkEvidenceReference(context, input.uri);
	} catch {
		resolved = {
			reference: {
				kind: "unsupported",
				status: "unavailable",
				digest: null,
				reason: "resolution_failed",
			} as EvidenceReference,
		};
	}
	const reference = resolved.reference;
	const canonicalUri =
		"canonicalUri" in reference ? reference.canonicalUri : null;
	return {
		uri: canonicalUri ?? input.uri,
		digest: reference.digest ?? undefined,
		mediaType:
			"mediaType" in reference ? (reference.mediaType ?? undefined) : undefined,
		metadata: {
			...stripReservedEvidenceMetadata(input.metadata),
			_tedixEvidence: JSON.parse(JSON.stringify(reference)) as JsonValue,
		},
		reference,
	};
}

export async function previewWorkEvidence(
	context: BaseContext,
	row: WorkEvidence,
) {
	let resolved;
	try {
		resolved = await resolveWorkEvidenceReference(context, row.uri);
	} catch {
		return { status: "unavailable" as const, reason: "resolution_failed" };
	}
	const reference = resolved.reference;
	if (reference.kind === "external_https")
		return {
			status: "external" as const,
			href: reference.href,
			trust: "unverified_external" as const,
		};
	if (reference.status !== "available")
		return {
			status: "unavailable" as const,
			reason:
				"reason" in reference
					? (reference.reason ?? "unavailable")
					: "unavailable",
		};
	if (reference.kind === "output_revision" && "revision" in resolved) {
		const bytes = new TextEncoder().encode(resolved.revision.content);
		const truncated = bytes.byteLength > MAX_PREVIEW_BYTES;
		const text = decodeUtf8Preview(
			bytes.slice(0, MAX_PREVIEW_BYTES),
			truncated,
		);
		if (text === null)
			return { status: "unavailable" as const, reason: "non_utf8" };
		return {
			status: "available" as const,
			canonicalUri: reference.canonicalUri!,
			mediaType: reference.mediaType!,
			digest: reference.digest!,
			text,
			truncated,
		};
	}
	if (reference.kind === "artifact" && "artifact" in resolved) {
		if ("releasedText" in resolved && resolved.releasedText !== undefined)
			return {
				status: "available" as const,
				canonicalUri: reference.canonicalUri!,
				mediaType: "text/plain; charset=utf-8",
				digest: reference.digest!,
				text: resolved.releasedText,
				truncated: false,
			};
		const artifact = resolved.artifact;
		if (!artifact)
			return { status: "unavailable" as const, reason: "not_found" };
		if (
			!isOwnedArtifactR2Uri({
				uri: artifact.uri,
				organizationId: artifact.organizationId,
				tediId: artifact.tediId,
			})
		)
			return { status: "unavailable" as const, reason: "unowned_body" };
		const streamable = resolved.validatedBundle
			? resolveBundleObject(artifact, "")
			: artifact;
		if (!streamable)
			return { status: "unavailable" as const, reason: "body_unavailable" };
		const response = await streamArtifactObject(
			context.env,
			streamable,
			`bytes=0-${MAX_PREVIEW_BYTES}`,
		);
		if (!response.ok || response.status !== 206)
			return { status: "unavailable" as const, reason: "body_unavailable" };
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_PREVIEW_BYTES + 1)
			return { status: "unavailable" as const, reason: "body_too_large" };
		const truncated = bytes.byteLength > MAX_PREVIEW_BYTES;
		const text = decodeUtf8Preview(
			bytes.slice(0, MAX_PREVIEW_BYTES),
			truncated,
		);
		if (text === null) {
			return { status: "unavailable" as const, reason: "non_utf8" };
		}
		let digest = reference.digest!;
		if (reference.bundleDigestKind === "manifest") {
			const entry = resolved.validatedBundle?.files.find(
				(item) => item.path === resolved.validatedBundle?.entrypoint,
			);
			if (!entry)
				return {
					status: "unavailable" as const,
					reason: "entrypoint_digest_unavailable",
				};
			digest = entry.sha256;
		}
		return {
			status: "available" as const,
			canonicalUri: reference.canonicalUri!,
			mediaType: streamable.mimeType ?? "text/plain",
			digest,
			text,
			truncated,
		};
	}
	return { status: "unavailable" as const, reason: "unsupported_reference" };
}
