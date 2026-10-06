import type {
	ModelCatalogModel,
	ModelCatalogRouting,
} from "@tedix/api-contract/schemas/model-catalog-projection";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { modelCatalogQueryOptions } from "@/lib/os-query-options";

/**
 * Allowed / denied counts. Returned as numbers only because the caller ALWAYS
 * has data in hand — an absent read renders the error branch instead, never a
 * "0 allowed" that reads like a policy verdict.
 */
export function modelCounts(models: readonly ModelCatalogModel[]): {
	allowed: number;
	denied: number;
} {
	const allowed = models.filter((model) => model.allowed).length;
	return { allowed, denied: models.length - allowed };
}

/**
 * Group denied models by the reason that denied them, so an operator sees
 * "3 models: organization model-tier policy" rather than a flat wall. Reasons
 * come from the projection; this never invents one.
 */
export function denialGroups(
	models: readonly ModelCatalogModel[],
): Array<{ reason: string; detail: string; refs: string[] }> {
	const groups = new Map<string, { detail: string; refs: string[] }>();
	for (const model of models) {
		if (!model.deniedBy) continue;
		const existing = groups.get(model.deniedBy.reason);
		if (existing) {
			existing.refs.push(model.ref);
			continue;
		}
		groups.set(model.deniedBy.reason, {
			detail: model.deniedBy.detail,
			refs: [model.ref],
		});
	}
	return [...groups].map(([reason, group]) => ({ reason, ...group }));
}

export function ModelCatalogCard({
	models,
	routing,
	wiredProviders,
	embedded = false,
}: {
	models: readonly ModelCatalogModel[];
	routing: ModelCatalogRouting;
	wiredProviders: readonly string[];
	/** Removes standalone chrome when the catalog is a row in a shared panel. */
	embedded?: boolean;
}) {
	const counts = modelCounts(models);
	const groups = denialGroups(models);
	const layout = "grid gap-1.5 px-4 py-3";
	const body = (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" tone="strong" weight="medium">
					Model catalog
				</Text>
				<Badge variant={counts.allowed > 0 ? "success" : "destructive"}>
					{counts.allowed} allowed
				</Badge>
				{counts.denied > 0 && (
					<Badge variant="outline">{counts.denied} denied</Badge>
				)}
			</div>
			<Text as="span" role="label" tone="secondary">
				{routing.detail}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{wiredProviders.length > 0
					? `Wired providers: ${wiredProviders.join(" · ")}`
					: "No model provider is wired in this deployment."}
			</Text>
			{groups.length > 0 && (
				<ul className="m-0 grid gap-1 pl-4">
					{groups.map((group) => (
						<Text as="li" role="label" tone="secondary" key={group.reason}>
							<Text as="span" role="label" tone="strong">
								{group.refs.length} denied
							</Text>{" "}
							— {group.detail}
						</Text>
					))}
				</ul>
			)}
		</>
	);
	/**
	 * Embedded, the catalog is a row inside a shared collection and carries no
	 * chrome of its own. Standalone it sits on the page canvas as a peer of
	 * other operational panels, so it takes the card geometry tier.
	 */
	if (embedded) return <div className={layout}>{body}</div>;
	return (
		<Surface tier="panel" className={layout}>
			{body}
		</Surface>
	);
}

/**
 * Organization-scope read of the one contract-backed catalog. No tedi is named,
 * so the per-tedi tier and Agent-runtime filters are deliberately absent from
 * the chain rather than passing over an input this surface never read.
 */
export function ModelCatalogSection({
	embedded = false,
}: {
	embedded?: boolean;
}) {
	const catalog = useQuery({
		...modelCatalogQueryOptions(),
		staleTime: 60_000,
	});
	return (
		<>
			{catalog.isPending && (
				<div className={embedded ? "px-4 py-3" : undefined}>
					<ListSkeleton rows={1} rowClassName="h-16" />
				</div>
			)}
			{catalog.isError && (
				<Alert variant="destructive">
					<AlertTitle>The model catalog is unavailable</AlertTitle>
					<AlertDescription>
						{(catalog.error as Error).message} — no model availability is known
						for this workspace.
					</AlertDescription>
				</Alert>
			)}
			{catalog.data && (
				<ModelCatalogCard
					models={catalog.data.models}
					routing={catalog.data.routing}
					wiredProviders={catalog.data.wiredProviders}
					embedded={embedded}
				/>
			)}
		</>
	);
}
