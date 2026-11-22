import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	Alert,
	AlertTitle,
	AlertDescription,
	LoadError,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
} from "@/components/kumo/card";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Collection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { ListSkeleton } from "@/components/list-skeleton";
import { osApi } from "@/lib/api";
import { humanize } from "@/lib/format";
import { osQuery, sitesQueryOptions } from "@/lib/os-query-options";

type DomainClaim = NonNullable<
	Awaited<ReturnType<typeof osApi.sites.getCmsDomain>>
>;

function DnsRecordRow({
	kind,
	name,
	value,
}: {
	kind: string;
	name: string;
	value: string;
}) {
	return (
		<li className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)]">
			<Text role="caption" tone="secondary">
				{kind}
			</Text>
			<div className="min-w-0">
				<ClipboardText text={name} />
				<ClipboardText text={value} />
			</div>
		</li>
	);
}

function DomainClaimPanel({
	claim,
	redirectTo,
	canConnect,
	verifying,
	onVerify,
	onRefresh,
	onRemove,
}: {
	claim: DomainClaim;
	redirectTo?: string;
	canConnect: boolean;
	verifying: boolean;
	onVerify: (claimId: string) => void;
	onRefresh: () => void;
	onRemove: (target: { claimId: string; hostname: string }) => void;
}) {
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<Text role="body" className="font-medium">
					{claim.hostname}
				</Text>
				<Badge variant={claim.status === "active" ? "outline" : "warning"}>
					{claim.status === "active"
						? "Working"
						: claim.status === "pending"
							? "Waiting for DNS: add these records"
							: claim.status === "provisioning"
								? "Setting up secure access"
								: "Removing domain"}
				</Badge>
			</div>
			{redirectTo ? (
				<Text as="p" role="body" tone="secondary">
					{claim.status === "active"
						? `HTTPS requests to ${claim.hostname} redirect to ${redirectTo} with a 301, preserving the path and query.`
						: "Add the www DNS records and verify. The HTTPS 301 redirect starts after www and its TLS certificate are active."}
				</Text>
			) : claim.status === "pending" ? (
				<Text as="p" role="body" tone="secondary">
					Add the ownership TXT record and the hostname record at your DNS
					provider, then verify the domain.
				</Text>
			) : null}
			{!redirectTo && claim.status === "provisioning" ? (
				<Text as="p" role="body" tone="secondary">
					Provisioning is in progress. Refresh status, or retry after five
					minutes if it does not finish.
				</Text>
			) : null}
			{claim.status !== "active" ? (
				<Collection>
					<DnsRecordRow
						kind="TXT"
						name={claim.txtName}
						value={claim.txtValue}
					/>
					<DnsRecordRow
						kind={!redirectTo && claim.isZoneApex ? "Apex alias" : "CNAME"}
						name={claim.hostname}
						value={claim.cnameTarget}
					/>
				</Collection>
			) : null}
			{!redirectTo && claim.status !== "active" ? (
				<Text as="p" role="caption" tone="secondary">
					{claim.isZoneApex
						? "At the root domain, use your provider's CNAME flattening or apex alias to point to this target. Once the apex and TLS certificate are active, set up www below."
						: "Verification completes after Cloudflare confirms the hostname and TLS certificate are active."}
				</Text>
			) : null}
			{claim.validationRecords.length ? (
				<div className="space-y-2">
					<Text as="p" role="body" className="font-medium">
						{redirectTo
							? "www TLS validation records"
							: "TLS validation records"}
					</Text>
					<Collection>
						{claim.validationRecords.map((record) => (
							<DnsRecordRow
								key={`${record.name}:${record.value}`}
								kind={record.type}
								name={record.name}
								value={record.value}
							/>
						))}
					</Collection>
				</div>
			) : null}
			{claim.status !== "active" &&
			(claim.providerStatus || claim.sslStatus) ? (
				<Text as="p" role="caption" tone="secondary">
					Provider: {humanize(claim.providerStatus ?? "Waiting")} · SSL:{" "}
					{humanize(claim.sslStatus ?? "Waiting")}
				</Text>
			) : null}
			<div className="flex flex-wrap gap-2">
				{canConnect &&
				(claim.status === "pending" || claim.status === "provisioning") ? (
					<Button
						size="sm"
						disabled={verifying}
						onClick={() => onVerify(claim.claimId)}
					>
						{verifying
							? "Checking…"
							: redirectTo
								? "Verify www"
								: claim.status === "provisioning"
									? "Retry provisioning"
									: "Verify domain"}
					</Button>
				) : null}
				<Button size="sm" variant="outline" onClick={onRefresh}>
					{redirectTo ? "Refresh www status" : "Refresh status"}
				</Button>
				{claim.status !== "removing" ? (
					<Button
						size="sm"
						variant="destructive"
						onClick={() =>
							onRemove({
								claimId: claim.claimId,
								hostname: claim.hostname,
							})
						}
					>
						{redirectTo ? "Remove www redirect" : "Remove domain"}
					</Button>
				) : null}
			</div>
		</div>
	);
}

