import {
	CalendarResourcePicker,
	calendarResourceSelection,
} from "./calendar-resource-picker";
import { WorkspaceCalendarCoordinator } from "./workspace-calendar-coordinator";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { osApi, osChatMutationApi } from "@/lib/api";
import {
	projectListQueryOptions,
	osQuery,
	tediRosterQueryOptions,
	userConnectionsQueryOptions,
	workspaceResourcesQueryOptions,
	workspaceWorkProjectsQueryOptions,
} from "@/lib/os-query-options";

export const resourceReferenceSchema = z
	.object({
		providerKey: z.string().min(1, "Choose a connected app."),
		resourceType: z.string().trim().min(1, "Enter a resource type."),
		providerResourceId: z
			.string()
			.trim()
			.min(1, "Enter the ID from the connected app."),
		githubFullName: z.string().trim(),
		githubInstallationId: z.string().trim(),
		name: z.string().trim().min(1, "Enter a name."),
	})
	.superRefine((value, context) => {
		if (
			!value.providerKey.startsWith("github:") ||
			value.resourceType !== "repository"
		)
			return;
		if (
			value.githubFullName &&
			!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(value.githubFullName)
		)
			context.addIssue({
				code: "custom",
				path: ["githubFullName"],
				message: "Use owner/repository.",
			});
		if (
			value.githubInstallationId &&
			!/^[1-9]\d*$/.test(value.githubInstallationId)
		)
			context.addIssue({
				code: "custom",
				path: ["githubInstallationId"],
				message: "Enter a positive installation ID.",
			});
		if (Boolean(value.githubFullName) !== Boolean(value.githubInstallationId))
			context.addIssue({
				code: "custom",
				path: ["githubInstallationId"],
				message:
					"Add both the repository name and installation ID, or leave both empty.",
			});
	});

export function availabilityLabel(status?: string) {
	switch (status) {
		case "available":
			return "App connected";
		case "expired_connection":
			return "Reconnect app";
		case "missing_connection":
			return "Connect app";
		case "check_failed":
			return "Could not check connection";
		case "not_executable":
			return "Unavailable";
		default:
			return "Connection not checked";
	}
}

