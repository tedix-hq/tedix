import type { CmsTemplateSlug } from "@tedix/api-contract/schemas/cms-template";
import { DotsThree, FileText, Globe, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getOsSurface } from "@/lib/os-navigation";
import { resolveOsTenant } from "@/shared/os-tenant";
import { useEffect, useRef, useState } from "react";
import { FormInput } from "@/components/forms/form-input";
import { toast } from "@/components/kumo/toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { exactConfirmationSchema } from "@/components/kumo/forms/exact-confirmation-schema";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Empty } from "@/components/kumo/empty";
import { SearchInput } from "@/components/kumo/search-input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/kumo/alert-dialog";
import {
	Collection,
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	PageToolbar,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { osApi, osSiteDeprovisionApi } from "@/lib/api";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import {
	docsSiteWorkspaceQueryOptions,
	siteDeprovisionPlanQueryOptions,
	siteDeprovisionStatusQueryOptions,
	siteRecoveryManifestQueryOptions,
	sitesQueryOptions,
	sitesReconciliationQueryOptions,
	osQuery,
} from "@/lib/os-query-options";

function siteMetadata(site: {
	accessMode?: string | null;
	activeRevisionId?: string | null;
	customDomain?: string | null;
	type: string;
}) {
	return [
		site.activeRevisionId
			? site.type === "cms"
				? `Bundle v${site.activeRevisionId}`
				: "Published"
			: null,
		site.accessMode ? `Access: ${site.accessMode}` : null,
		site.customDomain ? "Custom domain" : null,
	]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
}

const DISABLED_SITE_QUERY_ID = "00000000-0000-4000-8000-000000000000";

type SiteLifecycleTarget = {
	id: string;
	slug: string;
	name: string;
	action: "archive" | "restore";
};

type DeprovisionReceipt = {
	operationId: string;
	siteId: string;
	slug: string;
	name: string;
	status: "checking" | "queued" | "running" | "succeeded" | "failed";
	stage: string;
	deleted: string[];
	errors: string[];
};

const DEPROVISION_RECEIPT_KEY = "tedix:sites:last-deprovision";

function readDeprovisionReceipt(): DeprovisionReceipt | null {
	try {
		const value: unknown = JSON.parse(
			window.sessionStorage.getItem(DEPROVISION_RECEIPT_KEY) ?? "null",
		);
		if (!value || typeof value !== "object") return null;
		const receipt = value as Partial<DeprovisionReceipt>;
		if (
			typeof receipt.siteId !== "string" ||
			typeof receipt.slug !== "string" ||
			typeof receipt.name !== "string" ||
			typeof receipt.operationId !== "string" ||
			!["checking", "queued", "running", "succeeded", "failed"].includes(
				receipt.status ?? "",
			) ||
			!Array.isArray(receipt.deleted) ||
			typeof receipt.stage !== "string" ||
			!Array.isArray(receipt.errors)
		)
			return null;
		return receipt as DeprovisionReceipt;
	} catch {
		return null;
	}
}

function storeDeprovisionReceipt(receipt: DeprovisionReceipt | null) {
	try {
		if (receipt) {
			window.sessionStorage.setItem(
				DEPROVISION_RECEIPT_KEY,
				JSON.stringify(receipt),
			);
		} else {
			window.sessionStorage.removeItem(DEPROVISION_RECEIPT_KEY);
		}
	} catch {
		// Browser storage is optional; the current page can still poll the receipt.
	}
}

function CmsDomainManager({
	siteId,
	canConnect,
	legacyCustomDomain,
}: {
	siteId: string;
	canConnect: boolean;
	legacyCustomDomain: string | null;
}) {
	const queryClient = useQueryClient();
	const [hostname, setHostname] = useState("");
	const [removeTarget, setRemoveTarget] = useState<{
		claimId: string;
		hostname: string;
	} | null>(null);
	const domainOptions = osQuery.sites.getCmsDomain.queryOptions({
		input: { siteId },
	});
	const domain = useQuery(domainOptions);
	const claim = domain.data;
	const redirectOptions = osQuery.sites.getCmsDomain.queryOptions({
		input: { siteId, redirectToApex: true },
	});
	const activePrimary = claim?.status === "active";
	const redirect = useQuery({ ...redirectOptions, enabled: activePrimary });
	const redirectClaim = redirect.data;
	const showRedirect = activePrimary && (claim?.isZoneApex || !!redirectClaim);
	const hasLegacyDomain =
		domain.isSuccess && claim === null && Boolean(legacyCustomDomain);
	const refreshDomain = () => {
		void queryClient.invalidateQueries({ queryKey: domainOptions.queryKey });
		void queryClient.invalidateQueries({ queryKey: redirectOptions.queryKey });
		void queryClient.invalidateQueries(sitesQueryOptions());
	};
	const begin = useMutation({
		mutationFn: (nextHostname: string) =>
			osApi.sites.beginCmsDomain({ siteId, hostname: nextHostname }),
		onSuccess: (result) => {
			setHostname("");
			refreshDomain();
			toast.success(
				result.status === "active"
					? "Existing domain is ready to manage."
					: "Domain claim created. Add the DNS records below, then verify.",
			);
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Could not start domain setup",
			),
	});
	const beginRedirect = useMutation({
		mutationFn: (apexHostname: string) =>
			osApi.sites.beginCmsDomain({
				siteId,
				hostname: `www.${apexHostname}`,
				redirectToApex: true,
			}),
		onSuccess: () => {
			refreshDomain();
			toast.success("www claim created. Add its DNS records, then verify.");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Could not start www setup",
			),
	});
	const verify = useMutation({
		mutationFn: (claimId: string) =>
			osApi.sites.verifyCmsDomain({ siteId, claimId }),
		onSuccess: () => {
			refreshDomain();
			toast.success("Domain verification checked. Review the status below.");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Domain verification failed",
			),
	});
	const remove = useMutation({
		mutationFn: (claimId: string) =>
			osApi.sites.removeCmsDomain({ siteId, claimId }),
		onSuccess: () => {
			setRemoveTarget(null);
			refreshDomain();
			toast.success("Custom domain removal started.");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Could not remove domain",
			),
	});

	return (
		<Card className="mt-4">
			<CardHeader>
				<CardTitle>Custom domain</CardTitle>
				<CardDescription>
					{canConnect
						? "Connect a hostname you control to this CMS site. Add the DNS records before verifying ownership."
						: "Inspect the site's current custom-domain claim and remove it if needed."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{!canConnect ? (
					<Alert>
						<AlertTitle>Custom domains are unavailable on this plan</AlertTitle>
						<AlertDescription>
							You can still manage and remove an existing domain. Change the
							plan to connect or replace one.
						</AlertDescription>
					</Alert>
				) : null}
				{domain.isPending ? <ListSkeleton /> : null}
				{domain.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Domain status is unavailable</AlertTitle>
						<AlertDescription>
							{(domain.error as Error).message}
						</AlertDescription>
					</Alert>
				) : null}
				{claim ? (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-2">
							<Text role="body" className="font-medium">
								{claim.hostname}
							</Text>
							<Badge
								variant={claim.status === "active" ? "outline" : "warning"}
							>
								{claim.status}
							</Badge>
						</div>
						{claim.status === "pending" ? (
							<Text as="p" role="body" tone="secondary">
								Add the ownership TXT record and the hostname record at your DNS
								provider, then verify the domain.
							</Text>
						) : null}
						{claim.status === "provisioning" ? (
							<Text as="p" role="body" tone="secondary">
								Provisioning is in progress. Refresh status, or retry after five
								minutes if it does not finish.
							</Text>
						) : null}
						<Collection>
							<li className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)]">
								<Text role="caption" tone="secondary">
									TXT
								</Text>
								<div className="min-w-0">
									<Text as="p" role="body" className="m-0 break-all">
										{claim.txtName}
									</Text>
									<Text
										as="p"
										role="caption"
										tone="secondary"
										className="m-0 break-all"
									>
										{claim.txtValue}
									</Text>
								</div>
							</li>
							<li className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)]">
								<Text role="caption" tone="secondary">
									{claim.isZoneApex ? "Apex alias" : "CNAME"}
								</Text>
								<div className="min-w-0">
									<Text as="p" role="body" className="m-0 break-all">
										{claim.hostname}
									</Text>
									<Text
										as="p"
										role="caption"
										tone="secondary"
										className="m-0 break-all"
									>
										{claim.cnameTarget}
									</Text>
								</div>
							</li>
						</Collection>
						<Text as="p" role="caption" tone="secondary">
							{claim.isZoneApex
								? "At the root domain, use your provider's CNAME flattening or apex alias to point to this target. Once the apex and TLS certificate are active, set up www below."
								: "Verification completes after Cloudflare confirms the hostname and TLS certificate are active."}
						</Text>
						{claim.validationRecords.length ? (
							<div className="space-y-2">
								<Text as="p" role="body" className="font-medium">
									TLS validation records
								</Text>
								<Collection>
									{claim.validationRecords.map((record) => (
										<li
											key={`${record.name}:${record.value}`}
											className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)]"
										>
											<Text role="caption" tone="secondary">
												{record.type}
											</Text>
											<div className="min-w-0">
												<Text as="p" role="body" className="m-0 break-all">
													{record.name}
												</Text>
												<Text
													as="p"
													role="caption"
													tone="secondary"
													className="m-0 break-all"
												>
													{record.value}
												</Text>
											</div>
										</li>
									))}
								</Collection>
							</div>
						) : null}
						{claim.providerStatus || claim.sslStatus ? (
							<Text as="p" role="caption" tone="secondary">
								Provider: {claim.providerStatus ?? "unknown"} · SSL:{" "}
								{claim.sslStatus ?? "unknown"}
							</Text>
						) : null}
						<div className="flex flex-wrap gap-2">
							{canConnect &&
							(claim.status === "pending" ||
								claim.status === "provisioning") ? (
								<Button
									size="sm"
									disabled={verify.isPending}
									onClick={() => verify.mutate(claim.claimId)}
								>
									{verify.isPending
										? "Checking…"
										: claim.status === "provisioning"
											? "Retry provisioning"
											: "Verify domain"}
								</Button>
							) : null}
							<Button
								size="sm"
								variant="outline"
								onClick={() => void domain.refetch()}
							>
								Refresh status
							</Button>
							{claim.status !== "removing" ? (
								<Button
									size="sm"
									variant="destructive"
									onClick={() =>
										setRemoveTarget({
											claimId: claim.claimId,
											hostname: claim.hostname,
										})
									}
								>
									Remove domain
								</Button>
							) : null}
						</div>
						{showRedirect ? (
							<div className="space-y-3 border-t pt-4">
								<Text as="p" role="body" className="font-medium">
									www redirect to {claim.hostname}
								</Text>
								{redirect.isPending ? <ListSkeleton /> : null}
								{redirect.isError ? (
									<Alert variant="destructive">
										<AlertTitle>www status is unavailable</AlertTitle>
										<AlertDescription>
											{(redirect.error as Error).message}
										</AlertDescription>
									</Alert>
								) : null}
								{redirectClaim ? (
									<div className="space-y-3">
										<div className="flex flex-wrap items-center gap-2">
											<Text role="body" className="font-medium">
												{redirectClaim.hostname}
											</Text>
											<Badge
												variant={
													redirectClaim.status === "active"
														? "outline"
														: "warning"
												}
											>
												{redirectClaim.status}
											</Badge>
										</div>
										<Text as="p" role="body" tone="secondary">
											{redirectClaim.status === "active"
												? `HTTPS requests to ${redirectClaim.hostname} redirect to ${claim.hostname} with a 301, preserving the path and query.`
												: "Add the www DNS records and verify. The HTTPS 301 redirect starts after www and its TLS certificate are active."}
										</Text>
										<Collection>
											<li className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)]">
												<Text role="caption" tone="secondary">
													TXT
												</Text>
												<div className="min-w-0">
													<Text as="p" role="body" className="m-0 break-all">
														{redirectClaim.txtName}
													</Text>
													<Text
														as="p"
														role="caption"
														tone="secondary"
														className="m-0 break-all"
													>
														{redirectClaim.txtValue}
													</Text>
												</div>
											</li>
											<li className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)]">
												<Text role="caption" tone="secondary">
													CNAME
												</Text>
												<div className="min-w-0">
													<Text as="p" role="body" className="m-0 break-all">
														{redirectClaim.hostname}
													</Text>
													<Text
														as="p"
														role="caption"
														tone="secondary"
														className="m-0 break-all"
													>
														{redirectClaim.cnameTarget}
													</Text>
												</div>
											</li>
										</Collection>
										{redirectClaim.validationRecords.length ? (
											<div className="space-y-2">
												<Text as="p" role="body" className="font-medium">
													www TLS validation records
												</Text>
												<Collection>
													{redirectClaim.validationRecords.map((record) => (
														<li
															key={`${record.name}:${record.value}`}
															className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)]"
														>
															<Text role="caption" tone="secondary">
																{record.type}
															</Text>
															<div className="min-w-0">
																<Text
																	as="p"
																	role="body"
																	className="m-0 break-all"
																>
																	{record.name}
																</Text>
																<Text
																	as="p"
																	role="caption"
																	tone="secondary"
																	className="m-0 break-all"
																>
																	{record.value}
																</Text>
															</div>
														</li>
													))}
												</Collection>
											</div>
										) : null}
										<Text as="p" role="caption" tone="secondary">
											Provider: {redirectClaim.providerStatus ?? "unknown"} ·
											SSL: {redirectClaim.sslStatus ?? "unknown"}
										</Text>
										<div className="flex flex-wrap gap-2">
											{canConnect &&
											(redirectClaim.status === "pending" ||
												redirectClaim.status === "provisioning") ? (
												<Button
													size="sm"
													disabled={verify.isPending}
													onClick={() => verify.mutate(redirectClaim.claimId)}
												>
													{verify.isPending ? "Checking…" : "Verify www"}
												</Button>
											) : null}
											<Button
												size="sm"
												variant="outline"
												onClick={() => void redirect.refetch()}
											>
												Refresh www status
											</Button>
											{redirectClaim.status !== "removing" ? (
												<Button
													size="sm"
													variant="destructive"
													onClick={() =>
														setRemoveTarget({
															claimId: redirectClaim.claimId,
															hostname: redirectClaim.hostname,
														})
													}
												>
													Remove www redirect
												</Button>
											) : null}
										</div>
									</div>
								) : redirect.isSuccess ? (
									<div className="space-y-2">
										<Text as="p" role="body" tone="secondary">
											Connect www to redirect visitors to the root domain over
											HTTPS.
										</Text>
										{canConnect ? (
											<Button
												size="sm"
												disabled={beginRedirect.isPending}
												onClick={() => beginRedirect.mutate(claim.hostname)}
											>
												{beginRedirect.isPending
													? "Starting…"
													: "Connect www redirect"}
											</Button>
										) : null}
									</div>
								) : null}
							</div>
						) : null}
					</div>
				) : hasLegacyDomain ? (
					<Alert>
						<AlertTitle>Existing domain: {legacyCustomDomain}</AlertTitle>
						<AlertDescription>
							Bring this domain into the managed flow to inspect its claim, then
							remove or replace it. Your current site remains available.
						</AlertDescription>
						<Button
							size="sm"
							disabled={begin.isPending}
							onClick={() => {
								if (legacyCustomDomain) begin.mutate(legacyCustomDomain);
							}}
						>
							{begin.isPending ? "Preparing…" : "Manage existing domain"}
						</Button>
					</Alert>
				) : domain.isSuccess ? (
					<Text as="p" role="body" tone="secondary">
						No custom domain is connected.
					</Text>
				) : null}
				{canConnect && domain.isSuccess && !hasLegacyDomain ? (
					<form
						className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
						onSubmit={(event) => {
							event.preventDefault();
							begin.mutate(hostname.trim().toLowerCase());
						}}
					>
						<div className="grid gap-2">
							<Label htmlFor={`cms-domain-${siteId}`}>
								{claim ? "Replace with another hostname" : "Hostname"}
							</Label>
							<Input
								id={`cms-domain-${siteId}`}
								aria-label={claim ? "Replacement hostname" : "Hostname"}
								value={hostname}
								required
								maxLength={253}
								placeholder="example.com"
								pattern="(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}"
								onChange={(event) => setHostname(event.target.value)}
							/>
						</div>
						<Button
							type="submit"
							size="sm"
							disabled={
								begin.isPending ||
								!hostname.trim() ||
								claim?.status === "removing"
							}
						>
							{begin.isPending
								? "Starting…"
								: claim
									? "Replace domain"
									: "Connect domain"}
						</Button>
					</form>
				) : null}
				<AlertDialog
					open={removeTarget !== null}
					onOpenChange={(open) => {
						if (!open && !remove.isPending) setRemoveTarget(null);
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								Remove {removeTarget?.hostname}?
							</AlertDialogTitle>
							<AlertDialogDescription>
								{removeTarget?.hostname === claim?.hostname
									? "When removal finishes, the site's Tedix hostname becomes canonical. Update your DNS afterward."
									: "When removal finishes, www stops redirecting. Update your DNS afterward."}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={remove.isPending}>
								Cancel
							</AlertDialogCancel>
							<Button
								variant="destructive"
								disabled={!removeTarget || remove.isPending}
								onClick={() => {
									if (removeTarget) remove.mutate(removeTarget.claimId);
								}}
							>
								{remove.isPending ? "Removing…" : "Remove domain"}
							</Button>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</CardContent>
		</Card>
	);
}

