import type { PortableWebMcpProfile } from "@tedix/api-contract/schemas/portable-webmcp";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import { osApi } from "@/lib/api";
import { portableWebMcpConfigurationsQueryOptions } from "@/lib/os-query-options";

type Configuration = Awaited<
	ReturnType<typeof osApi.tedis.listPortableWebMcpConfigurations>
>[number];
type EligibleTool = Configuration["eligibleTools"][number];

function portableInputSchema(inputSchema: Record<string, unknown>) {
	const rawProperties =
		inputSchema.properties &&
		typeof inputSchema.properties === "object" &&
		!Array.isArray(inputSchema.properties)
			? (inputSchema.properties as Record<string, unknown>)
			: {};
	const properties = Object.fromEntries(
		Object.entries(rawProperties).flatMap(([key, raw]) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
			const field = raw as Record<string, unknown>;
			if (
				!["string", "number", "integer", "boolean"].includes(String(field.type))
			)
				return [];
			return [
				[
					key,
					{
						type: field.type as "string" | "number" | "integer" | "boolean",
						...(typeof field.description === "string"
							? { description: field.description }
							: {}),
					},
				],
			];
		}),
	);
	const required = Array.isArray(inputSchema.required)
		? inputSchema.required.filter(
				(value): value is string =>
					typeof value === "string" && Object.hasOwn(properties, value),
			)
		: [];
	return {
		type: "object" as const,
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false as const,
	};
}

export function buildPortableCatalogTool(
	tool: EligibleTool,
	action?: {
		prepareCallable: string;
		convergeCallable: string;
		confirmationTitle: string;
		confirmationLabel: string;
	},
) {
	return {
		callable: tool.callable,
		name: tool.toolId,
		description: tool.description ?? tool.title ?? tool.toolId,
		inputSchema: portableInputSchema(tool.inputSchema),
		...(action ? { action } : {}),
		annotations: {
			readOnlyHint: tool.writeCapability === "read",
			untrustedContentHint: true,
		},
	};
}

export async function publishPortableWebMcpRollout(input: {
	profile: PortableWebMcpProfile;
	changeSummary: string;
	targets: Pick<Configuration, "installationId" | "revision">[];
	publish?: typeof osApi.tedis.publishPortableWebMcpProfile;
}) {
	const publish = input.publish ?? osApi.tedis.publishPortableWebMcpProfile;
	const published: string[] = [];
	for (const target of input.targets) {
		await publish({
			installationId: target.installationId,
			expectedRevision: target.revision,
			profile: input.profile,
			changeSummary: input.changeSummary,
		});
		published.push(target.installationId);
	}
	return published;
}

