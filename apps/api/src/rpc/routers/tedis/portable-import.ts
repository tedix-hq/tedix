import type { PortableTediImportPageSchema } from "@tedix/api-contract/schemas/portable-tedi";
import {
	insertPortableTediDomainsPage,
	insertPortableTediEdgesPage,
	insertPortableTediFactsPage,
	insertPortableTediRationalePage,
	insertPortableTediSkillsPage,
	linkPortableTediSkillsPage,
} from "@tedix/db/queries/portable-tedi/import";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { DbClient } from "@tedix/db/client";
import type * as z from "zod";
import { createError, ErrorCodes } from "./helpers";

/** A signed, user-issued ticket cannot write outside its paused tedi. */
export async function writePortableImportPage(
	db: DbClient,
	ticket: {
		organizationId: string;
		tediId: string;
		sourceTediId: string;
	},
	page: z.infer<typeof PortableTediImportPageSchema>,
): Promise<number> {
	const tedi = await getTediByIdForOrganization(
		db,
		ticket.tediId,
		ticket.organizationId,
	);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	if (tedi.status !== "paused") {
		throw createError(
			ErrorCodes.CONFLICT,
			"Portable import target must remain paused",
		);
	}
	const target = {
		organizationId: ticket.organizationId,
		tediId: tedi.id,
		tediSlug: tedi.slug,
		sourceTediId: ticket.sourceTediId,
	};
	switch (page.section) {
		case "memoryDomains":
			return insertPortableTediDomainsPage(db, target, page.rows);
		case "memoryFacts":
			// The bearer was minted only after interactive user authorization.
			return insertPortableTediFactsPage(db, target, page.rows, true);
		case "memoryEdges":
			return insertPortableTediEdgesPage(db, target, page.rows);
		case "skills":
			return insertPortableTediSkillsPage(db, target, page.rows);
		case "skillLinks":
			return linkPortableTediSkillsPage(db, target, page.rows);
		case "rationale":
			return insertPortableTediRationalePage(db, target, page.rows);
	}
}
