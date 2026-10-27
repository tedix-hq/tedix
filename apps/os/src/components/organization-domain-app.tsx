import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

export function OrganizationDomainApp({
	organizationId,
}: {
	organizationId: string;
}) {
	const context = useOsOperationalContext();
	const authorized =
		context.data?.organization.id === organizationId &&
		["owner", "admin"].includes(context.data.authority.role ?? "");
	const cache = useQueryClient();
	const domain = useQuery({
		...osQuery.organizations.getCustomDomain.queryOptions({ input: {} }),
		enabled: authorized,
	});
	const [hostname, setHostname] = useState("");
	const change = useMutation({
		mutationFn: async (action: "add" | "verify" | "remove") => {
			if (action === "add")
				return osApi.organizations.beginCustomDomain({ hostname });
			if (!domain.data) throw new Error("Reload the domain before continuing.");
			const input = { claimId: domain.data.claimId };
			return action === "verify"
				? osApi.organizations.verifyCustomDomain(input)
				: osApi.organizations.removeCustomDomain(input);
		},
		onSettled: () =>
			cache.invalidateQueries({
				queryKey: osQuery.organizations.getCustomDomain.key(),
			}),
	});
	if (!authorized)
		return (
			<p>Only an organization owner or administrator can manage its domain.</p>
		);
	const error = change.error ?? domain.error;
	return (
		<section className="min-w-0 space-y-4" aria-label="Organization domain">
			<h2 className="font-semibold">Share domain</h2>
			<p>
				Use your own hostname for this organization's share links. Add the DNS
				records below, then verify the domain.
			</p>
			{error && (
				<Alert variant="destructive">
					<AlertTitle>Domain could not be updated</AlertTitle>
					<AlertDescription>{error.message}</AlertDescription>
				</Alert>
			)}
			{domain.isPending ? (
				<p role="status">Loading domain…</p>
			) : domain.isError ? (
				<Button variant="outline" onClick={() => void domain.refetch()}>
					Retry
				</Button>
			) : domain.data ? (
				<>
					<p className="break-all">
						<strong>{domain.data.hostname}</strong> · {domain.data.status}
					</p>
					{domain.data.status === "active" ? (
						<p role="status">Verified. Share links can use this hostname.</p>
					) : (
						<p>
							DNS changes and certificate checks can take time. Keep these
							records and verify again when they have propagated.
						</p>
					)}
					<dl className="space-y-2 break-all">
						<dt className="font-semibold">TXT name</dt>
						<dd>
							<code>{domain.data.txtName}</code>
						</dd>
						<dt className="font-semibold">TXT value</dt>
						<dd>
							<code>{domain.data.txtValue}</code>
						</dd>
						<dt className="font-semibold">CNAME</dt>
						<dd>
							<code>
								{domain.data.hostname} → {domain.data.cnameTarget}
							</code>
						</dd>
						{domain.data.validationRecords.map((record) => (
							<div key={`${record.type}:${record.name}`}>
								<dt>
									{record.type} · {record.name}
								</dt>
								<dd>
									<code>{record.value}</code>
								</dd>
							</div>
						))}
					</dl>
					<p>
						Removing this domain stops links on it. Links on your Tedix hostname
						remain available.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={change.isPending || domain.data.status === "removing"}
							onClick={() => change.mutate("verify")}
						>
							Verify domain
						</Button>
						<Button
							variant="outline"
							disabled={change.isPending}
							onClick={() => change.mutate("remove")}
						>
							Remove domain
						</Button>
					</div>
				</>
			) : (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						change.mutate("add");
					}}
				>
					<label className="block space-y-2">
						<span>Hostname</span>
						<Input
							value={hostname}
							onChange={(event) => setHostname(event.target.value)}
							placeholder="share.example.com"
							aria-label="Hostname"
							autoComplete="off"
							required
							maxLength={253}
						/>
					</label>
					<Button type="submit" disabled={change.isPending || !hostname.trim()}>
						Add domain
					</Button>
				</form>
			)}
			{change.isPending && <p role="status">Updating domain…</p>}
		</section>
	);
}