export function PortableWebMcpBuilder({
	fallbackProfile,
}: {
	fallbackProfile?: PortableWebMcpProfile;
}) {
	const query = useQuery(portableWebMcpConfigurationsQueryOptions());
	const [selectedId, setSelectedId] = useState("");
	const selected =
		query.data?.find((item) => item.installationId === selectedId) ??
		query.data?.[0];
	return (
		<section
			className="grid gap-4 xl:col-span-2"
			aria-labelledby="portable-webmcp-heading"
		>
			<div>
				<h3
					id="portable-webmcp-heading"
					className="font-medium text-kumo-strong"
				>
					Portable Layer 2 routes
				</h3>
				<p className="text-kumo-subtle">
					Build route tools from the installation’s admitted read-only catalog.
					Each tenant publishes and rolls back independently.
				</p>
			</div>
			{query.isPending && <Skeleton className="h-36 w-full" />}
			{query.isError && (
				<Alert variant="destructive">
					<AlertTitle>Route configuration unavailable</AlertTitle>
					<AlertDescription>
						The provider installation catalog could not be loaded.
					</AlertDescription>
				</Alert>
			)}
			{query.data?.length === 0 && (
				<Alert>
					<AlertTitle>Create a tenant installation first</AlertTitle>
					<AlertDescription>
						Route tools are published to a signed installation, never an unbound
						browser.
					</AlertDescription>
				</Alert>
			)}
			{selected && (
				<>
					<label className="grid gap-1">
						Tenant installation
						<Select
							value={selected.installationId}
							onValueChange={(value) => value && setSelectedId(value)}
						>
							<SelectTrigger aria-label="Tenant installation">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{query.data?.map((item) => (
									<SelectItem
										key={item.installationId}
										value={item.installationId}
									>
										Tenant {item.externalTenantId} · revision {item.revision}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
					<InstallationEditor
						key={`${selected.installationId}:${selected.revision}`}
						configuration={selected}
						fallbackProfile={fallbackProfile}
					/>
				</>
			)}
		</section>
	);
}

function InstallationEditor({
	configuration,
	fallbackProfile,
}: {
	configuration: Configuration;
	fallbackProfile?: PortableWebMcpProfile;
}) {
	const client = useQueryClient();
	const [rolloutIds, setRolloutIds] = useState<string[]>([]);
	const [profile, setProfile] = useState<PortableWebMcpProfile>(
		configuration.profile ?? fallbackProfile ?? { version: 1, routes: [] },
	);
	const [changeSummary, setChangeSummary] = useState("Update route tools");
	const [actionDrafts, setActionDrafts] = useState<
		Record<string, { prepareCallable?: string; convergeCallable?: string }>
	>({});
	const mutation = useMutation({
		mutationFn: (nextProfile: PortableWebMcpProfile) =>
			osApi.tedis.publishPortableWebMcpProfile({
				installationId: configuration.installationId,
				expectedRevision: configuration.revision,
				profile: nextProfile,
				changeSummary,
			}),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: portableWebMcpConfigurationsQueryOptions().queryKey,
			}),
	});
	const rolloutTargets = (
		configuration.installationId
			? (client.getQueryData<Configuration[]>(
					portableWebMcpConfigurationsQueryOptions().queryKey,
				) ?? [])
			: []
	).filter((item) => rolloutIds.includes(item.installationId));
	const rollout = useMutation({
		mutationFn: () =>
			publishPortableWebMcpRollout({
				profile,
				changeSummary: `Rollout: ${changeSummary}`,
				targets: rolloutTargets,
			}),
		onSettled: () =>
			client.invalidateQueries({
				queryKey: portableWebMcpConfigurationsQueryOptions().queryKey,
			}),
	});
	const updateRoute = (
		index: number,
		update: (
			route: PortableWebMcpProfile["routes"][number],
		) => PortableWebMcpProfile["routes"][number],
	) =>
		setProfile({
			...profile,
			routes: profile.routes.map((route, routeIndex) =>
				routeIndex === index ? update(route) : route,
			),
		});
	return (
		<div className="grid gap-4 rounded-xl border border-kumo-line p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<p className="font-medium">Tenant {configuration.externalTenantId}</p>
					<p className="text-kumo-subtle type-tedix-label">
						{configuration.hostTenantNamespace} · revision{" "}
						{configuration.revision}
					</p>
				</div>
				<Badge
					variant={
						configuration.activation.status === "ready"
							? "success"
							: configuration.activation.status === "blocked"
								? "destructive"
								: "secondary"
					}
				>
					{configuration.activation.status === "ready"
						? `${configuration.activation.routeCount} routes · ${configuration.activation.admittedToolCount} tools ready`
						: configuration.activation.status === "blocked"
							? `Blocked · ${configuration.activation.reasonCodes.join(", ")}`
							: "Profile not published"}
				</Badge>
				<Button
					variant="secondary"
					onClick={() =>
						setProfile({
							...profile,
							routes: [
								...profile.routes,
								{
									id: `route-${profile.routes.length + 1}`,
									match: { routeKey: `route-${profile.routes.length + 1}` },
									tools: [],
								},
							],
						})
					}
				>
					Add route
				</Button>
			</div>
			{profile.routes.map((route, routeIndex) => (
				<div
					key={`${route.id}:${routeIndex}`}
					className="grid gap-3 rounded-lg border border-kumo-line p-3"
				>
					<div className="grid gap-2 md:grid-cols-2">
						<label className="grid gap-1">
							Route id
							<Input
								aria-label={`Route ${routeIndex + 1} id`}
								value={route.id}
								onChange={(event) =>
									updateRoute(routeIndex, (item) => ({
										...item,
										id: event.target.value,
									}))
								}
							/>
						</label>
						<label className="grid gap-1">
							Stable route key
							<Input
								aria-label={`Route ${routeIndex + 1} key`}
								value={route.match.routeKey ?? ""}
								onChange={(event) =>
									updateRoute(routeIndex, (item) => ({
										...item,
										match: {
											...item.match,
											routeKey: event.target.value || undefined,
										},
									}))
								}
							/>
						</label>
					</div>
					<div className="grid gap-2 md:grid-cols-2">
						{configuration.eligibleTools.map((tool) => {
							const checked = route.tools.some(
								(item) => item.callable === tool.callable,
							);
							const actionDraft = actionDrafts[tool.callable] ?? {};
							const readTools = configuration.eligibleTools.filter(
								(candidate) => candidate.writeCapability === "read",
							);
							const action =
								tool.writeCapability === "write" &&
								actionDraft.prepareCallable &&
								actionDraft.convergeCallable
									? {
											prepareCallable: actionDraft.prepareCallable,
											convergeCallable: actionDraft.convergeCallable,
											confirmationTitle: `Confirm ${tool.title ?? tool.toolId}`,
											confirmationLabel: tool.title ?? tool.toolId,
										}
									: undefined;
							return (
								<div
									key={tool.callable}
									className="grid gap-2 rounded-lg border border-kumo-line p-3"
								>
									<label className="flex gap-2">
										<input
											type="checkbox"
											checked={checked}
											disabled={
												tool.writeCapability === "write" &&
												(!actionDraft.prepareCallable ||
													!actionDraft.convergeCallable)
											}
											onChange={(event) =>
												updateRoute(routeIndex, (item) => ({
													...item,
													tools: event.target.checked
														? [
																...item.tools,
																buildPortableCatalogTool(tool, action),
															]
														: item.tools.filter(
																(entry) => entry.callable !== tool.callable,
															),
												}))
											}
										/>
										<span>
											<strong>
												{tool.title ?? tool.toolId}
												{tool.writeCapability === "write"
													? " · confirmed write"
													: ""}
											</strong>
											<span className="block text-kumo-subtle type-tedix-label">
												{tool.description ?? tool.callable}
											</span>
										</span>
									</label>
									{tool.writeCapability === "write" && (
										<div className="grid gap-2">
											<Select
												value={actionDraft.prepareCallable ?? ""}
												onValueChange={(value) =>
													setActionDrafts((current) => ({
														...current,
														[tool.callable]: {
															...current[tool.callable],
															prepareCallable: value || undefined,
														},
													}))
												}
											>
												<SelectTrigger
													aria-label={`${tool.toolId} preparation tool`}
												>
													<SelectValue placeholder="Choose preparation tool" />
												</SelectTrigger>
												<SelectContent>
													{readTools.map((candidate) => (
														<SelectItem
															key={candidate.callable}
															value={candidate.callable}
														>
															{candidate.title ?? candidate.toolId}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<Select
												value={actionDraft.convergeCallable ?? ""}
												onValueChange={(value) =>
													setActionDrafts((current) => ({
														...current,
														[tool.callable]: {
															...current[tool.callable],
															convergeCallable: value || undefined,
														},
													}))
												}
											>
												<SelectTrigger
													aria-label={`${tool.toolId} convergence tool`}
												>
													<SelectValue placeholder="Choose convergence tool" />
												</SelectTrigger>
												<SelectContent>
													{readTools.map((candidate) => (
														<SelectItem
															key={candidate.callable}
															value={candidate.callable}
														>
															{candidate.title ?? candidate.toolId}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									)}
								</div>
							);
						})}
					</div>
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							setProfile({
								...profile,
								routes: profile.routes.filter(
									(_, index) => index !== routeIndex,
								),
							})
						}
					>
						Remove route
					</Button>
				</div>
			))}
			<label className="grid gap-1">
				Change summary
				<Input
					aria-label="Route profile change summary"
					value={changeSummary}
					onChange={(event) => setChangeSummary(event.target.value)}
				/>
			</label>
			{rolloutTargets.length > 0 && (
				<p className="text-kumo-subtle type-tedix-label">
					This revision will also be published to {rolloutTargets.length}{" "}
					selected tenant{rolloutTargets.length === 1 ? "" : "s"} using each
					tenant’s current revision fence.
				</p>
			)}
			<div className="grid gap-2 rounded-lg border border-kumo-line p-3">
				<p className="font-medium">Roll out to other tenants</p>
				<p className="text-kumo-subtle type-tedix-label">
					Choose installations explicitly. A stale tenant stops the rollout and
					is not overwritten.
				</p>
				{(
					client.getQueryData<Configuration[]>(
						portableWebMcpConfigurationsQueryOptions().queryKey,
					) ?? []
				)
					.filter(
						(item) => item.installationId !== configuration.installationId,
					)
					.map((item) => (
						<label
							key={item.installationId}
							className="flex items-center gap-2"
						>
							<input
								type="checkbox"
								checked={rolloutIds.includes(item.installationId)}
								onChange={(event) =>
									setRolloutIds((current) =>
										event.target.checked
											? [...current, item.installationId]
											: current.filter((id) => id !== item.installationId),
									)
								}
							/>
							Tenant {item.externalTenantId} · revision {item.revision}
						</label>
					))}
			</div>
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={
						mutation.isPending ||
						profile.routes.some((route) => route.tools.length === 0)
					}
					onClick={() => mutation.mutate(profile)}
				>
					{mutation.isPending ? "Publishing…" : "Publish route revision"}
				</Button>
				<Button
					variant="secondary"
					disabled={
						rollout.isPending ||
						rolloutTargets.length === 0 ||
						profile.routes.some((route) => route.tools.length === 0)
					}
					onClick={() => rollout.mutate()}
				>
					{rollout.isPending ? "Rolling out…" : "Publish to selected tenants"}
				</Button>
				{configuration.history
					.slice()
					.reverse()
					.slice(1, 4)
					.map((revision) => (
						<Button
							key={revision.revision}
							variant="secondary"
							disabled={mutation.isPending}
							onClick={() => {
								setChangeSummary(`Rollback to revision ${revision.revision}`);
								mutation.mutate(revision.profile);
							}}
						>
							Restore revision {revision.revision}
						</Button>
					))}
				{mutation.isSuccess && <Badge variant="success">Published</Badge>}
				{mutation.isError && (
					<span role="alert" className="text-kumo-danger">
						The route revision could not be published. Refresh if another editor
						published first.
					</span>
				)}
				{rollout.isSuccess && (
					<Badge variant="success">Rollout published</Badge>
				)}
				{rollout.isError && (
					<span role="alert" className="text-kumo-danger">
						Rollout stopped. Refresh to see tenants published before the stale
						or unavailable installation.
					</span>
				)}
			</div>
		</div>
	);
}
