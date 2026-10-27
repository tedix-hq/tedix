import { ArrowSquareOut, Plugs } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { friendlyProviderName } from "@/components/account-list";
import { usableLogoUrl } from "@/lib/app-icon";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	connectionProvidersQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import {
	sourceLabel,
	sourceOrigin,
	sourceTarget,
	sourceTypeLabel,
	type WorkspaceSource,
} from "@/lib/workspace-sources";

/** The Tedix mark, for sources Tedix itself holds (files, outputs). */
const TEDIX_LOGO = "/icon-192.png";

/**
 * Connected sources as cards on the same grid as Files: the app's logo, the
 * source's name, a type chip, whose account it is, and Open. Logos and app
 * names come from the provider catalog the Connections page reads.
 */
export function WorkspaceSourceCards({
	sources,
	onOpenOutput,
	workspaceId,
}: {
	sources: readonly WorkspaceSource[];
	onOpenOutput: (outputId: string) => void;
	workspaceId: string;
}) {
	// Logos are decoration: a slow or denied catalog leaves the plain tile.
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const isWorkspaceFile = (source: WorkspaceSource) =>
		source.providerId === "tedix" && source.resourceType === "file";
	async function openFile(source: WorkspaceSource) {
		setBusy(source.id);
		setError(null);
		try {
			const file = await osApi.osWorkspaces.resources.getFile({
				workspaceId,
				resourceId: source.id,
			});
			window.open(file.url, "_blank", "noopener");
		} catch {
			setError(`Could not open ${source.name}.`);
		} finally {
			setBusy(null);
		}
	}
	async function removeSource(source: WorkspaceSource) {
		setBusy(source.id);
		setError(null);
		try {
			await osApi.osWorkspaces.resources.remove({
				workspaceId,
				resourceId: source.id,
				expectedUpdatedAt: source.updatedAt,
			});
			await queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			});
		} catch {
			setError(`Could not remove ${source.name}.`);
		} finally {
			setBusy(null);
		}
	}
	const providers = useQuery({
		...connectionProvidersQueryOptions(),
		staleTime: 60_000,
		retry: false,
	});
	const providerById = new Map(
		(providers.data?.data ?? []).map((provider) => [provider.appId, provider]),
	);
	return (
		<ul
			aria-label="Connected sources"
			className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3"
		>
			{sources.map((source) => {
				const provider = providerById.get(source.providerId);
				const providerName = provider
					? friendlyProviderName(provider)
					: sourceLabel(source.providerId);
				const logo =
					source.providerId === "tedix"
						? TEDIX_LOGO
						: usableLogoUrl(provider?.logoUrl ?? null);
				const target = sourceTarget(source);
				return (
					<li key={source.id} className="min-w-0">
						<article
							aria-label={source.name}
							data-workspace-source={source.id}
							className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3"
						>
							<div className="flex min-w-0 items-start gap-3">
								{logo ? (
									<img
										src={logo}
										alt=""
										className="size-10 shrink-0 rounded-lg border border-kumo-hairline bg-kumo-base object-contain p-1.5"
									/>
								) : (
									<span
										aria-hidden
										className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-kumo-hairline bg-kumo-fill text-kumo-subtle"
									>
										<Plugs size={18} />
									</span>
								)}
								<div className="grid min-w-0 flex-1 gap-1">
									<Text
										as="h3"
										role="body"
										tone="strong"
										weight="medium"
										className="m-0 line-clamp-2 wrap-anywhere"
										title={source.name}
									>
										{source.name}
									</Text>
									<Text
										as="p"
										role="label"
										tone="secondary"
										className="m-0 truncate"
										title={sourceOrigin(source, providerName)}
									>
										{sourceOrigin(source, providerName)}
									</Text>
								</div>
							</div>
							<div className="mt-auto flex min-w-0 items-center justify-between gap-2">
								<Badge className="shrink-0" variant="secondary">
									{sourceTypeLabel(source.resourceType)}
								</Badge>
								{target?.kind === "file" ? (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Open ${source.name}`}
										disabled={busy === source.id}
										onClick={() => void openFile(source)}
									>
										Open
									</Button>
								) : target?.kind === "output" ? (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Open ${source.name}`}
										onClick={() => onOpenOutput(target.outputId)}
									>
										Open
									</Button>
								) : target?.kind === "link" ? (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Open ${source.name}`}
										render={
											target.external ? (
												<a
													href={target.href}
													target="_blank"
													rel="noreferrer"
												/>
											) : (
												<a href={target.href} />
											)
										}
									>
										Open
										{target.external ? (
											<ArrowSquareOut aria-hidden size={14} />
										) : null}
									</Button>
								) : null}
								{isWorkspaceFile(source) ? (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Remove ${source.name}`}
										disabled={busy === source.id}
										onClick={() => void removeSource(source)}
									>
										Remove
									</Button>
								) : null}
							</div>
						</article>
					</li>
				);
			})}
			{error ? (
				<Text as="p" role="label" tone="error" className="m-0">
					{error}
				</Text>
			) : null}
		</ul>
	);
}
