import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/kumo/sheet";
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
import { useMediaQuery } from "@/lib/use-media-query";

export function ProviderIdentityProfiles({
	canChange,
}: {
	canChange: boolean;
}) {
	const client = useQueryClient();
	const mobile = useMediaQuery("(max-width: 639px)");
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
	const [open, setOpen] = useState(false);
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
			setOpen(false);
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
			aria-label="Account checks"
		>
			<h3 className="m-0 font-semibold">Account checks</h3>
			<Text as="p" role="label" tone="secondary">
				Define how to identify the account a connection uses. Saving a check
				does not run it or enable automatic approval.
			</Text>
			{profiles.isError ? (
				<Text as="p" role="label" tone="error">
					Could not load account checks.
				</Text>
			) : profiles.data && profiles.data.items.length === 0 ? (
				<Text as="p" role="label" tone="secondary">
					No account checks yet.
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
			{revoke.error ? (
				<Text as="p" role="label" tone="error">
					{revoke.error.message}
				</Text>
			) : null}
			{canChange ? (
				<Sheet
					open={open}
					onOpenChange={(next) => {
						setOpen(next);
						if (!next) {
							prepare.reset();
							create.reset();
							setSafe(false);
						}
					}}
				>
					<Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
						Add account check
					</Button>
					<SheetContent
						side={mobile ? "bottom" : "right"}
						size="lg"
						className={mobile ? "max-h-[85dvh] rounded-t-xl" : "sm:w-full"}
					>
						<SheetHeader>
							<SheetTitle>Add account check</SheetTitle>
							<SheetDescription>
								Choose the action and a safe check that identifies its account.
								Review the check before saving.
							</SheetDescription>
						</SheetHeader>
						<div className="grid gap-3 px-4 pb-6 sm:px-6">
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
									<SelectValue placeholder="Choose an app">
										{rootAppId
											? (apps.data?.data.find((app) => app.id === rootAppId)
													?.name ?? "Selected app unavailable")
											: null}
									</SelectValue>
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
							<label htmlFor="identity-probe-tool">Account check action</label>
							<Input
								id="identity-probe-tool"
								aria-label="Account check action"
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
								Fields that identify the account
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
								Enter one field from the check's response per line. For a nested
								field, use a dot, for example workspace.id.
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
								Review account check
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
										<Switch
											aria-label="I reviewed this exact check and it is safe to run with no arguments"
											checked={safe}
											onCheckedChange={setSafe}
										/>{" "}
										I reviewed this exact check and it is safe to run with no
										arguments.
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
							{prepare.error || create.error ? (
								<Text as="p" role="label" tone="error">
									{(prepare.error ?? create.error)?.message}
								</Text>
							) : null}
						</div>
					</SheetContent>
				</Sheet>
			) : null}
		</section>
	);
}