export function CmsDomainManager({
	siteId,
	canConnect,
	currentAddress,
}: {
	siteId: string;
	canConnect: boolean;
	currentAddress?: string;
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
	const refreshDomain = () => {
		void queryClient.invalidateQueries({ queryKey: domainOptions.queryKey });
		void queryClient.invalidateQueries({ queryKey: redirectOptions.queryKey });
		void queryClient.invalidateQueries(sitesQueryOptions());
	};
	const begin = useMutation({
		mutationFn: (nextHostname: string) =>
			osApi.sites.beginCmsDomain({ siteId, hostname: nextHostname }),
		onSuccess: () => {
			setHostname("");
			refreshDomain();
			toast.success(
				"Domain claim created. Add the DNS records below, then verify.",
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
						? "Connect a hostname you control to this website. Add the DNS records before verifying ownership."
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
					<LoadError
						title="Domain status is unavailable"
						error={domain.error}
						onRetry={() => {
							void domain.refetch();
						}}
						retrying={domain.isFetching}
					/>
				) : null}
				{claim ? (
					<div className="space-y-3">
						<DomainClaimPanel
							claim={claim}
							canConnect={canConnect}
							verifying={verify.isPending}
							onVerify={(claimId) => verify.mutate(claimId)}
							onRefresh={() => void domain.refetch()}
							onRemove={setRemoveTarget}
						/>
						{showRedirect ? (
							<div className="space-y-3 border-t pt-4">
								<Text as="p" role="body" className="font-medium">
									www redirect to {claim.hostname}
								</Text>
								{redirect.isPending ? <ListSkeleton /> : null}
								{redirect.isError ? (
									<LoadError
										title="www status is unavailable"
										error={redirect.error}
										onRetry={() => {
											void redirect.refetch();
										}}
										retrying={redirect.isFetching}
									/>
								) : null}
								{redirectClaim ? (
									<DomainClaimPanel
										claim={redirectClaim}
										redirectTo={claim.hostname}
										canConnect={canConnect}
										verifying={verify.isPending}
										onVerify={(claimId) => verify.mutate(claimId)}
										onRefresh={() => void redirect.refetch()}
										onRemove={setRemoveTarget}
									/>
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
				) : domain.isSuccess ? (
					<Text as="p" role="body" tone="secondary">
						{currentAddress
							? `Working at ${currentAddress}`
							: "No custom domain is connected."}
					</Text>
				) : null}
				{canConnect && domain.isSuccess ? (
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
				<ConfirmDialog
					open={removeTarget !== null}
					onOpenChange={(open) => {
						if (!open) setRemoveTarget(null);
					}}
					title={`Remove ${removeTarget?.hostname ?? ""}?`}
					description={
						removeTarget?.hostname === claim?.hostname
							? "When removal finishes, the site's built-in address becomes canonical. Update your DNS afterward."
							: "When removal finishes, www stops redirecting. Update your DNS afterward."
					}
					confirmLabel="Remove domain"
					pendingLabel="Removing…"
					destructive
					isPending={remove.isPending}
					confirmDisabled={!removeTarget}
					onConfirm={() => {
						if (removeTarget) remove.mutate(removeTarget.claimId);
					}}
				/>
			</CardContent>
		</Card>
	);
}
