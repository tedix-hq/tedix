/**
 * One gallery blueprint's landing page: the signed-in read
 * (`blueprints.galleryPage`) and the signed-out public read
 * (`GET /public/blueprints/:id`) both come from here.
 *
 * The page is built from an ALLOWLIST, never by stripping fields from a row:
 * every value below is named explicitly, and the public shape is parsed through
 * the strict `OsBlueprintPublicPageSchema` before it leaves, so a field added
 * to the row or the definition later cannot ride along.
 */
import {
	type OsBlueprintGalleryPage,
	type OsBlueprintPublicPage,
	OsBlueprintPublicPageSchema,
} from "@tedix/api-contract/contracts/os-workspaces";
import { parseStoredOsBlueprintDefinition } from "@tedix/api-contract/schemas/os-workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getCatalogOsBlueprint,
	getOsBlueprintRevision,
} from "@tedix/db/queries/os-workspaces/blueprints";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a catalog-visible, published blueprint's landing page. Private,
 * unpublished, and missing ids all resolve to `undefined` — the query's
 * catalog predicate is the boundary, not the caller.
 */
export async function readGalleryBlueprintPage(
	db: DbQueryClient,
	blueprintId: string,
): Promise<OsBlueprintGalleryPage | undefined> {
	if (!UUID_PATTERN.test(blueprintId)) return undefined;
	const source = await getCatalogOsBlueprint(db, blueprintId);
	if (!source?.blueprint.currentRevisionId) return undefined;
	const revision = await getOsBlueprintRevision(db, {
		organizationId: source.blueprint.organizationId,
		revisionId: source.blueprint.currentRevisionId,
	});
	if (!revision) return undefined;
	const definition = parseStoredOsBlueprintDefinition(revision.definition);
	const requirements = definition.requirements;
	return {
		id: source.blueprint.id,
		name: source.blueprint.name,
		description: source.blueprint.description,
		publishedAt: revision.publishedAt,
		featured: source.blueprint.featuredAt !== null,
		apps: definition.gadgets.map((gadget) => ({ name: gadget.name })),
		needs: {
			connections: (requirements?.connections ?? []).map((connection) => ({
				providerId: connection.providerId,
			})),
			resources: (requirements?.resources ?? []).map((resource) => ({
				label: resource.label,
				providerId: resource.providerId,
			})),
			skills: (requirements?.skills ?? []).map((skill) => ({
				slug: skill.slug,
			})),
			outputs: (requirements?.outputs ?? []).map((output) => ({
				title: output.title,
				kind: output.kind,
			})),
		},
		organizationName: source.organizationName,
	};
}

/** The signed-out projection: the gallery page minus the publisher's name. */
export function toPublicBlueprintPage(
	page: OsBlueprintGalleryPage,
): OsBlueprintPublicPage {
	const { organizationName: _publisher, ...rest } = page;
	return OsBlueprintPublicPageSchema.parse(rest);
}

const PUBLIC_HEADERS = {
	"Cache-Control": "public, max-age=60",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
} as const;

/** `GET /public/blueprints/:id`: the public page or an indistinguishable 404. */
export async function handlePublicBlueprintPage(
	db: DbQueryClient,
	blueprintId: string,
): Promise<Response> {
	const page = await readGalleryBlueprintPage(db, blueprintId);
	if (!page) {
		return Response.json(
			{ error: "Not found" },
			{ status: 404, headers: PUBLIC_HEADERS },
		);
	}
	return Response.json(
		{ blueprint: toPublicBlueprintPage(page) },
		{ headers: PUBLIC_HEADERS },
	);
}
