import { call } from "@orpc/server";
import type { CreateWorkItemInput } from "@tedix/api-contract/schemas/work-items";
import {
	cardsFromSheet,
	factoryCardDecisionEnvelope,
	factorySourcesFromManifest,
} from "@tedix/api-contract/utils/card-review";
import { listCardSourceApps } from "@tedix/db/queries/os-workspaces/gadgets";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";

/**
 * A factory card filed as Work carries its decision envelope in
 * `metadata.decisionDeck`, built here on the server from the card row and
 * its source's settings. The caller names only the card (`factoryCard`);
 * the sheet is read with the caller's own access, so a caller that cannot
 * read the card cannot copy it into Work.
 */
export async function prepareFactoryCard(
	context: BaseContext,
	orgId: string,
	input: CreateWorkItemInput,
): Promise<CreateWorkItemInput> {
	if (!input.factoryCard) return input;
	if (input.metadata?.decisionDeck !== undefined)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"A factory card's decision envelope is server-derived; omit metadata.decisionDeck",
		);
	const { cardSheetId, row } = input.factoryCard;
	const { osWorkspacesContractRouter } =
		await import("../rpc/routers/os-workspaces");
	const detail = await call(
		osWorkspacesContractRouter.outputs.get,
		{ outputId: cardSheetId },
		{ context },
	);
	const content = detail.currentRevision.content;
	if (content.kind !== "sheet")
		throw createError(ErrorCodes.BAD_REQUEST, "factoryCard names a sheet");
	const apps = await listCardSourceApps(context.db, {
		organizationId: orgId,
		limit: 100,
	});
	for (const app of apps) {
		let manifest: unknown;
		try {
			manifest = JSON.parse(app.revision.manifest);
		} catch {
			continue;
		}
		const found = factorySourcesFromManifest(manifest);
		const sourceIndex =
			found?.sources.findIndex(
				(source) =>
					source.workspaceId === detail.output.workspaceId &&
					detail.output.title.startsWith(source.cardSheetPrefix),
			) ?? -1;
		const source = found?.sources[sourceIndex];
		if (!source) continue;
		const parsed = cardsFromSheet({
			source,
			sourceIndex,
			outputId: cardSheetId,
			sheetTitle: detail.output.title,
			runCreatedAt: detail.output.createdAt,
			body: content,
		});
		const card =
			"cards" in parsed
				? parsed.cards.find((candidate) => candidate.rowIndex === row)
				: undefined;
		if (!card)
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Card row ${row} is not a card of the ${source.label} source`,
			);
		return {
			...input,
			metadata: {
				...input.metadata,
				decisionDeck: factoryCardDecisionEnvelope(source, card),
				factoryCard: { cardSheetId, row, source: source.label },
			},
		};
	}
	throw createError(
		ErrorCodes.BAD_REQUEST,
		"No Card review or Decisions source reads this card sheet",
	);
}
