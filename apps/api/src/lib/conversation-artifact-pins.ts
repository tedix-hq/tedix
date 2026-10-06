import type { ConversationArtifactPin } from "@tedix/api-contract/schemas/kernel-runtime";
import type { DbClient } from "@tedix/db/client";
import {
	attachConversationArtifactPin,
	listConversationArtifactPins,
} from "@tedix/db/queries/conversation-artifact-pins";
import { getTediArtifact } from "@tedix/db/queries/cognitive-runtime";

type ArtifactRow = NonNullable<Awaited<ReturnType<typeof getTediArtifact>>>;
type PinRow = Awaited<ReturnType<typeof listConversationArtifactPins>>[number];

/** Only platform-owned, single-file R2 artifacts have an immutable revision. */
export function artifactRevisionDigest(artifact: ArtifactRow): string | null {
	if (artifact.accessClassification === "runtime_private") return null;
	if (!artifact.uri?.startsWith("r2://")) return null;
	if (!artifact.metadata || typeof artifact.metadata !== "object") return null;
	if (artifact.metadata.bundle === true) return null;
	const digest = artifact.metadata.contentSha256;
	return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
		? digest
		: null;
}

export function conversationArtifactPinView(
	pin: PinRow,
	current: ArtifactRow | null,
): ConversationArtifactPin | null {
	// A context pin is not a release decision. In particular, retaining an old
	// location must not bypass the current artifact's private projection.
	if (current?.accessClassification === "runtime_private") return null;
	const digest = current ? artifactRevisionDigest(current) : null;
	const active =
		current !== null &&
		current.organizationId === pin.organizationId &&
		current.uri === pin.artifactUri &&
		digest === pin.revisionDigest;
	return {
		id: pin.id,
		conversationId: pin.conversationId,
		artifactId: pin.artifactId,
		replayName: pin.replayName,
		revision: { algorithm: "sha256", digest: pin.revisionDigest },
		artifact: {
			name: pin.artifactName,
			kind: pin.artifactKind,
			mimeType: pin.mimeType,
			uri: pin.artifactUri,
		},
		state: active ? "active" : "stale",
		whyPresent: {
			type: pin.attachedByType,
			actorId: pin.attachedById,
			attachedAt: pin.createdAt,
		},
		authority: "context_only",
	};
}

export async function readConversationArtifactPins(
	db: DbClient,
	input: { organizationId: string; conversationId: string },
): Promise<ConversationArtifactPin[]> {
	const pins = await listConversationArtifactPins(db, input);
	const views = await Promise.all(
		pins.map(async (pin) =>
			conversationArtifactPinView(
				pin,
				await getTediArtifact(db, {
					organizationId: input.organizationId,
					artifactId: pin.artifactId,
				}),
			),
		),
	);
	return views.filter((view): view is ConversationArtifactPin => view !== null);
}

export async function pinConversationArtifactRevision(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		conversationId: string;
		artifactId: string;
		replayName: string;
		attachedByType: PinRow["attachedByType"];
		attachedById: string;
		createdAt: string;
		requireTediId?: string;
		requireArtifactConversationId?: string;
	},
): Promise<ConversationArtifactPin | null> {
	const artifact = await getTediArtifact(db, {
		organizationId: input.organizationId,
		artifactId: input.artifactId,
	});
	if (
		!artifact ||
		(input.requireTediId && artifact.tediId !== input.requireTediId) ||
		(input.requireArtifactConversationId &&
			artifact.conversationId !== input.requireArtifactConversationId)
	) {
		return null;
	}
	const revisionDigest = artifactRevisionDigest(artifact);
	if (!revisionDigest || !artifact.uri) return null;
	const pin = await attachConversationArtifactPin(db, {
		id: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		artifactId: artifact.id,
		replayName: input.replayName,
		revisionDigest,
		artifactUri: artifact.uri,
		artifactName: artifact.name,
		artifactKind: artifact.kind,
		mimeType: artifact.mimeType,
		attachedByType: input.attachedByType,
		attachedById: input.attachedById,
		createdAt: input.createdAt,
	});
	return conversationArtifactPinView(pin, artifact);
}
