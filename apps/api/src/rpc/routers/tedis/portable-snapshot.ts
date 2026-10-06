import {
	PortableTediDomainSchema,
	PortableTediEdgeSchema,
	PortableTediFactSchema,
	PortableTediRationaleSchema,
	PortableTediSkillSchema,
	type PortableTediSnapshotPageInput,
} from "@tedix/api-contract/schemas/portable-tedi";
import {
	listPortableTediDomainsPage,
	listPortableTediEdgesPage,
	listPortableTediFactsPage,
	listPortableTediRationalePage,
	listPortableTediSkillsPage,
} from "@tedix/db/queries/portable-tedi/snapshot";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	AUTHZ,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	requireOrganizationId,
	withAuthorization,
} from "./helpers";

function nextAfterId(
	rows: Array<{ id: string }>,
	limit: number,
): string | null {
	return rows.length === limit ? (rows.at(-1)?.id ?? null) : null;
}

/**
 * The handler's data path is kept callable for D1-backed boundary tests. It
 * enforces organization ownership again after the procedure scope gates.
 */
export async function readPortableSnapshotPage(
	context: BaseContext,
	input: PortableTediSnapshotPageInput,
) {
	if (context.authType !== "user" && context.authType !== "apikey") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Portable export requires a user or operator API key",
		);
	}
	return readPortableSnapshotPageForOrganization(
		context.db,
		requireOrganizationId(context),
		input,
	);
}

/** The signed bulk route reuses the same tenant-scoped, validated row projection. */
export async function readPortableSnapshotPageForOrganization(
	db: BaseContext["db"],
	organizationId: string,
	input: PortableTediSnapshotPageInput,
) {
	const tedi = await getTediByIdForOrganization(
		db,
		input.tediId,
		organizationId,
	);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	const page = { afterId: input.afterId, limit: input.limit };
	const limit = input.limit ?? 100;

	switch (input.section) {
		case "memoryDomains": {
			const rows = await listPortableTediDomainsPage(
				db,
				organizationId,
				tedi.id,
				page,
			);
			return {
				section: "memoryDomains" as const,
				rows: rows.map((row) => PortableTediDomainSchema.parse(row)),
				nextAfterId: nextAfterId(rows, limit),
			};
		}
		case "memoryFacts": {
			const rows = await listPortableTediFactsPage(
				db,
				organizationId,
				tedi.id,
				page,
			);
			return {
				section: "memoryFacts" as const,
				rows: rows.map((row) => PortableTediFactSchema.parse(row)),
				nextAfterId: nextAfterId(rows, limit),
			};
		}
		case "memoryEdges": {
			const rows = await listPortableTediEdgesPage(
				db,
				organizationId,
				tedi.id,
				page,
			);
			return {
				section: "memoryEdges" as const,
				rows: rows.map((row) => PortableTediEdgeSchema.parse(row)),
				nextAfterId: nextAfterId(rows, limit),
			};
		}
		case "skills": {
			const rows = await listPortableTediSkillsPage(
				db,
				organizationId,
				tedi.id,
				page,
			);
			return {
				section: "skills" as const,
				rows: rows.map((row) => PortableTediSkillSchema.parse(row)),
				nextAfterId: nextAfterId(rows, limit),
			};
		}
		case "rationale": {
			const rows = await listPortableTediRationalePage(
				db,
				organizationId,
				tedi.id,
				page,
			);
			return {
				section: "rationale" as const,
				rows: rows.map((row) => PortableTediRationaleSchema.parse(row)),
				nextAfterId: nextAfterId(rows, limit),
			};
		}
	}
}

/** Export requires identity, memory, and skill scopes on machine callers. */
export const portableSnapshotPageProcedure = authedTedisOs.portableSnapshotPage
	.use(withAuthorization("tedis:read", "mcp:tedis.read"))
	.use(AUTHZ.memoryRead)
	.use(withAuthorization("tedis:read", "mcp:skills.read"))
	.handler(({ input, context }) => readPortableSnapshotPage(context, input));
