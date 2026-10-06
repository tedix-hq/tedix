import {
	getCapabilityByIdForOrganization,
	listCapabilities,
} from "@tedix/db/queries/capabilities";
import {
	attachConversationCapability,
	ConversationCapabilityConflictError,
	detachConversationCapability,
	listConversationCapabilities,
} from "@tedix/db/queries/conversation-capabilities";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	ConversationArtifactPinConflictError,
	detachConversationArtifactPin,
} from "@tedix/db/queries/conversation-artifact-pins";
import {
	pinConversationArtifactRevision,
	readConversationArtifactPins,
} from "../../../lib/conversation-artifact-pins";
import type { BaseContext } from "../../orpc";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireTediAccess,
} from "./helpers";

function capabilityView(
	reference: Awaited<ReturnType<typeof listConversationCapabilities>>[number],
	capability: { name: string; slug: string },
) {
	return {
		id: reference.id,
		conversationId: reference.conversationId,
		capabilityId: reference.capabilityId,
		replayName: reference.replayName,
		name: capability.name,
		slug: capability.slug,
		whyPresent: {
			type: reference.attachedByType,
			actorId: reference.attachedById,
			attachedAt: reference.createdAt,
		},
		authority: "context_only" as const,
	};
}

export function assertEmbeddedRuntimeIdentity(
	context: Pick<BaseContext, "authType" | "tediId">,
	tediId: string,
): void {
	if (context.authType !== "service-binding" || context.tediId !== tediId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Embedded conversation capabilities require the matching tedi runtime",
		);
	}
}

async function requireEmbeddedRuntimeCaller(
	context: BaseContext,
	tediId: string,
): Promise<string> {
	assertEmbeddedRuntimeIdentity(context, tediId);
	const tedi = await requireTediAccess(context, tediId);
	if (!tedi.organizationId || tedi.organizationId !== context.organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Embedded tenant scope mismatch");
	}
	return tedi.organizationId;
}

async function readAttached(
	context: BaseContext,
	organizationId: string,
	conversationId: string,
) {
	const references = await listConversationCapabilities(context.db, {
		organizationId,
		conversationId,
	});
	const capabilities = await Promise.all(
		references.map(async (reference) => {
			const capability = await getCapabilityByIdForOrganization(
				context.db,
				organizationId,
				reference.capabilityId,
			);
			return capability?.status === "active"
				? capabilityView(reference, capability)
				: null;
		}),
	);
	return capabilities.filter((capability) => capability !== null);
}

export const listEmbeddedConversationCapabilitiesProcedure =
	authedTedisOs.listEmbeddedConversationCapabilities
		.use(AUTHZ.tedisAppsRead)
		.handler(async ({ context, input }) => {
			const organizationId = await requireEmbeddedRuntimeCaller(
				context,
				input.tediId,
			);
			const [attached, catalog] = await Promise.all([
				readAttached(context, organizationId, input.conversationId),
				listCapabilities(context.db, {
					organizationId,
					status: "active",
					limit: 100,
					offset: 0,
				}),
			]);
			return {
				attached,
				available: catalog.data.map(({ id, name, slug }) => ({
					id,
					name,
					slug,
				})),
				authority: "context_only" as const,
			};
		});

export const attachEmbeddedConversationCapabilityProcedure =
	authedTedisOs.attachEmbeddedConversationCapability
		.use(AUTHZ.tedisAppsWrite)
		.handler(async ({ context, input }) => {
			const organizationId = await requireEmbeddedRuntimeCaller(
				context,
				input.tediId,
			);
			const capability = await getCapabilityByIdForOrganization(
				context.db,
				organizationId,
				input.capabilityId,
			);
			if (!capability || capability.status !== "active") {
				throw createError(ErrorCodes.NOT_FOUND, "Active capability not found");
			}
			let reference;
			try {
				reference = await attachConversationCapability(context.db, {
					id: crypto.randomUUID(),
					organizationId,
					conversationId: input.conversationId,
					capabilityId: capability.id,
					replayName: input.replayName,
					attachedByType: "user",
					attachedById: input.hostUserId,
					createdAt: new Date().toISOString(),
				});
			} catch (error) {
				if (error instanceof ConversationCapabilityConflictError) {
					throw createError(ErrorCodes.BAD_REQUEST, error.message);
				}
				throw error;
			}
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: input.hostUserId,
				actorType: "user",
				action: "tedi.embedded_conversation.capability_attached",
				resourceType: "tedi_conversation",
				resourceId: input.conversationId,
				metadata: {
					tediId: input.tediId,
					capabilityId: capability.id,
					replayName: input.replayName,
					authority: "context_only",
				},
			});
			return { capability: capabilityView(reference, capability) };
		});

