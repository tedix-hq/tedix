import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Breadcrumbs } from "@/components/kumo/breadcrumbs";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { LoadError } from "@/components/kumo/alert";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/kumo/collapsible";
import {
	Page,
	PageHeader,
	PageHeading,
	PageTitle,
	PageActions,
	PageSection,
	Collection,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Tabs,
	TabsList,
	TabsTrigger,
	TabsContent,
} from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { ListSkeleton } from "@/components/list-skeleton";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { CmsDomainManager } from "@/components/site-domain";
import { storeDeprovisionReceipt } from "@/components/site-delete-status";
import { osApi, osSiteDeprovisionApi } from "@/lib/api";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import { absoluteTime, normalizeD1Timestamp } from "@/lib/time";
import {
	sitesQueryOptions,
	siteRecoveryManifestQueryOptions,
	siteDeprovisionPlanQueryOptions,
	siteDeprovisionStatusQueryOptions,
	docsSiteWorkspaceQueryOptions,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { resolveOsTenant } from "@/shared/os-tenant";

const PART_NAMES: Record<string, string> = {
	site: "site record",
	authoring_app: "editor",
	gateway: "tool connection",
	durable_object: "content storage",
	media: "image storage",
	bundles: "published version",
	theme: "theme",
	sandbox: "build workspace",
	hostname: "address",
};

function docsVersionLabel(id: string, publishedAt?: string | null) {
	return publishedAt
		? absoluteTime(normalizeD1Timestamp(publishedAt))
		: id.slice(0, 7);
}

export function SitePage({ siteId }: { siteId: string }) {
	useOsFormattingPreferences();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const sites = useQuery(sitesQueryOptions());
	const site = sites.data?.sites.find((item) => item.id === siteId);
	const authority = useOsOperationalContext();
	const canManage =
		resolveOsTenant(window.location.hostname).kind === "local" ||
		(authority.data?.authority.permissions.includes("settings:manage") ??
			false);
	const history = useQuery({
		...siteRecoveryManifestQueryOptions(siteId),
		enabled: !!site,
	});
	const docs = useQuery({
		...docsSiteWorkspaceQueryOptions(siteId),
		enabled: site?.type === "docs",
	});
	const plan = useQuery({
		...siteDeprovisionPlanQueryOptions(siteId),
		enabled: site?.type === "cms" && canManage,
	});
	const missing =
		plan.data?.dependencies.filter(
			(part) => part.status === "absent" && part.kind !== "mcp_app",
		) ?? [];
	const [healthOpen, setHealthOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [dismissedMissing, setDismissedMissing] = useState(false);
	const deletion = useMutation({
		mutationFn: (confirmation: string) =>
			osSiteDeprovisionApi.sites.deprovision({ siteId, confirmation }),
		onSuccess: (result) => {
			storeDeprovisionReceipt({ ...result, name: site!.name });
			setDeleteOpen(false);
			void navigate({ to: "/sites" });
		},
		onError: (error) => {
			if (error instanceof Error && /timed out/i.test(error.message)) {
				queryClient.removeQueries({
					queryKey: siteDeprovisionStatusQueryOptions(siteId).queryKey,
				});
				storeDeprovisionReceipt({
					operationId: "",
					siteId,
					slug: site!.slug,
					name: site!.name,
					status: "checking",
					stage: "Checking request",
					deleted: [],
					errors: [],
				});
				setDeleteOpen(false);
				void navigate({ to: "/sites" });
			}
		},
	});
	const buildPreview = useMutation({
		mutationFn: () => osApi.docs.startBuild({ siteId }),
		onSuccess: () => {
			void queryClient.invalidateQueries(docsSiteWorkspaceQueryOptions(siteId));
			toast.success("Preview build started");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Could not build preview",
			),
	});
	const publish = useMutation({
		mutationFn: (input: { buildId: string; rollback: boolean }) =>
			input.rollback
				? osApi.docs.rollbackBuild({ siteId, buildId: input.buildId })
				: osApi.docs.publishBuild({ siteId, buildId: input.buildId }),
		onSuccess: () => {
			void queryClient.invalidateQueries(docsSiteWorkspaceQueryOptions(siteId));
			void queryClient.invalidateQueries(
				siteRecoveryManifestQueryOptions(siteId),
			);
			void queryClient.invalidateQueries(sitesQueryOptions());
			toast.success("Live version updated");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error
					? error.message
					: "Could not make this version live",
			),
	});
	if (!site)
		return (
			<Page width="xl">
				<Link to="/sites">Sites</Link>
				{sites.isPending ? (
					<ListSkeleton />
				) : sites.isError ? (
					<LoadError
						title="Website is unavailable"
						error={sites.error}
						retrying={sites.isFetching}
						onRetry={() => void sites.refetch()}
					/>
				) : (
					<Text as="p" role="body">
						Website not found.
					</Text>
				)}
			</Page>
		);
	const points = history.data?.recoveryPoints ?? [];
	const active = points.find((point) => point.active);
	const changes = [...points].sort((a, b) =>
		(b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
	);
	const publication =
		site.type === "docs"
			? docs.data?.releases.find(
					(release) => release.buildId === site.activeRevisionId,
				)?.createdAt
			: active?.createdAt;
	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<Breadcrumbs
						items={[{ label: "Sites", href: "/sites" }, { label: site.name }]}
					/>
					<PageTitle>{site.name}</PageTitle>
				</PageHeading>
				<PageActions>
					{site.editorUrl ? (
						<Button
							variant="outline"
							onClick={() =>
								window.open(site.editorUrl!, "_blank", "noopener,noreferrer")
							}
						>
							Open editor
						</Button>
					) : null}
					<Button
						onClick={() =>
							window.open(site.url, "_blank", "noopener,noreferrer")
						}
					>
						Visit site
					</Button>
				</PageActions>
			</PageHeader>
			<div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-kumo-hairline pb-4 type-tedix-body">
				<a
					href={site.url}
					target="_blank"
					rel="noreferrer"
					className="break-all hover:underline"
				>
					{new URL(site.url).host}
				</a>
				<Text role="body" tone="secondary" className="min-w-0 break-words">
					{site.activeRevisionId ? (
						<>
							{site.status === "active" ? "Live" : "Last live"}: version{" "}
							{site.type === "docs"
								? docsVersionLabel(site.activeRevisionId, publication)
								: site.activeRevisionId}
							{publication && site.type === "cms" ? (
								<>
									, published{" "}
									<time dateTime={normalizeD1Timestamp(publication)}>
										{absoluteTime(normalizeD1Timestamp(publication))}
									</time>
								</>
							) : null}
						</>
					) : (
						"Not published yet"
					)}
				</Text>
				{site.status !== "active" ? (
					<Badge variant="warning">
						{site.status === "paused" ? "Archived" : "Setting up"}
					</Badge>
				) : null}
			</div>
			<Tabs defaultValue="overview">
				<TabsList variant="line" aria-label="Website">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="versions">Versions</TabsTrigger>
					<TabsTrigger value="domain">Domain</TabsTrigger>
					{site.type === "cms" ? (
						<TabsTrigger value="settings">Settings</TabsTrigger>
					) : null}
				</TabsList>
				<TabsContent value="overview">
					<PageSection>
						<SectionTitle>Recent changes</SectionTitle>
						{history.isPending ? <ListSkeleton /> : null}
						{history.isError ? (
							<LoadError
								title="Changes are unavailable"
								error={history.error}
								retrying={history.isFetching}
								onRetry={() => void history.refetch()}
							/>
						) : null}
						{changes.length ? (
							<Collection>
								{changes.slice(0, 5).map((point) => (
									<li
										key={point.id}
										className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
									>
										<span>
											Version{" "}
											{site.type === "docs"
												? docsVersionLabel(
														point.id,
														docs.data?.releases.find(
															(release) => release.buildId === point.id,
														)?.createdAt ?? point.createdAt,
													)
												: point.id}
										</span>
										{point.createdAt && site.type === "cms" ? (
											<time
												className="text-kumo-subtle"
												dateTime={normalizeD1Timestamp(point.createdAt)}
											>
												{absoluteTime(normalizeD1Timestamp(point.createdAt))}
											</time>
										) : null}
									</li>
								))}
							</Collection>
						) : history.isSuccess ? (
							<Text role="body" tone="secondary">
								No changes yet.
							</Text>
						) : null}
					</PageSection>
				</TabsContent>
				<TabsContent value="versions">
					<PageSection>
						<SectionTitle>Versions</SectionTitle>
						{history.data?.themeCandidates?.length ? (
							<Collection>
								{history.data.themeCandidates.map((candidate) => (
									<li
										key={candidate.id}
										className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
									>
										<div>
											<Text role="body">Version {candidate.version}</Text>
											<Text as="p" role="caption" tone="secondary">
												{candidate.predecessorMatches
													? "Ready to go live"
													: "The live version changed; create a new preview"}
											</Text>
										</div>
										<a
											href={candidate.previewUrl}
											target="_blank"
											rel="noreferrer"
											className="text-kumo-link hover:underline"
										>
											Preview
										</a>
									</li>
								))}
							</Collection>
						) : null}

						{site.type === "docs" && canManage ? (
							<Button
								variant="outline"
								disabled={buildPreview.isPending}
								onClick={() => buildPreview.mutate()}
							>
								Build preview
							</Button>
						) : null}
						{history.isError ? (
							<LoadError
								title="Versions are unavailable"
								error={history.error}
								retrying={history.isFetching}
								onRetry={() => void history.refetch()}
							/>
						) : null}
						{site.type === "docs" ? (
							<>
								{docs.isPending ? <ListSkeleton /> : null}
								{docs.isError ? (
									<LoadError
										title="Documentation builds are unavailable"
										error={docs.error}
										retrying={docs.isFetching}
										onRetry={() => void docs.refetch()}
									/>
								) : null}
								{docs.data?.builds.length ? (
									<Collection>
										{docs.data.builds.map((build) => {
											const live = docs.data.site.activeBuildId === build.id;
											const rollback = docs.data.releases.some(
												(release) => release.buildId === build.id,
											);
											return (
												<li
													key={build.id}
													className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
												>
													<div>
														<Text role="body" className="break-all">
															Version{" "}
															{docsVersionLabel(
																build.id,
																docs.data.releases.find(
																	(release) => release.buildId === build.id,
																)?.createdAt,
															)}
														</Text>
														<Text as="p" role="caption" tone="secondary">
															{absoluteTime(
																normalizeD1Timestamp(build.createdAt),
															)}
															{build.status !== "complete"
																? ` · ${sentenceCase(build.status)}`
																: ""}
														</Text>
													</div>
													<div className="flex items-center gap-2">
														{live ? (
															<Badge variant="outline">Live</Badge>
														) : build.status === "complete" && canManage ? (
															<Button
																size="sm"
																variant="outline"
																disabled={publish.isPending}
																onClick={() =>
																	publish.mutate({
																		buildId: build.id,
																		rollback,
																	})
																}
															>
																{rollback ? "Roll back" : "Make live"}
															</Button>
														) : null}
													</div>
												</li>
											);
										})}
									</Collection>
								) : docs.isSuccess ? (
									<Text role="body" tone="secondary">
										No versions yet.
									</Text>
								) : null}
							</>
						) : (
							<>
								{history.isPending ? <ListSkeleton /> : null}
								{points.length ? (
									<Collection>
										{points.map((point) => (
											<li
												key={point.id}
												className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
											>
												<div>
													<Text role="body">Version {point.id}</Text>
													{point.createdAt ? (
														<Text as="p" role="caption" tone="secondary">
															{absoluteTime(
																normalizeD1Timestamp(point.createdAt),
															)}
														</Text>
													) : null}
												</div>
												{point.active ? (
													<Badge variant="outline">Live</Badge>
												) : null}
											</li>
										))}
									</Collection>
								) : history.isSuccess ? (
									<Text role="body" tone="secondary">
										No versions yet.
									</Text>
								) : null}
							</>
						)}
					</PageSection>
				</TabsContent>
				<TabsContent value="domain">
					<PageSection>
						<SectionTitle>Domain</SectionTitle>
						{site.type === "cms" &&
						canManage &&
						sites.data?.cmsCustomDomainsEnabled !== undefined &&
						!/(?:^|\.)tedix\.(?:dev|tech)\.?$/i.test(
							site.customDomain ?? "",
						) ? (
							<CmsDomainManager
								siteId={siteId}
								canConnect={sites.data.cmsCustomDomainsEnabled}
								currentAddress={
									site.status === "active" ? new URL(site.url).host : undefined
								}
							/>
						) : (
							<>
								<Text role="body">
									{site.status === "active" ? "Working" : "Website is not live"}
								</Text>
								<a
									href={site.url}
									target="_blank"
									rel="noreferrer"
									className="break-all hover:underline"
								>
									{new URL(site.url).host}
								</a>
							</>
						)}
					</PageSection>
				</TabsContent>
				{site.type === "cms" ? (
					<TabsContent value="settings">
						<PageSection>
							{canManage ? (
								<>
									<Collapsible
										open={
											healthOpen || (missing.length > 0 && !dismissedMissing)
										}
										onOpenChange={(open) => {
											setHealthOpen(open);
											if (!open) setDismissedMissing(true);
										}}
									>
										<CollapsibleTrigger>Health check</CollapsibleTrigger>
										<CollapsibleContent>
											{plan.isPending ? <ListSkeleton /> : null}
											{plan.isError ? (
												<LoadError
													title="Health check is unavailable"
													error={plan.error}
													retrying={plan.isFetching}
													onRetry={() => void plan.refetch()}
												/>
											) : null}
											{missing.length ? (
												<Collection>
													{missing.map((part) => (
														<li key={part.kind} className="px-4 py-3">
															The site's {PART_NAMES[part.kind] ?? part.kind} is
															missing.
														</li>
													))}
												</Collection>
											) : plan.isSuccess ? (
												<Text role="body" tone="secondary">
													No missing parts found.
												</Text>
											) : null}
										</CollapsibleContent>
									</Collapsible>
									<PageSection>
										<SectionTitle>Delete site</SectionTitle>
										<Text role="body" tone="secondary">
											Permanently delete this website and its content, images
											and versions. Connected tool apps are kept.
										</Text>
										<div>
											<Button
												variant="destructive"
												onClick={() => {
													deletion.reset();
													setDeleteOpen(true);
												}}
											>
												Delete site
											</Button>
										</div>
									</PageSection>
								</>
							) : (
								<Text role="body" tone="secondary">
									You need permission to manage this website's settings.
								</Text>
							)}
						</PageSection>
					</TabsContent>
				) : null}
			</Tabs>
			<TypedConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title={`Delete ${site.name}?`}
				description="This permanently deletes the website's content, images, versions and editor. Connected tool apps are kept."
				expectedName={site.slug}
				nameLabel="Site slug"
				confirmLabel="Delete site"
				pendingLabel="Deleting…"
				destructive
				isPending={deletion.isPending}
				error={deletion.error}
				onConfirm={(confirmation) => deletion.mutate(confirmation)}
			/>
		</Page>
	);
}
