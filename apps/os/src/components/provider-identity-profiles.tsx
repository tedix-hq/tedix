import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { appListQueryOptions, osQuery } from "@/lib/os-query-options";

export function ProviderIdentityProfiles({
	canChange,
}: {
	canChange: boolean;
}) {
	const client = useQueryClient();
	const profiles = useQuery(
		osQuery.mcpGovernance.listProviderIdentityProfiles.queryOptions(),
	);
	const apps = useQuery(appListQueryOptions(100));
	const [rootAppId, setRootAppId] = useState("");
	const toolPreview = useQuery({
		...osQuery.mcpServer.previewToolScopes.queryOptions({
			input: { appId: rootAppId },
		}),
		enabled: rootAppId.length > 0,
	});
	const [mountedToolId, setMountedToolId] = useState("");
	const [probeMountedToolId, setProbeMountedToolId] = useState("");
	const [paths, setPaths] = useState("");
	const [safe, setSafe] = useState(false);
	const prepare = useMutation({
		mutationFn: () =>
			osApi.mcpGovernance.prepareProviderIdentityProfile({
				rootAppId,
				mountedToolId,
				probeMountedToolId,
				selectors: paths.split("\n").map((path) => path.trim().split(".")),
			}),
	});
	const refresh = () =>
		client.invalidateQueries({
			queryKey: osQuery.mcpGovernance.listProviderIdentityProfiles.key({
				type: "query",
			}),
		});
	const create = useMutation({
		mutationFn: () =>
			osApi.mcpGovernance.createProviderIdentityProfile({
				preparationId: prepare.data!.preparationId,
				expectedProfileDigest: prepare.data!.profileDigest,
				safetyAttestation: "safe_empty_probe",
			}),
		onSuccess: async () => {
			prepare.reset();
			setSafe(false);
			await refresh();
		},
	});
	const revoke = useMutation({
		mutationFn: (id: string) =>
			osApi.mcpGovernance.revokeProviderIdentityProfile({ id }),
		onSuccess: refresh,
	});
	return (
		<section
			className="grid gap-3 border-t border-kumo-hairline px-4 py-3"
			aria-label="Provider identity profiles"
		>
			<h3 className="m-0 font-semibold">Provider identity profiles</h3>
			<Text as="p" role="label" tone="secondary">
				A profile identifies the account used by a connection. Profiles do not
				yet enable automatic approval or run an identity check.
			</Text>
			{profiles.isError ? (
				<Text as="p" role="label" tone="error">
					Could not load identity profiles.
				</Text>
			) : null}
			<ul className="m-0 grid list-none gap-2 p-0">
				{(profiles.data?.items ?? []).map((item) => (
					<li
						key={item.id}
						className="grid gap-1 border-b border-kumo-hairline pb-2"
					>
						<span>
							{item.mount.mountedToolId} ·{" "}
							{item.revokedAt ? "Revoked" : "Reviewed"}
						</span>
						<Text as="span" role="label" tone="secondary">
							{item.mount.providerId}: check {item.profile.operation} · fields{" "}
							{item.profile.selectors.map((path) => path.join(".")).join(", ")}{" "}
							· {item.mount.connectionScope} connection{" "}
							{item.mount.connectionInstanceId ?? "selected at use"}
						</Text>
						{canChange && !item.revokedAt ? (
							<Button
								size="sm"
								variant="ghost"
								disabled={revoke.isPending}
								onClick={() => revoke.mutate(item.id)}
							>
								Revoke profile
							</Button>
						) : null}
					</li>
				))}
			</ul>
			{canChange ? (
				<>
					<label>App</label>
					<Select
						value={rootAppId}
						onValueChange={(next) => {
							setRootAppId(next ?? "");
							prepare.reset();
							setSafe(false);
						}}
					>
						<SelectTrigger aria-label="Profile app">
							<SelectValue placeholder="Choose an app" />
						</SelectTrigger>
						<SelectContent>
							{(apps.data?.data ?? []).map((app) => (
								<SelectItem key={app.id} value={app.id}>
									{app.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<label htmlFor="identity-write-tool">Action to protect</label>
					<Input
						id="identity-write-tool"
						aria-label="Action to protect"
						list="identity-tool-suggestions"
						value={mountedToolId}
						onChange={(event) => {
							setMountedToolId(event.target.value);
							prepare.reset();
							setSafe(false);
						}}
					/>
					<label htmlFor="identity-probe-tool">Identity check tool</label>
					<Input
						id="identity-probe-tool"
						aria-label="Identity check tool"
						list="identity-tool-suggestions"
						value={probeMountedToolId}
						onChange={(event) => {
							setProbeMountedToolId(event.target.value);
							prepare.reset();
							setSafe(false);
						}}
					/>
					<datalist id="identity-tool-suggestions">
						{Object.keys(toolPreview.data?.toolScopes ?? {}).map((name) => (
							<option key={name} value={name} />
						))}
					</datalist>
					<label htmlFor="identity-paths">
						Identity fields, one dotted path per line
					</label>
					<Textarea
						id="identity-paths"
						value={paths}
						onChange={(event) => {
							setPaths(event.target.value);
							prepare.reset();
							setSafe(false);
						}}
						rows={3}
					/>
					<Text as="p" role="label" tone="secondary">
						Use field names from the identity check's structured response. For
						nested fields, separate names with a dot.
					</Text>
					<Button
						size="sm"
						disabled={
							!rootAppId ||
							!mountedToolId.trim() ||
							!probeMountedToolId.trim() ||
							!paths.trim() ||
							prepare.isPending
						}
						onClick={() => prepare.mutate()}
					>
						Review identity profile
					</Button>
					{prepare.data ? (
						<div className="grid gap-2">
							<Text as="p" role="label" tone="secondary">
								Review {prepare.data.mount.mountedToolId} with{" "}
								{prepare.data.probeMount.mountedToolId} on{" "}
								{prepare.data.mount.providerId}. The check calls{" "}
								{prepare.data.profile.operation} with no arguments and reads{" "}
								{prepare.data.profile.selectors
									.map((path) => path.join("."))
									.join(", ")}
								.
							</Text>
							<label className="flex items-center gap-2">
								<Switch checked={safe} onCheckedChange={setSafe} /> I reviewed
								this exact check and it is safe to run with no arguments.
							</label>
							<Button
								size="sm"
								disabled={!safe || create.isPending}
								onClick={() => create.mutate()}
							>
								Save reviewed profile
							</Button>
						</div>
					) : null}
					{prepare.error || create.error || revoke.error ? (
						<Text as="p" role="label" tone="error">
							{(prepare.error ?? create.error ?? revoke.error)?.message}
						</Text>
					) : null}
				</>
			) : null}
		</section>
	);
}