export const detachEmbeddedConversationCapabilityProcedure =
	authedTedisOs.detachEmbeddedConversationCapability
		.use(AUTHZ.tedisAppsWrite)
		.handler(async ({ context, input }) => {
			const organizationId = await requireEmbeddedRuntimeCaller(
				context,
				input.tediId,
			);
			const detached = await detachConversationCapability(context.db, {
				organizationId,
				conversationId: input.conversationId,
				referenceId: input.referenceId,
			});
			if (!detached) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Conversation capability not found",
				);
			}
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: input.hostUserId,
				actorType: "user",
				action: "tedi.embedded_conversation.capability_detached",
				resourceType: "tedi_conversation",
				resourceId: input.conversationId,
				metadata: {
					tediId: input.tediId,
					capabilityId: detached.capabilityId,
					replayName: detached.replayName,
					authority: "context_only",
				},
			});
			return { detached: true as const, referenceId: detached.id };
		});

export const listEmbeddedConversationArtifactPinsProcedure =
	authedTedisOs.listEmbeddedConversationArtifactPins
		.use(AUTHZ.tedisAppsRead)
		.handler(async ({ context, input }) => {
			const organizationId = await requireEmbeddedRuntimeCaller(
				context,
				input.tediId,
			);
			return {
				pins: await readConversationArtifactPins(context.db, {
					organizationId,
					conversationId: input.conversationId,
				}),
			};
		});

export const attachEmbeddedConversationArtifactPinProcedure =
	authedTedisOs.attachEmbeddedConversationArtifactPin
		.use(AUTHZ.tedisAppsWrite)
		.handler(async ({ context, input }) => {
			const organizationId = await requireEmbeddedRuntimeCaller(
				context,
				input.tediId,
			);
			let pin;
			try {
				pin = await pinConversationArtifactRevision(context.db, {
					id: crypto.randomUUID(),
					organizationId,
					conversationId: input.conversationId,
					artifactId: input.artifactId,
					replayName: input.replayName,
					attachedByType: "user",
					attachedById: input.hostUserId,
					createdAt: new Date().toISOString(),
					requireTediId: input.tediId,
					requireArtifactConversationId: input.conversationId,
				});
			} catch (error) {
				if (error instanceof ConversationArtifactPinConflictError) {
					throw createError(ErrorCodes.BAD_REQUEST, error.message);
				}
				throw error;
			}
			if (!pin) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Pinnable artifact revision not found in this signed conversation",
				);
			}
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: input.hostUserId,
				actorType: "user",
				action: "tedi.embedded_conversation.artifact_pinned",
				resourceType: "tedi_conversation",
				resourceId: input.conversationId,
				metadata: {
					tediId: input.tediId,
					artifactId: pin.artifactId,
					replayName: pin.replayName,
					revisionDigest: pin.revision.digest,
					authority: "context_only",
				},
			});
			return { pin };
		});

export const detachEmbeddedConversationArtifactPinProcedure =
	authedTedisOs.detachEmbeddedConversationArtifactPin
		.use(AUTHZ.tedisAppsWrite)
		.handler(async ({ context, input }) => {
			const organizationId = await requireEmbeddedRuntimeCaller(
				context,
				input.tediId,
			);
			const detached = await detachConversationArtifactPin(context.db, {
				organizationId,
				conversationId: input.conversationId,
				pinId: input.pinId,
			});
			if (!detached) {
				throw createError(ErrorCodes.NOT_FOUND, "Artifact pin not found");
			}
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: input.hostUserId,
				actorType: "user",
				action: "tedi.embedded_conversation.artifact_unpinned",
				resourceType: "tedi_conversation",
				resourceId: input.conversationId,
				metadata: {
					tediId: input.tediId,
					artifactId: detached.artifactId,
					replayName: detached.replayName,
					revisionDigest: detached.revisionDigest,
				},
			});
			return { detached: true as const, pinId: detached.id };
		});
