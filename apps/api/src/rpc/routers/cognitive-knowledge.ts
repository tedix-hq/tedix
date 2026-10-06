/**
 * oRPC Cognitive Stack Router — knowledge slice.
 * Handlers are composed into the exported router in cognitive.ts.
 */

import {
	createKnowledgeEntry,
	getKnowledgeEntry,
	type KnowledgeEntryType,
	listKnowledgeByDomain,
	listKnowledgeByTedi,
	searchKnowledge,
} from "@tedix/db/queries/cognitive/knowledge-entries";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import { AUTHZ, withAuthorization } from "../orpc";
import { requireOrgId } from "../org-scope";
import { authedKnowledge } from "./cognitive-shared";

// =============================================================================
// KNOWLEDGE
// =============================================================================

export const knowledgeSynthesize = authedKnowledge.synthesize
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const domain = await getOrCreateDomain(context.db, orgId, input.domain);
		const visibility = input.visibility ?? (input.tediId ? "private" : "org");

		const entry = await createKnowledgeEntry(context.db, {
			id: crypto.randomUUID(),
			organizationId: orgId,
			tediId: input.tediId ?? null,
			domainId: domain.id,
			title: input.title,
			content: input.content,
			entryType: input.entryType,
			sourceFactIds: input.sourceFactIds ?? null,
			sourceCount: input.sourceFactIds?.length ?? 0,
			confidence: input.confidence ?? 0.8,
			visibility,
			tags: input.tags ?? null,
		});

		return { entry };
	});

export const knowledgeOpine = authedKnowledge.opine
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const domain = await getOrCreateDomain(context.db, orgId, input.domain);
		const visibility = input.tediId ? "private" : "org";

		const entry = await createKnowledgeEntry(context.db, {
			id: crypto.randomUUID(),
			organizationId: orgId,
			tediId: input.tediId ?? null,
			domainId: domain.id,
			title: input.title,
			content: input.content,
			entryType: "opinion",
			sourceFactIds: input.sourceFactIds ?? null,
			sourceCount: input.sourceFactIds?.length ?? 0,
			confidence: input.confidence ?? 0.7,
			visibility,
			tags: input.tags ?? null,
		});

		return { entry };
	});

export const knowledgeList = authedKnowledge.list
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		// Text search takes priority
		if (input.query) {
			let domainId: string | undefined;
			if (input.domain) {
				const d = await getOrCreateDomain(context.db, orgId, input.domain);
				domainId = d.id;
			}
			const entries = await searchKnowledge(context.db, orgId, input.query, {
				tediId: input.tediId,
				domainId,
				limit: input.limit,
			});
			return { entries };
		}

		// Domain filter
		if (input.domain) {
			const d = await getOrCreateDomain(context.db, orgId, input.domain);
			const entries = await listKnowledgeByDomain(context.db, orgId, d.id, {
				limit: input.limit,
				entryType: input.entryType as KnowledgeEntryType,
			});
			return { entries };
		}

		// Tedi filter
		if (input.tediId) {
			const entries = await listKnowledgeByTedi(
				context.db,
				orgId,
				input.tediId,
				{
					limit: input.limit,
				},
			);
			return { entries };
		}

		// Default: search all
		const entries = await searchKnowledge(context.db, orgId, "%", {
			limit: input.limit,
		});
		return { entries };
	});

export const knowledgeGet = authedKnowledge.get
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const entry = await getKnowledgeEntry(context.db, input.id, orgId);
		return { entry: entry ?? null };
	});