export function readableResourceLabel(value: string) {
	if (value === "github") return "GitHub";
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function repositoryIdentity(resource: OsWorkspaceResource) {
	const repositoryId = Number(resource.providerResourceId);
	const installationId = Number(resource.metadata.githubInstallationId);
	const fullName = resource.metadata.githubFullName;
	if (
		resource.providerId !== "github" ||
		resource.resourceType !== "repository" ||
		resource.connectionScope !== "tenant" ||
		!Number.isSafeInteger(repositoryId) ||
		repositoryId <= 0 ||
		!Number.isSafeInteger(installationId) ||
		installationId <= 0 ||
		typeof fullName !== "string"
	) {
		return null;
	}
	return { repositoryId, installationId, fullName };
}

function repoUrlFullName(repoUrl: string) {
	try {
		const url = new URL(repoUrl);
		return url.hostname === "github.com"
			? url.pathname.replace(/^\//, "").replace(/\/$/, "")
			: null;
	} catch {
		return null;
	}
}

export function WorkspaceResourcesPanel({
	workspaceId,
}: {
	workspaceId: string;
}) {
	const queryClient = useQueryClient();
	const query = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const connectionsQuery = useQuery(userConnectionsQueryOptions());
	const personalAccounts = useQuery(
		osQuery.connections.getConnectionsOverview.queryOptions({
			input: { scope: "personal", status: "all", q: "", limit: 100, offset: 0 },
		}),
	);
	const projectLinksQuery = useQuery(
		workspaceWorkProjectsQueryOptions(workspaceId),
	);
	const projectsQuery = useQuery(projectListQueryOptions(100));
	const tedisQuery = useQuery(
		tediRosterQueryOptions(100, { status: "active" }),
	);
	const [open, setOpen] = useState(false);
	const [calendarOpen, setCalendarOpen] = useState(false);
	const [customType, setCustomType] = useState(false);
	const [repositoryAction, setRepositoryAction] =
		useState<OsWorkspaceResource | null>(null);
	const [actionId, setActionId] = useState("");
	const [projectId, setProjectId] = useState("");
	const [tediId, setTediId] = useState("");
	const [task, setTask] = useState("");
	const [outcome, setOutcome] = useState("");
	const resources = query.data?.items ?? [];
	const connections = (connectionsQuery.data?.data ?? [])
		.filter((connection) => connection.status === "connected")
		.flatMap((connection) => {
			const instances =
				connection.tokenScope === "user"
					? (personalAccounts.data?.rows ?? []).filter(
							(row) =>
								row.provider.appId === connection.appId &&
								row.scope === "user" &&
								row.accountState === "present" &&
								row.connectionInstanceId,
						)
					: [];
			return instances.length
				? instances.map((row) => ({
						...connection,
						connectionInstanceId: row.connectionInstanceId,
						instanceLabel: row.instanceLabel,
					}))
				: [
						{
							...connection,
							connectionInstanceId: undefined,
							instanceLabel: undefined,
						},
					];
		});
	const linkedProjectIds = new Set(
		projectLinksQuery.data?.items.map((link) => link.projectId) ?? [],
	);
	const linkedProjects =
		projectsQuery.data?.data.filter(
			(project) =>
				project.status === "active" && linkedProjectIds.has(project.id),
		) ?? [];
	const selectedIdentity = repositoryAction
		? repositoryIdentity(repositoryAction)
		: null;
	const eligibleTedis =
		tedisQuery.data?.data.filter((tedi) => {
			const repo = tedi.repoConfig;
			return (
				selectedIdentity &&
				tedi.status === "active" &&
				!tedi.retiredAt &&
				repo?.githubAppEnabled === true &&
				repo.githubRepositoryId === selectedIdentity.repositoryId &&
				repo.githubInstallationId === selectedIdentity.installationId &&
				repoUrlFullName(repo.repoUrl) === selectedIdentity.fullName
			);
		}) ?? [];
	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
		});
	const attachCalendar = useMutation({
		mutationFn: (choice: Parameters<typeof calendarResourceSelection>[0]) =>
			osApi.osWorkspaces.resources.create({
				workspaceId,
				selection: calendarResourceSelection(choice),
			}),
		onSuccess: async () => {
			await refresh();
			setCalendarOpen(false);
		},
	});
	const create = useMutation({
		mutationFn: (value: z.output<typeof resourceReferenceSchema>) => {
			const selectedConnection = connections.find(
				(connection) =>
					`${connection.appId}:${connection.tokenScope}:${connection.connectionInstanceId ?? ""}` ===
					value.providerKey,
			);
			if (!selectedConnection) throw new Error("Choose a connected app.");
			if (
				selectedConnection.tokenScope === "user" &&
				!selectedConnection.connectionInstanceId
			)
				throw new Error(
					"The exact personal account could not be verified. Check Connections first.",
				);
			return osApi.osWorkspaces.resources.create({
				workspaceId,
				selection: {
					providerId: selectedConnection.appId,
					connectionScope: selectedConnection.tokenScope,
					connectionInstanceId: selectedConnection.connectionInstanceId,
					resourceType: value.resourceType,
					providerResourceId: value.providerResourceId,
					name: value.name,
					metadata:
						selectedConnection.appId === "github" &&
						value.resourceType === "repository" &&
						value.githubFullName &&
						value.githubInstallationId
							? {
									githubFullName: value.githubFullName,
									githubInstallationId: Number(value.githubInstallationId),
								}
							: {},
				},
			});
		},
		onSuccess: async () => {
			await refresh();
			setOpen(false);
			setCustomType(false);
			form.reset();
		},
	});
	const form = useZodForm({
		schema: resourceReferenceSchema,
		defaultValues: {
			providerKey: "",
			resourceType: "",
			providerResourceId: "",
			githubFullName: "",
			githubInstallationId: "",
			name: "",
		},
		onSubmit: ({ value }) => create.mutate(value),
	});
	const remove = useMutation({
		mutationFn: (input: { resourceId: string; expectedUpdatedAt: string }) =>
			osApi.osWorkspaces.resources.remove({ workspaceId, ...input }),
		onSuccess: refresh,
	});
	const rebind = useMutation({
		mutationFn: (input: {
			resourceId: string;
			expectedUpdatedAt: string;
			connectionScope: "tenant" | "user";
			connectionInstanceId?: string;
		}) => osApi.osWorkspaces.resources.rebind({ workspaceId, ...input }),
		onSuccess: refresh,
	});
	const startRepositoryWork = useMutation({
		mutationFn: async () => {
			if (!repositoryAction || !projectId || !tediId || !task || !outcome) {
				throw new Error(
					"Choose a tedi and project, then enter the task and outcome.",
				);
			}
			const prepared = await osApi.osWorkspaces.resources.startRepositoryWork({
				workspaceId,
				resourceId: repositoryAction.id,
				expectedUpdatedAt: repositoryAction.updatedAt,
				projectId,
				tediId,
				task,
				outcome,
				idempotencyKey: actionId,
			});
			return osChatMutationApi.kernelRuntime.enqueueMessage({
				...prepared.dispatch,
				executionPolicy: "normal",
			});
		},
		onSuccess: () => {
			setRepositoryAction(null);
			setActionId("");
			setProjectId("");
			setTediId("");
			setTask("");
			setOutcome("");
		},
	});
	const openRepositoryAction = (resource: OsWorkspaceResource) => {
		setRepositoryAction(resource);
		setActionId(crypto.randomUUID());
		setProjectId(linkedProjects[0]?.id ?? "");
		setTediId("");
		setTask("");
		setOutcome("");
		startRepositoryWork.reset();
	};
	return (
		<section className="grid gap-3" data-workspace-resources-panel>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<SectionEyebrow
					title="Attached resources"
					count={query.data ? resources.length : undefined}
				/>
				<Button
					size="sm"
					variant="outline"
					onClick={() => setCalendarOpen(true)}
				>
					Choose calendar
				</Button>
				<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
					Attach resource
				</Button>
			</div>
			{resources.some(
				(resource) =>
					resource.status === "active" && resource.resourceType === "calendar",
			) && <WorkspaceCalendarCoordinator workspaceId={workspaceId} />}
			{query.isPending ? (
				<Text as="p" role="body" tone="secondary" className="m-0">
					Loading resources…
				</Text>
			) : null}
			{query.isError ? (
				<Text as="p" role="body" tone="error" className="m-0">
					Workspace resources could not be loaded.
				</Text>
			) : null}
			{query.data && resources.length === 0 ? (
				<Text as="p" role="body" tone="secondary" className="m-0">
					Attach a document, spreadsheet, repository, or account to get started.
				</Text>
			) : null}
			{resources.length > 0 ? (
				<ul className="m-0 grid list-none gap-2 p-0">
					{resources.map((resource) => (
						<Surface
							key={resource.id}
							className="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
							render={<li />}
						>
							<div className="min-w-0 flex-1">
								<Text as="p" role="body" className="m-0 truncate">
									{resource.name}
								</Text>
								<Text
									as="p"
									role="label"
									tone="secondary"
									className="m-0 truncate"
								>
									{connectionsQuery.data?.data.find(
										(connection) => connection.appId === resource.providerId,
									)?.providerName ??
										readableResourceLabel(resource.providerId)}{" "}
									· {readableResourceLabel(resource.resourceType)} ·{" "}
									{resource.connectionScope === "tenant"
										? "Shared account"
										: "Your account"}
								</Text>
								<details className="mt-1 text-kumo-subtle type-tedix-control">
									<summary className="cursor-pointer">
										Technical details
									</summary>
									<dl className="mt-2 grid gap-1 break-all">
										<dt>App identifier</dt>
										<dd className="m-0">{resource.providerId}</dd>
										<dt>Resource type</dt>
										<dd className="m-0">{resource.resourceType}</dd>
										<dt>Resource ID</dt>
										<dd className="m-0">{resource.providerResourceId}</dd>
									</dl>
								</details>
								{resource.availability?.status !== "available" &&
								resource.availability?.reason ? (
									<Text
										as="p"
										role="label"
										tone="error"
										className="mt-1 mb-0 leading-relaxed"
									>
										{resource.availability.reason}
									</Text>
								) : null}
							</div>
							<div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
								<Badge
									variant={
										resource.availability?.status === "available"
											? "secondary"
											: resource.availability
												? "destructive"
												: "outline"
									}
									title={
										resource.availability?.status === "available"
											? "App connected; access to this resource is checked when it is used."
											: (resource.availability?.reason ?? undefined)
									}
								>
									{availabilityLabel(resource.availability?.status)}
								</Badge>
								{repositoryIdentity(resource) ? (
									<Button
										size="sm"
										variant="secondary"
										disabled={resource.availability?.status !== "available"}
										onClick={() => openRepositoryAction(resource)}
									>
										Start repository work
									</Button>
								) : null}
								{connections
									.filter(
										(connection) =>
											connection.appId === resource.providerId &&
											connection.tokenScope !== resource.connectionScope,
									)
									.map((connection) => (
										<Button
											key={`${connection.tokenScope}:${connection.connectionInstanceId ?? ""}`}
											size="sm"
											variant="outline"
											disabled={
												rebind.isPending ||
												(connection.tokenScope === "user" &&
													!connection.connectionInstanceId)
											}
											onClick={() =>
												rebind.mutate({
													resourceId: resource.id,
													expectedUpdatedAt: resource.updatedAt,
													connectionScope: connection.tokenScope,
													connectionInstanceId: connection.connectionInstanceId,
												})
											}
										>
											Use{" "}
											{connection.tokenScope === "tenant" ? "shared" : "your"}{" "}
											connection
											{connection.instanceLabel
												? ` · ${connection.instanceLabel}`
												: ""}
										</Button>
									))}
								<Button
									size="sm"
									variant="ghost"
									disabled={remove.isPending}
									onClick={() =>
										remove.mutate({
											resourceId: resource.id,
											expectedUpdatedAt: resource.updatedAt,
										})
									}
								>
									Remove
								</Button>
							</div>
						</Surface>
					))}
				</ul>
			) : null}
			{rebind.isError ? (
				<Text as="p" role="body" tone="error" className="m-0">
					The resource connection could not be changed. Refresh and check the
					connected account.
				</Text>
			) : null}
			<Dialog
				open={repositoryAction !== null}
				onOpenChange={(next) => {
					if (!next) setRepositoryAction(null);
				}}
			>
				<DialogContent size="base">
					<DialogHeader>
						<DialogTitle>Start governed repository work</DialogTitle>
						<DialogDescription>
							Choose the accountable tedi and linked project. Tedix creates an
							accepted Work Item, then Home dispatches its fenced Workstation
							Attempt. Repository credentials are never copied into the
							Workspace.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3">
						<label className="grid gap-1 text-sm">
							Tedi
							<Select
								value={tediId}
								onValueChange={(value) => value && setTediId(value)}
							>
								<SelectTrigger aria-label="Repository work tedi">
									<SelectValue placeholder="Choose an eligible tedi" />
								</SelectTrigger>
								<SelectContent>
									{eligibleTedis.map((tedi) => (
										<SelectItem key={tedi.id} value={tedi.id}>
											{tedi.displayName ?? tedi.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</label>
						<label className="grid gap-1 text-sm">
							Project
							<Select
								value={projectId}
								onValueChange={(value) => value && setProjectId(value)}
							>
								<SelectTrigger aria-label="Repository work project">
									<SelectValue placeholder="Choose a linked project" />
								</SelectTrigger>
								<SelectContent>
									{linkedProjects.map((project) => (
										<SelectItem key={project.id} value={project.id}>
											{project.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</label>
						<label className="grid gap-1 text-sm">
							Task
							<Textarea
								aria-label="Repository work task"
								rows={3}
								maxLength={200}
								value={task}
								onChange={(event) => setTask(event.target.value)}
							/>
						</label>
						<label className="grid gap-1 text-sm">
							Done when
							<Textarea
								aria-label="Repository work outcome"
								rows={3}
								maxLength={2000}
								value={outcome}
								onChange={(event) => setOutcome(event.target.value)}
							/>
						</label>
						{eligibleTedis.length === 0 ? (
							<Text role="body" tone="error">
								No active tedi has matching GitHub App authority for this exact
								repository and installation.
							</Text>
						) : null}
						{linkedProjects.length === 0 ? (
							<Text role="body" tone="error">
								Link an active Work project before starting repository work.
							</Text>
						) : null}
						{startRepositoryWork.isError ? (
							<Text role="body" tone="error">
								{startRepositoryWork.error.message}
							</Text>
						) : null}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRepositoryAction(null)}>
							Cancel
						</Button>
						<Button
							disabled={
								startRepositoryWork.isPending ||
								!tediId ||
								!projectId ||
								!task.trim() ||
								!outcome.trim()
							}
							onClick={() => startRepositoryWork.mutate()}
						>
							{startRepositoryWork.isPending
								? "Starting…"
								: "Create and dispatch"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog open={calendarOpen} onOpenChange={setCalendarOpen}>
				<DialogContent size="base">
					<DialogHeader>
						<DialogTitle>Choose a calendar</DialogTitle>
						<DialogDescription>
							Select an account and a calendar it can actually read.
						</DialogDescription>
					</DialogHeader>
					<CalendarResourcePicker
						disabled={attachCalendar.isPending}
						onSelect={(choice) => attachCalendar.mutate(choice)}
					/>
					{attachCalendar.isError && (
						<Text as="p" tone="error">
							{attachCalendar.error.message}
						</Text>
					)}
				</DialogContent>
			</Dialog>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent size="base">
					<DialogHeader>
						<DialogTitle>Attach resource</DialogTitle>
						<DialogDescription>
							Choose an app and add the resource you want to use. Workers still
							need permission and approval before using it.
						</DialogDescription>
					</DialogHeader>
					<form
						className="grid gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void form.handleSubmit();
						}}
					>
						<FormField form={form} name="providerKey" label="Connected app">
							{(field, meta) => (
								<FormSelect
									field={field}
									{...meta}
									placeholder="Choose a connected app"
									items={connections.map((connection) => ({
										value: `${connection.appId}:${connection.tokenScope}:${connection.connectionInstanceId ?? ""}`,
										label: `${connection.providerName} · ${connection.instanceLabel ?? (connection.tokenScope === "tenant" ? "Shared account" : "Your account")}`,
									}))}
								>
									{connections.map((connection) => (
										<SelectItem
											key={`${connection.appId}:${connection.tokenScope}:${connection.connectionInstanceId ?? ""}`}
											value={`${connection.appId}:${connection.tokenScope}:${connection.connectionInstanceId ?? ""}`}
										>
											{connection.providerName} ·{" "}
											{connection.instanceLabel ??
												(connection.tokenScope === "tenant"
													? "Shared account"
													: "Your account")}
										</SelectItem>
									))}
								</FormSelect>
							)}
						</FormField>
						{connectionsQuery.isSuccess && connections.length === 0 ? (
							<Text as="p" role="label" tone="secondary" className="m-0">
								No connected apps are available. Connect one in{" "}
								<a
									className="text-kumo-link underline"
									href="/admin/connections"
								>
									Connections
								</a>{" "}
								first.
							</Text>
						) : null}
						<FormField
							form={form}
							name="resourceType"
							label="What are you attaching?"
						>
							{(field, meta) =>
								customType ? (
									<div className="grid gap-2">
										<FormInput
											field={field}
											{...meta}
											placeholder="Type supplied by the app"
										/>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => {
												setCustomType(false);
												field.handleChange("");
											}}
										>
											Choose a common type
										</Button>
									</div>
								) : (
									<Select
										items={[
											{ value: "document", label: "Document" },
											{ value: "spreadsheet", label: "Spreadsheet" },
											{ value: "repository", label: "Code repository" },
											{ value: "research_account", label: "Research account" },
											{ value: "custom", label: "Other resource" },
										]}
										value={field.state.value}
										onValueChange={(value) => {
											form.setFieldValue("githubFullName", "");
											form.setFieldValue("githubInstallationId", "");
											if (value === "custom") {
												setCustomType(true);
												field.handleChange("");
											} else field.handleChange(value ?? "");
										}}
									>
										<SelectTrigger
											id={meta.id}
											aria-labelledby={`${meta.id}-label`}
											aria-describedby={meta.errorId}
											aria-invalid={meta.invalid || undefined}
										>
											<SelectValue placeholder="Choose a resource type" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="document">Document</SelectItem>
											<SelectItem value="spreadsheet">Spreadsheet</SelectItem>
											<SelectItem value="repository">
												Code repository
											</SelectItem>
											<SelectItem value="research_account">
												Research account
											</SelectItem>
											<SelectItem value="custom">Other resource</SelectItem>
										</SelectContent>
									</Select>
								)
							}
						</FormField>
						<FormField
							form={form}
							name="providerResourceId"
							label="Resource ID"
							description="Copy the resource’s ID from the connected app. A name or web address cannot replace it."
						>
							{(field, meta) => (
								<FormInput
									field={field}
									{...meta}
									placeholder="ID from the app"
								/>
							)}
						</FormField>
						<form.Subscribe
							selector={(state) => [
								state.values.providerKey,
								state.values.resourceType,
							]}
						>
							{([providerKey, resourceType]) =>
								providerKey?.startsWith("github:") &&
								resourceType === "repository" ? (
									<details className="grid gap-3 type-tedix-control">
										<summary className="cursor-pointer">
											Repository work setup (optional)
										</summary>
										<Text as="p" role="label" tone="secondary">
											To start repository work, add both values from your GitHub
											App settings.
										</Text>
										<FormField
											form={form}
											name="githubFullName"
											label="Repository name"
										>
											{(field, meta) => (
												<FormInput
													field={field}
													{...meta}
													placeholder="tedix-hq/tedix"
												/>
											)}
										</FormField>
										<FormField
											form={form}
											name="githubInstallationId"
											label="GitHub App installation ID"
										>
											{(field, meta) => (
												<FormInput
													field={field}
													{...meta}
													inputMode="numeric"
												/>
											)}
										</FormField>
									</details>
								) : null
							}
						</form.Subscribe>
						<FormField form={form} name="name" label="Name in this workspace">
							{(field, meta) => (
								<FormInput
									field={field}
									{...meta}
									placeholder="e.g. Research account"
								/>
							)}
						</FormField>
						{create.isError ? (
							<Text as="p" role="body" tone="error" className="m-0">
								The resource could not be attached.
							</Text>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={create.isPending}>
								Attach resource
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</section>
	);
}
