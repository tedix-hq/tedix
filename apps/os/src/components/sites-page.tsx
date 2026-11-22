import { useStore } from "@tanstack/react-form";
import type { CmsTemplateSlug } from "@tedix/api-contract/schemas/cms-template";
import { DotsThree, Globe, Plus } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import {
	Alert,
	AlertTitle,
	AlertDescription,
	LoadError,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Page,
	PageHeader,
	PageHeading,
	PageTitle,
	PageActions,
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
	PageToolbar,
} from "@/components/kumo/page";
import { SearchInput } from "@/components/kumo/search-input";
import { Table, TableBody, TableCell, TableRow } from "@/components/kumo/table";
import { Empty } from "@/components/kumo/empty";
import { toast } from "@/components/kumo/toast";
import { ListSkeleton } from "@/components/list-skeleton";
import { SiteDeleteStatus } from "@/components/site-delete-status";
import { osApi } from "@/lib/api";
import { sentenceCase, useOsFormattingPreferences } from "@/lib/format";
import { normalizeD1Timestamp, relativeTime, absoluteTime } from "@/lib/time";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { resolveOsTenant } from "@/shared/os-tenant";
import {
	sitesQueryOptions,
	sitesReconciliationQueryOptions,
} from "@/lib/os-query-options";

export function SitesPage() {
	useOsFormattingPreferences();
	const navigate = useNavigate();
	const operationalContext = useOsOperationalContext();
	const canCreateCmsSite =
		resolveOsTenant(window.location.hostname).kind === "local" ||
		(operationalContext.data?.authority.permissions.includes(
			"settings:manage",
		) ??
			false);
	const sites = useQuery(sitesQueryOptions());
	const cmsSiteQuota = sites.data?.cmsSiteQuota;
	const cmsSiteLimitReached =
		cmsSiteQuota !== undefined &&
		cmsSiteQuota.limit !== -1 &&
		cmsSiteQuota.used >= cmsSiteQuota.limit;
	const reconciliation = useQuery(sitesReconciliationQueryOptions());
	const queryClient = useQueryClient();
	const [newSiteTemplate, setNewSiteTemplate] =
		useState<CmsTemplateSlug>("native-marketing");
	const [createOpen, setCreateOpen] = useState(false);
	const [siteSearch, setSiteSearch] = useState("");
	const createCmsSite = useMutation({
		mutationFn: (input: {
			name: string;
			slug: string;
			templateSlug: CmsTemplateSlug;
		}) => osApi.sites.createCms(input),
		onSuccess: (result) => {
			createSiteForm.reset();
			setCreateOpen(false);
			void queryClient.invalidateQueries(sitesQueryOptions());
			void queryClient.invalidateQueries(sitesReconciliationQueryOptions());
			toast.success(
				`${result.slug} is ready for authoring. Deploy a theme to publish it.`,
			);
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Website creation failed",
			),
	});
	const createSiteForm = useZodForm({
		schema: z.object({
			name: z.string().trim().min(1, "Name is required.").max(100),
			slug: z
				.string()
				.trim()
				.min(1, "Slug is required.")
				.max(63)
				.regex(
					/^[a-z0-9]+(-[a-z0-9]+)*$/,
					"Use lowercase letters, numbers, and single hyphens.",
				),
		}),
		defaultValues: { name: "", slug: "" },
		onSubmit: ({ value }) => {
			createCmsSite.mutate({ ...value, templateSlug: newSiteTemplate });
		},
	});
	const createSiteValues = useStore(
		createSiteForm.store,
		(state) => state.values,
	);

	const filteredSites = sites.data?.sites.filter((site) =>
		[site.name, site.url].some((value) =>
			value.toLowerCase().includes(siteSearch.trim().toLowerCase()),
		),
	);
	const check = useMutation({
		mutationFn: () => osApi.sites.runReconciliation({}),
		onSuccess: () => {
			void queryClient.invalidateQueries(sitesReconciliationQueryOptions());
			toast.success("Health check finished");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Health check failed",
			),
	});
	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>Sites</PageTitle>
				</PageHeading>
				<PageActions>
					{canCreateCmsSite ? (
						<Button
							onClick={() => setCreateOpen((open) => !open)}
							disabled={cmsSiteLimitReached}
							aria-expanded={createOpen}
							aria-controls="create-cms-site"
						>
							<Plus size={16} />
							New site
						</Button>
					) : null}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									size="icon"
									variant="ghost"
									aria-label="Website actions"
								/>
							}
						>
							<DotsThree size={20} />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								disabled={check.isPending}
								onClick={() => check.mutate()}
							>
								Check now
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</PageActions>
			</PageHeader>
			{canCreateCmsSite && createOpen ? (
				<PageSection id="create-cms-site">
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>New site</SectionTitle>
							<SectionDescription>
								Create a site and its authoring tools. Deploy a theme when you
								are ready to publish.
							</SectionDescription>
						</SectionHeading>
					</SectionHeader>
					<form
						className="grid gap-4 sm:grid-cols-3"
						onSubmit={(event) => {
							event.preventDefault();
							void createSiteForm.handleSubmit();
						}}
					>
						<FormField form={createSiteForm} name="name" label="Name">
							{(field, meta) => (
								<FormInput field={field} {...meta} maxLength={100} required />
							)}
						</FormField>
						<FormField form={createSiteForm} name="slug" label="Slug">
							{(field, meta) => (
								<FormInput
									field={field}
									{...meta}
									maxLength={63}
									required
									pattern="[a-z0-9]+(-[a-z0-9]+)*"
								/>
							)}
						</FormField>
						<div className="grid gap-2">
							<Label htmlFor="new-cms-template">Starter template</Label>
							<Select
								value={newSiteTemplate}
								items={{
									starter: "Starter",
									blog: "Blog",
									portfolio: "Portfolio",
									"native-marketing": "Marketing",
									marketing: "Tedix marketing",
									tedix: "Tedix",
								}}
								onValueChange={(value) =>
									setNewSiteTemplate(value as CmsTemplateSlug)
								}
							>
								<SelectTrigger id="new-cms-template">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="starter">Starter</SelectItem>
									<SelectItem value="blog">Blog</SelectItem>
									<SelectItem value="portfolio">Portfolio</SelectItem>
									<SelectItem value="native-marketing">Marketing</SelectItem>
									<SelectItem value="marketing">Tedix marketing</SelectItem>
									<SelectItem value="tedix">Tedix</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-wrap justify-end gap-2 sm:col-span-3">
							<Button
								type="button"
								variant="outline"
								onClick={() => setCreateOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={
									createCmsSite.isPending ||
									cmsSiteLimitReached ||
									!createSiteValues.name.trim() ||
									!createSiteValues.slug.trim()
								}
							>
								{createCmsSite.isPending ? "Creating…" : "New site"}
							</Button>
						</div>
					</form>
				</PageSection>
			) : null}

			{reconciliation.data?.issues.length ? (
				<Alert>
					<AlertTitle>Some sites need attention</AlertTitle>
					<AlertDescription>
						<ul>
							{reconciliation.data.issues.map((issue) => (
								<li key={`${issue.siteId}:${issue.code}`}>
									<Link to="/sites/$siteId" params={{ siteId: issue.siteId }}>
										{issue.slug}
									</Link>
									: {issue.detail}
								</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			) : null}
			<PageSection>
				{sites.data?.sites.length ? (
					<PageToolbar appearance="inline">
						<SearchInput
							aria-label="Search sites"
							placeholder="Search by site or domain"
							value={siteSearch}
							onChange={(event) => setSiteSearch(event.target.value)}
							containerClassName="w-full lg:max-w-md"
						/>
					</PageToolbar>
				) : null}
				{sites.isPending ? <ListSkeleton /> : null}
				{sites.isError ? (
					<LoadError
						title="Sites are unavailable"
						error={sites.error}
						onRetry={() => void sites.refetch()}
						retrying={sites.isFetching}
					/>
				) : null}
				{sites.data?.sites.length === 0 ? (
					<Empty
						appearance="quiet"
						title="No sites yet"
						description="Create a site to start publishing a website."
					/>
				) : null}
				{sites.data?.sites.length && filteredSites?.length === 0 ? (
					<Empty
						appearance="quiet"
						title="No matching sites"
						description="Try another name or domain."
					/>
				) : null}
				{filteredSites?.length ? (
					<Table scrollLabel="Sites">
						<TableBody>
							{filteredSites.map((site) => (
								<TableRow
									key={site.id}
									className="cursor-pointer"
									onClick={() =>
										void navigate({
											to: "/sites/$siteId",
											params: { siteId: site.id },
										})
									}
								>
									<TableCell>
										<div className="flex min-w-0 items-center gap-3">
											<Globe size={22} className="shrink-0 text-kumo-subtle" />
											<div className="min-w-0">
												<div className="flex flex-wrap items-center gap-2">
													<Link
														to="/sites/$siteId"
														params={{ siteId: site.id }}
														className="font-medium"
														onClick={(event) => event.stopPropagation()}
													>
														{site.name}
													</Link>
													{site.type === "docs" ? (
														<Badge variant="outline">Docs</Badge>
													) : null}
													{site.status !== "active" ? (
														<Badge variant="warning">
															{site.status === "paused"
																? "Archived"
																: sentenceCase(site.status)}
														</Badge>
													) : null}
												</div>
												<a
													href={site.url}
													target="_blank"
													rel="noreferrer"
													className="break-all text-kumo-subtle type-tedix-control hover:underline"
													onClick={(event) => event.stopPropagation()}
												>
													{new URL(site.url).host}
												</a>
											</div>
										</div>
									</TableCell>
									<TableCell className="text-right text-kumo-subtle">
										{site.changedAt ? (
											<time
												dateTime={normalizeD1Timestamp(site.changedAt)}
												title={absoluteTime(
													normalizeD1Timestamp(site.changedAt),
												)}
											>
												Changed{" "}
												{relativeTime(normalizeD1Timestamp(site.changedAt))}
											</time>
										) : null}
									</TableCell>
									<TableCell
										className="w-12"
										onClick={(event) => event.stopPropagation()}
									>
										<DropdownMenu>
											<DropdownMenuTrigger
												render={
													<Button
														size="icon-sm"
														variant="ghost"
														aria-label={`More actions for ${site.name}`}
													/>
												}
											>
												<DotsThree size={18} />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													onClick={() =>
														window.open(
															site.url,
															"_blank",
															"noopener,noreferrer",
														)
													}
												>
													Open site
												</DropdownMenuItem>
												{site.editorUrl ? (
													<DropdownMenuItem
														onClick={() =>
															window.open(
																site.editorUrl!,
																"_blank",
																"noopener,noreferrer",
															)
														}
													>
														Open editor
													</DropdownMenuItem>
												) : null}
											</DropdownMenuContent>
										</DropdownMenu>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				) : null}
			</PageSection>
			<SiteDeleteStatus />
		</Page>
	);
}