export function SitesPage() {
	const surface = getOsSurface("sites");
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
	const [newSiteName, setNewSiteName] = useState("");
	const [newSiteSlug, setNewSiteSlug] = useState("");
	const [newSiteTemplate, setNewSiteTemplate] =
		useState<CmsTemplateSlug>("native-marketing");
	const [createOpen, setCreateOpen] = useState(false);
	const [siteSearch, setSiteSearch] = useState("");
	const [siteType, setSiteType] = useState<"all" | "cms" | "docs">("all");
	const createCmsSite = useMutation({
		mutationFn: (input: {
			name: string;
			slug: string;
			templateSlug: CmsTemplateSlug;
		}) => osApi.sites.createCms(input),
		onSuccess: (result) => {
			setNewSiteName("");
			setNewSiteSlug("");
			setCreateOpen(false);
			void queryClient.invalidateQueries(sitesQueryOptions());
			void queryClient.invalidateQueries(sitesReconciliationQueryOptions());
			toast.success(
				`${result.slug} is ready for authoring. Deploy a theme to publish it.`,
			);
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "CMS site creation failed",
			),
	});
	const [selectedSite, setSelectedSite] = useState<{
		id: string;
		slug: string;
		name: string;
		type: "cms" | "docs";
		customDomain: string | null;
	} | null>(null);
	const selectedSiteDetails = sites.data?.sites.find(
		(site) => site.id === selectedSite?.id,
	);
	const filteredSites = sites.data?.sites.filter((site) => {
		if (siteType !== "all" && site.type !== siteType) return false;
		const query = siteSearch.trim().toLowerCase();
		return (
			!query ||
			[site.name, site.slug, site.url, site.customDomain]
				.filter((value): value is string => Boolean(value))
				.some((value) => value.toLowerCase().includes(query))
		);
	});
	const [deprovisionOpen, setDeprovisionOpen] = useState(false);
	const [lastDeprovision, setLastDeprovision] = useState(
		readDeprovisionReceipt,
	);
	const [lifecycleTarget, setLifecycleTarget] =
		useState<SiteLifecycleTarget | null>(null);
	const docsWorkspace = useQuery({
		...docsSiteWorkspaceQueryOptions(
			selectedSite?.id ?? DISABLED_SITE_QUERY_ID,
		),
		enabled: selectedSite?.type === "docs",
	});
	const deprovisionPlan = useQuery({
		...siteDeprovisionPlanQueryOptions(
			selectedSite?.id ?? DISABLED_SITE_QUERY_ID,
		),
		enabled: selectedSite?.type === "cms",
	});
	const deprovisionStatus = useQuery({
		...siteDeprovisionStatusQueryOptions(
			lastDeprovision?.siteId ?? DISABLED_SITE_QUERY_ID,
		),
		enabled: lastDeprovision !== null,
		refetchInterval: (query) => {
			const current = query.state.data;
			return !current ||
				current.operationId !== lastDeprovision?.operationId ||
				["queued", "running"].includes(current.status)
				? 3_000
				: false;
		},
	});
	const receipt =
		lastDeprovision &&
		deprovisionStatus.data &&
		(!lastDeprovision.operationId ||
			deprovisionStatus.data.operationId === lastDeprovision.operationId)
			? { ...deprovisionStatus.data, name: lastDeprovision.name }
			: lastDeprovision;
	useEffect(() => {
		if (
			!lastDeprovision ||
			lastDeprovision.operationId ||
			!deprovisionStatus.data
		)
			return;
		const resolved = { ...deprovisionStatus.data, name: lastDeprovision.name };
		storeDeprovisionReceipt(resolved);
		setLastDeprovision(resolved);
	}, [lastDeprovision, deprovisionStatus.data]);
	const lastTerminalReceipt = useRef("");
	useEffect(() => {
		if (!receipt || !["succeeded", "failed"].includes(receipt.status)) return;
		const terminalKey = `${receipt.operationId}:${receipt.status}`;
		if (lastTerminalReceipt.current === terminalKey) return;
		lastTerminalReceipt.current = terminalKey;
		storeDeprovisionReceipt(receipt);
		void queryClient.invalidateQueries(sitesQueryOptions());
		void queryClient.invalidateQueries(sitesReconciliationQueryOptions());
		if (receipt.status === "failed") {
			void queryClient.invalidateQueries(
				siteDeprovisionPlanQueryOptions(receipt.siteId),
			);
		}
	}, [receipt, queryClient]);
	const [manifest, setManifest] = useState<{
		slug: string;
		type: "cms" | "docs";
		recoverable: boolean;
		blockers: string[];
		resources: Array<{
			kind: string;
			state: string;
			identifier: string;
			requiredForRecovery: boolean;
		}>;
		recoveryPoints: Array<{ id: string; label: string; active: boolean }>;
	} | null>(null);
	const lifecycle = useMutation({
		mutationFn: ({
			siteId,
			action,
			confirmation,
		}: {
			siteId: string;
			action: "archive" | "restore";
			confirmation: string;
		}) =>
			osApi.sites.setLifecycle({
				siteId,
				action,
				confirmation,
			}),
		onSuccess: (result) => {
			setLifecycleTarget(null);
			void queryClient.invalidateQueries(sitesQueryOptions());
			void queryClient.invalidateQueries(sitesReconciliationQueryOptions());
			toast.success(
				`${result.slug} was ${result.status === "active" ? "restored" : "archived"}`,
			);
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Site lifecycle update failed",
			),
	});
	const runReconciliation = useMutation({
		mutationFn: () => osApi.sites.runReconciliation({}),
		onSuccess: () => {
			void queryClient.invalidateQueries(sitesReconciliationQueryOptions());
			toast.success("Site reconciliation completed");
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Site reconciliation failed",
			),
	});
	const startDocsBuild = useMutation({
		mutationFn: (siteId: string) => osApi.docs.startBuild({ siteId }),
		onSuccess: (result) => {
			if (selectedSite)
				void queryClient.invalidateQueries(
					docsSiteWorkspaceQueryOptions(selectedSite.id),
				);
			toast.success(
				`Documentation preview build ${result.build.id.slice(0, 8)} started`,
			);
		},
		onError: (error) =>
			toast.error(error instanceof Error ? error.message : "Build failed"),
	});
	const publishDocsBuild = useMutation({
		mutationFn: (input: {
			siteId: string;
			buildId: string;
			rollback: boolean;
		}) =>
			input.rollback
				? osApi.docs.rollbackBuild(input)
				: osApi.docs.publishBuild(input),
		onSuccess: (_result, input) => {
			void queryClient.invalidateQueries(
				docsSiteWorkspaceQueryOptions(input.siteId),
			);
			void queryClient.invalidateQueries(sitesQueryOptions());
			toast.success(
				input.rollback
					? "Documentation release rolled back"
					: "Documentation build published",
			);
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : "Release action failed",
			),
	});
	const deprovision = useMutation({
		mutationFn: ({
			siteId,
			confirmation,
		}: {
			siteId: string;
			confirmation: string;
			name: string;
		}) => osSiteDeprovisionApi.sites.deprovision({ siteId, confirmation }),
		onSuccess: (result, variables) => {
			const nextReceipt = { ...result, name: variables.name };
			storeDeprovisionReceipt(nextReceipt);
			setLastDeprovision(nextReceipt);
			setSelectedSite(null);
			setDeprovisionOpen(false);
			toast.success(`Cleanup started for ${result.slug}`);
		},
		onError: (error, variables) => {
			if (error instanceof Error && /timed out/i.test(error.message)) {
				queryClient.removeQueries({
					queryKey: siteDeprovisionStatusQueryOptions(variables.siteId)
						.queryKey,
				});
				const checkingReceipt: DeprovisionReceipt = {
					operationId: "",
					siteId: variables.siteId,
					slug: variables.confirmation,
					name: variables.name,
					status: "checking",
					stage: "Checking request",
					deleted: [],
					errors: [],
				};
				storeDeprovisionReceipt(checkingReceipt);
				setLastDeprovision(checkingReceipt);
				setDeprovisionOpen(false);
			}
			toast.error(
				error instanceof Error && /timed out/i.test(error.message)
					? "Cleanup request timed out before a receipt arrived. Checking its status now."
					: error instanceof Error
						? error.message
						: "Deprovision failed",
			);
		},
	});
	const deprovisionForm = useZodForm({
		schema: exactConfirmationSchema(selectedSite?.slug ?? "", "Site slug"),
		defaultValues: { confirmation: "" },
		onSubmit: ({ value }) => {
			if (!selectedSite) return;
			deprovision.mutate({
				siteId: selectedSite.id,
				confirmation: value.confirmation,
				name: selectedSite.name,
			});
		},
	});
	const lifecycleForm = useZodForm({
		schema: exactConfirmationSchema(lifecycleTarget?.slug ?? "", "Site slug"),
		defaultValues: { confirmation: "" },
		onSubmit: ({ value }) => {
			if (!lifecycleTarget) return;
			lifecycle.mutate({
				siteId: lifecycleTarget.id,
				action: lifecycleTarget.action,
				confirmation: value.confirmation,
			});
		},
	});
	const requestLifecycleChange = (site: {
		id: string;
		slug: string;
		name: string;
		status: string;
	}) => {
		if (site.status === "provisioning") return;
		const action = site.status === "active" ? "archive" : "restore";
		lifecycleForm.reset();
		setLifecycleTarget({
			id: site.id,
			slug: site.slug,
			name: site.name,
			action,
		});
	};
	const handleLifecycleOpenChange = (open: boolean) => {
		if (open || lifecycle.isPending) return;
		lifecycleForm.reset();
		setLifecycleTarget(null);
	};
	const inspectRecovery = async (siteId: string) => {
		try {
			setManifest(
				await queryClient.fetchQuery(siteRecoveryManifestQueryOptions(siteId)),
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Recovery manifest unavailable",
			);
		}
	};
	const manageSite = (
		site: NonNullable<typeof sites.data>["sites"][number],
	) => {
		setCreateOpen(false);
		setSelectedSite({
			id: site.id,
			slug: site.slug,
			name: site.name,
			type: site.type,
			customDomain: site.customDomain,
		});
	};
	const siteActions = (
		site: NonNullable<typeof sites.data>["sites"][number],
	) => (
		<div
			className="flex items-center justify-end gap-1.5"
			role="group"
			aria-label={`Actions for ${site.name}`}
		>
			<Button size="sm" variant="outline" onClick={() => manageSite(site)}>
				Manage
			</Button>
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
					<DotsThree size={16} weight="bold" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => manageSite(site)}>
						Manage site
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() =>
							window.open(site.url, "_blank", "noopener,noreferrer")
						}
					>
						Open public site
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => void inspectRecovery(site.id)}>
						Recovery details
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant={site.status === "active" ? "destructive" : "default"}
						disabled={lifecycle.isPending || site.status === "provisioning"}
						onClick={() => requestLifecycleChange(site)}
					>
						{site.status === "active"
							? "Archive site"
							: site.status === "paused"
								? "Restore site"
								: "Provisioning"}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);

	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					{selectedSite ? (
						<PageBack onClick={() => setSelectedSite(null)}>All sites</PageBack>
					) : null}
					<PageTitle>{selectedSite?.name ?? surface.label}</PageTitle>
					<PageDescription>
						{selectedSite
							? (selectedSiteDetails?.url ??
								`Manage this ${selectedSite.type === "cms" ? "CMS" : "documentation"} site.`)
							: "Create and manage your organization's CMS and documentation sites."}
					</PageDescription>
				</PageHeading>
				<PageActions>
					{selectedSite ? (
						<Button
							variant="outline"
							onClick={() =>
								window.open(
									selectedSiteDetails?.url,
									"_blank",
									"noopener,noreferrer",
								)
							}
							disabled={!selectedSiteDetails?.url}
						>
							Open site
						</Button>
					) : canCreateCmsSite ? (
						<Button
							variant={createOpen ? "outline" : "default"}
							onClick={() => setCreateOpen((open) => !open)}
							disabled={cmsSiteLimitReached}
							aria-expanded={createOpen}
							aria-controls="create-cms-site"
						>
							{createOpen ? null : <Plus size={16} aria-hidden />}
							{createOpen ? "Close form" : "Create CMS site"}
						</Button>
					) : null}
				</PageActions>
			</PageHeader>
			{!selectedSite && canCreateCmsSite && createOpen ? (
				<PageSection id="create-cms-site">
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Create CMS site</SectionTitle>
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
							createCmsSite.mutate({
								name: newSiteName.trim(),
								slug: newSiteSlug.trim(),
								templateSlug: newSiteTemplate,
							});
						}}
					>
						<div className="grid gap-2">
							<Label htmlFor="new-cms-name">Name</Label>
							<Input
								id="new-cms-name"
								value={newSiteName}
								maxLength={100}
								required
								onChange={(event) => setNewSiteName(event.target.value)}
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="new-cms-slug">Slug</Label>
							<Input
								id="new-cms-slug"
								value={newSiteSlug}
								maxLength={63}
								pattern="[a-z0-9]+(-[a-z0-9]+)*"
								required
								onChange={(event) => setNewSiteSlug(event.target.value)}
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="new-cms-template">Starter template</Label>
							<Select
								value={newSiteTemplate}
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
									!newSiteName.trim() ||
									!newSiteSlug.trim()
								}
							>
								{createCmsSite.isPending ? "Creating…" : "Create CMS site"}
							</Button>
						</div>
					</form>
				</PageSection>
			) : null}
			{!selectedSite ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Your sites</SectionTitle>
							<SectionDescription>
								Select a site to manage its domain, releases, and lifecycle.
							</SectionDescription>
						</SectionHeading>
						{cmsSiteQuota ? (
							<Badge variant="outline">
								{cmsSiteQuota.used} /{" "}
								{cmsSiteQuota.limit === -1 ? "∞" : cmsSiteQuota.limit} CMS sites
							</Badge>
						) : null}
					</SectionHeader>
					{sites.data ? (
						<PageToolbar>
							<SearchInput
								aria-label="Search sites"
								placeholder="Search by site or domain"
								value={siteSearch}
								onChange={(event) => setSiteSearch(event.target.value)}
								containerClassName="w-full lg:max-w-md"
								trailing={
									<span className="whitespace-nowrap text-kumo-subtle type-tedix-label">
										{filteredSites?.length ?? 0} results
									</span>
								}
							/>
							<Select
								value={siteType}
								onValueChange={(value) =>
									setSiteType(value as "all" | "cms" | "docs")
								}
							>
								<SelectTrigger
									aria-label="Filter site type"
									className="w-full lg:w-44"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">All sites</SelectItem>
									<SelectItem value="cms">CMS websites</SelectItem>
									<SelectItem value="docs">Documentation</SelectItem>
								</SelectContent>
							</Select>
						</PageToolbar>
					) : null}
					{sites.isPending ? <ListSkeleton /> : null}
					{sites.isError ? (
						<Alert variant="destructive">
							<AlertTitle>Sites are unavailable</AlertTitle>
							<AlertDescription>
								{(sites.error as Error).message}
							</AlertDescription>
						</Alert>
					) : null}
					{sites.data?.sites.length === 0 ? (
						<Empty
							appearance="quiet"
							title="No sites yet"
							description="Create a CMS site to start publishing a website. Documentation sites appear here after they are created."
							contents={
								canCreateCmsSite && !cmsSiteLimitReached ? (
									<Button onClick={() => setCreateOpen(true)}>
										<Plus size={16} aria-hidden /> Create CMS site
									</Button>
								) : null
							}
						/>
					) : null}
					{sites.data?.sites.length && filteredSites?.length === 0 ? (
						<Empty
							appearance="quiet"
							title="No matching sites"
							description="Try another name or domain, or show all site types."
							contents={
								<Button
									variant="outline"
									onClick={() => {
										setSiteSearch("");
										setSiteType("all");
									}}
								>
									Clear filters
								</Button>
							}
						/>
					) : null}
					{filteredSites?.length ? (
						<>
							<div className="hidden overflow-hidden rounded-xl border border-kumo-line sm:block">
								<Table scrollLabel="Owned sites">
									<TableHeader>
										<TableRow>
											<TableHead>Site</TableHead>
											<TableHead>Type</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Domain</TableHead>
											<TableHead>Release</TableHead>
											<TableHead className="text-right">Actions</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{filteredSites.map((site) => (
											<TableRow key={site.id}>
												<TableCell className="min-w-56">
													<div className="flex min-w-0 items-center gap-3">
														<IconFrame aria-hidden>
															{site.type === "docs" ? (
																<FileText size={18} />
															) : (
																<Globe size={18} />
															)}
														</IconFrame>
														<div className="min-w-0">
															<Button
																size="sm"
																variant="link"
																className="h-auto justify-start px-0 text-kumo-strong"
																onClick={() => manageSite(site)}
															>
																{site.name}
															</Button>
															<Text
																as="p"
																role="caption"
																tone="secondary"
																className="m-0 truncate"
															>
																{site.url}
															</Text>
														</div>
													</div>
												</TableCell>
												<TableCell>
													{site.type === "docs" ? "Docs" : "CMS"}
												</TableCell>
												<TableCell>
													<Badge
														variant={
															site.status === "active"
																? "success"
																: site.status === "provisioning"
																	? "warning"
																	: "secondary"
														}
													>
														{site.status}
													</Badge>
												</TableCell>
												<TableCell className="max-w-48 truncate">
													{site.customDomain ?? "Tedix hostname"}
												</TableCell>
												<TableCell>
													{site.activeRevisionId
														? site.type === "cms"
															? `Bundle v${site.activeRevisionId}`
															: "Published"
														: "Not published"}
												</TableCell>
												<TableCell>{siteActions(site)}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
							<Collection className="sm:hidden">
								{filteredSites.map((site) => (
									<li key={site.id} className="space-y-3 px-3 py-3">
										<div className="flex min-w-0 items-start gap-3">
											<IconFrame aria-hidden>
												{site.type === "docs" ? (
													<FileText size={18} />
												) : (
													<Globe size={18} />
												)}
											</IconFrame>
											<div className="min-w-0 flex-1">
												<Text role="body" className="m-0 font-medium">
													{site.name}
												</Text>
												<Text
													as="p"
													role="caption"
													tone="secondary"
													className="m-0 truncate"
												>
													{site.url}
												</Text>
											</div>
											<Badge
												variant={
													site.status === "active"
														? "success"
														: site.status === "provisioning"
															? "warning"
															: "secondary"
												}
											>
												{site.status}
											</Badge>
										</div>
										<div className="flex items-center justify-between gap-2">
											<Text
												role="caption"
												tone="secondary"
												className="truncate"
											>
												{site.type === "docs" ? "Docs" : "CMS"} ·{" "}
												{siteMetadata(site) || "Not published"}
											</Text>
											{siteActions(site)}
										</div>
									</li>
								))}
							</Collection>
						</>
					) : null}
				</PageSection>
			) : null}
			{!selectedSite && receipt ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Cleanup — {receipt.name}</SectionTitle>
							<SectionDescription>
								{receipt.operationId
									? `Operation ${receipt.operationId}. This receipt remains available after the site record is removed.`
									: "Checking whether the cleanup request started. This status remains available after a reload."}
							</SectionDescription>
						</SectionHeading>
						<Badge
							variant={
								receipt.status === "failed"
									? "destructive"
									: receipt.status === "succeeded"
										? "outline"
										: "warning"
							}
						>
							{receipt.status}
						</Badge>
						{receipt.status === "succeeded" || receipt.status === "failed" ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									storeDeprovisionReceipt(null);
									setLastDeprovision(null);
								}}
							>
								Dismiss
							</Button>
						) : null}
					</SectionHeader>
					{deprovisionStatus.isError ? (
						<Alert variant="destructive">
							<AlertTitle>Cleanup status is unavailable</AlertTitle>
							<AlertDescription>
								{(deprovisionStatus.error as Error).message}
							</AlertDescription>
						</Alert>
					) : null}
					{receipt.status === "checking" ? (
						<Text as="p" role="body" tone="secondary">
							The request did not return a receipt. Checking the server before
							another attempt.
						</Text>
					) : null}
					{receipt.status === "queued" || receipt.status === "running" ? (
						<Text as="p" role="body" tone="secondary">
							{receipt.stage}. This page checks for the final result
							automatically.
						</Text>
					) : null}
					{receipt.status === "succeeded" ? (
						<Text as="p" role="body">
							{receipt.slug} was deprovisioned. {receipt.deleted.length}{" "}
							resource(s) removed.
						</Text>
					) : null}
					{receipt.status === "failed" ? (
						<Alert variant="destructive">
							<AlertTitle>Cleanup needs attention</AlertTitle>
							<AlertDescription>
								{receipt.errors.join("; ") || "No failure detail was returned."}
							</AlertDescription>
						</Alert>
					) : null}
					{receipt.deleted.length ? (
						<Text as="p" role="caption" tone="secondary">
							Removed: {receipt.deleted.join(", ")}
						</Text>
					) : null}
				</PageSection>
			) : null}
			{selectedSite ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Overview</SectionTitle>
							<SectionDescription>
								{selectedSite.type === "docs"
									? "Build previews, publish validated documentation builds, or roll back to an immutable release."
									: "Manage the domain and deployment for this CMS site."}
							</SectionDescription>
						</SectionHeading>
						{selectedSiteDetails ? (
							<Badge
								variant={
									selectedSiteDetails.status === "active"
										? "success"
										: "warning"
								}
							>
								{selectedSiteDetails.status}
							</Badge>
						) : null}
					</SectionHeader>
					{selectedSiteDetails ? (
						<div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-kumo-hairline pb-4 text-kumo-subtle type-tedix-body">
							<span>
								{selectedSite.type === "cms"
									? "CMS website"
									: "Documentation site"}
							</span>
							<span>
								{selectedSiteDetails.customDomain ?? "Tedix hostname"}
							</span>
							<span>
								{siteMetadata(selectedSiteDetails) || "Not published"}
							</span>
						</div>
					) : null}
					{selectedSite.type === "docs" ? (
						<>
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									disabled={startDocsBuild.isPending}
									onClick={() => startDocsBuild.mutate(selectedSite.id)}
								>
									{startDocsBuild.isPending ? "Starting…" : "Build preview"}
								</Button>
							</div>
							{docsWorkspace.isPending ? <ListSkeleton /> : null}
							{docsWorkspace.data?.builds.length ? (
								<Collection>
									{docsWorkspace.data.builds.map((build) => {
										const active =
											docsWorkspace.data.site.activeBuildId === build.id;
										return (
											<li
												key={build.id}
												className="flex items-center justify-between gap-3 px-3 py-2.5"
											>
												<div className="min-w-0">
													<Text role="body" className="m-0 font-medium">
														Build {build.id.slice(0, 8)}
													</Text>
													<Text
														as="p"
														role="caption"
														tone="secondary"
														className="m-0"
													>
														{build.status} ·{" "}
														{new Date(build.createdAt).toLocaleString()}
													</Text>
												</div>
												<div className="flex items-center gap-2">
													{active ? (
														<Badge variant="outline">Live</Badge>
													) : null}
													{build.status === "complete" && !active ? (
														<Button
															size="sm"
															variant="outline"
															disabled={publishDocsBuild.isPending}
															onClick={() =>
																publishDocsBuild.mutate({
																	siteId: selectedSite.id,
																	buildId: build.id,
																	rollback: docsWorkspace.data.releases.some(
																		(release) => release.buildId === build.id,
																	),
																})
															}
														>
															{docsWorkspace.data.releases.some(
																(release) => release.buildId === build.id,
															)
																? "Roll back"
																: "Publish"}
														</Button>
													) : null}
												</div>
											</li>
										);
									})}
								</Collection>
							) : docsWorkspace.isSuccess ? (
								<Text as="p" role="body" tone="secondary">
									No documentation builds yet.
								</Text>
							) : null}
						</>
					) : (
						<>
							{canCreateCmsSite &&
							sites.data?.cmsCustomDomainsEnabled !== undefined ? (
								<CmsDomainManager
									siteId={selectedSite.id}
									canConnect={sites.data?.cmsCustomDomainsEnabled === true}
									legacyCustomDomain={selectedSite.customDomain}
								/>
							) : null}
							{deprovisionPlan.isPending ? <ListSkeleton /> : null}
							{deprovisionPlan.data ? (
								<Collection className="mt-4">
									{deprovisionPlan.data.dependencies.map((dependency) => (
										<li
											key={`${dependency.kind}:${dependency.detail}`}
											className="flex items-start justify-between gap-4 px-4 py-3"
										>
											<div className="min-w-0">
												<Text role="body" className="m-0 font-medium">
													{dependency.kind.replaceAll("_", " ")}
												</Text>
												<Text
													as="p"
													role="caption"
													tone="secondary"
													className="m-0"
												>
													{dependency.detail}
												</Text>
											</div>
											<Badge
												variant={
													dependency.status === "unknown"
														? "warning"
														: "outline"
												}
												className="mt-0.5 shrink-0"
											>
												{dependency.status}
											</Badge>
										</li>
									))}
								</Collection>
							) : null}
							<div className="flex justify-end pt-3">
								<Button
									size="sm"
									variant="destructive"
									onClick={() => setDeprovisionOpen(true)}
								>
									<Trash size={16} /> Deprovision
								</Button>
							</div>
						</>
					)}
				</PageSection>
			) : null}
			{!selectedSite && manifest ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Recovery — {manifest.slug}</SectionTitle>
							<SectionDescription>
								{manifest.recoverable
									? `${manifest.recoveryPoints.length} recovery point(s) available.`
									: manifest.blockers.join("; ")}
							</SectionDescription>
						</SectionHeading>
						<Badge variant={manifest.recoverable ? "outline" : "destructive"}>
							{manifest.recoverable ? "Ready" : "Blocked"}
						</Badge>
					</SectionHeader>
					<Collection>
						{manifest.resources.map((resource) => (
							<li
								key={`${resource.kind}:${resource.identifier}`}
								className="flex items-center justify-between gap-3 px-3 py-2.5"
							>
								<div className="min-w-0">
									<Text role="body" className="m-0 font-medium">
										{resource.kind.replaceAll("_", " ")}
									</Text>
									<Text
										as="p"
										role="caption"
										tone="secondary"
										className="m-0 truncate"
									>
										{resource.identifier}
									</Text>
								</div>
								<Badge
									variant={
										resource.state === "missing" ? "destructive" : "outline"
									}
								>
									{resource.state}
								</Badge>
							</li>
						))}
					</Collection>
				</PageSection>
			) : null}
			{!selectedSite ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Reconciliation</SectionTitle>
							<SectionDescription>
								Read-only checks for missing releases, proxies, and conflicting
								domains. No resources are deleted automatically.
							</SectionDescription>
						</SectionHeading>
						{reconciliation.data ? (
							<Badge
								variant={
									reconciliation.data.issues.length ? "destructive" : "outline"
								}
							>
								{reconciliation.data.issues.length} issue(s)
							</Badge>
						) : null}
						<Button
							size="sm"
							variant="outline"
							disabled={runReconciliation.isPending}
							onClick={() => runReconciliation.mutate()}
						>
							{runReconciliation.isPending ? "Checking…" : "Run now"}
						</Button>
					</SectionHeader>
					{reconciliation.data ? (
						<Text as="p" role="caption" tone="secondary">
							Last checked{" "}
							{new Date(reconciliation.data.checkedAt).toLocaleString()} by{" "}
							{reconciliation.data.source} run.
						</Text>
					) : (
						<Text as="p" role="body" tone="secondary">
							No reconciliation has run yet.
						</Text>
					)}
					{reconciliation.data?.issues.length === 0 ? (
						<Text as="p" role="body" tone="secondary">
							All {reconciliation.data.sitesChecked} owned sites are consistent.
						</Text>
					) : null}
					{reconciliation.data?.issues.length ? (
						<Collection>
							{reconciliation.data.issues.map((issue) => (
								<li
									key={`${issue.siteId}:${issue.code}`}
									className="flex items-center justify-between gap-3 px-3 py-2.5"
								>
									<div>
										<Text role="body" className="m-0 font-medium">
											{issue.slug}: {issue.code.replaceAll("_", " ")}
										</Text>
										<Text
											as="p"
											role="caption"
											tone="secondary"
											className="m-0"
										>
											{issue.detail}
										</Text>
									</div>
									<Badge
										variant={
											issue.severity === "error" ? "destructive" : "outline"
										}
									>
										{issue.severity}
									</Badge>
								</li>
							))}
						</Collection>
					) : null}
				</PageSection>
			) : null}
			<AlertDialog
				open={lifecycleTarget !== null}
				onOpenChange={handleLifecycleOpenChange}
			>
				<AlertDialogContent className="gap-4">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{lifecycleTarget?.action === "archive" ? "Archive" : "Restore"}{" "}
							{lifecycleTarget?.name}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{lifecycleTarget?.action === "archive"
								? "Archiving removes the site from public service while retaining its recoverable deployment state."
								: "Restoring returns the retained site deployment to active service."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							void lifecycleForm.handleSubmit();
						}}
					>
						<FormField
							form={lifecycleForm}
							name="confirmation"
							label={`Type ${lifecycleTarget?.slug ?? "the site slug"} to confirm`}
						>
							{(field, meta) => (
								<FormInput field={field} {...meta} autoComplete="off" />
							)}
						</FormField>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={lifecycle.isPending}>
								Cancel
							</AlertDialogCancel>
							<lifecycleForm.Subscribe selector={(state) => state.canSubmit}>
								{(canSubmit) => (
									<Button
										type="submit"
										variant={
											lifecycleTarget?.action === "archive"
												? "destructive"
												: "default"
										}
										disabled={!canSubmit || lifecycle.isPending}
									>
										{lifecycle.isPending
											? "Updating…"
											: lifecycleTarget?.action === "archive"
												? "Archive site"
												: "Restore site"}
									</Button>
								)}
							</lifecycleForm.Subscribe>
						</AlertDialogFooter>
					</form>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				open={deprovisionOpen}
				onOpenChange={(open) => {
					if (!open && deprovision.isPending) return;
					setDeprovisionOpen(open);
					if (!open) deprovisionForm.reset();
				}}
			>
				<AlertDialogContent className="gap-4">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Deprovision {selectedSite?.name}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently removes the Emdash deployment database, media,
							bundles, sandbox, authoring proxy, and site record. Connected
							branded MCP apps are retained.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							void deprovisionForm.handleSubmit();
						}}
					>
						<FormField
							form={deprovisionForm}
							name="confirmation"
							label={`Type ${selectedSite?.slug ?? "the site slug"} to confirm`}
						>
							{(field, meta) => (
								<FormInput field={field} {...meta} autoComplete="off" />
							)}
						</FormField>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={deprovision.isPending}>
								Cancel
							</AlertDialogCancel>
							<deprovisionForm.Subscribe selector={(state) => state.canSubmit}>
								{(canSubmit) => (
									<Button
										type="submit"
										variant="destructive"
										disabled={
											!selectedSite || !canSubmit || deprovision.isPending
										}
									>
										{deprovision.isPending
											? "Starting cleanup…"
											: "Deprovision permanently"}
									</Button>
								)}
							</deprovisionForm.Subscribe>
						</AlertDialogFooter>
					</form>
				</AlertDialogContent>
			</AlertDialog>
		</Page>
	);
}
