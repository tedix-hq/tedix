/**
 * /apps/$appId/settings — app configuration: details form (with logo upload), MCP config
 * display, MCP OAuth settings, tedi assignments, secrets, and the
 * name-confirmed danger zone.
 *
 * The app record reads through the ONE generated entry
 * (`apps.getByIdWithTools`); every `apps.update` invalidates the apps domain
 * so the layout header and sibling tabs converge.
 *
 * Write affordances mirror the server gates: `apps:update` for the form and
 * MCP settings, `secrets:manage` for secret deletion. The delete additionally
 * requires an exact app-name confirmation in the danger zone.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { App } from "@tedix/api-contract/schemas/app";
import { Key, Trash } from "@phosphor-icons/react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { toast } from "@/components/kumo/toast";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { AppGatewayMembership } from "@/components/app-gateway-membership";
import { AppImageUpload } from "@/components/app-image-upload";
import { mcpEndpointUrl } from "@/components/app-detail";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/kumo/alert-dialog";
import { LoadError } from "@/components/kumo/alert";
import {
	AppTabTable,
	AppTabHeader,
	AppTabSection,
	AppTabLoading,
	AppTabEmpty,
	AppTabError,
	AppTabDate,
} from "./app-detail-tab-shared";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { TableCell, TableHead, TableRow } from "@/components/kumo/table";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { SelectItem } from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { SettingsSectionNavigation } from "@/components/settings-section-navigation";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { osApi } from "@/lib/api";
import {
	APPS_MANAGE_DENIED_REASON,
	SECRETS_MANAGE_DENIED_REASON,
	useCanManageApps,
	useCanManageSecrets,
} from "@/lib/app-permissions";
import {
	appDetailQueryOptions,
	appSecretsListQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";

const McpOAuthSettings = lazy(() =>
	import("@/components/app-mcp-oauth-settings").then((mod) => ({
		default: mod.McpOAuthSettings,
	})),
);

const AppTediAssignments = lazy(() =>
	import("@/components/app-tedi-assignments").then((mod) => ({
		default: mod.AppTediAssignments,
	})),
);

const AppAggregatedTedis = lazy(() =>
	import("@/components/app-aggregated-tedis").then((mod) => ({
		default: mod.AppAggregatedTedis,
	})),
);

/** A Code Mode gateway (or an app already exposing tedis) can expose tedis. */
function isGatewayApp(app: App): boolean {
	const mcpConfig = app.metadata?.mcpConfig as
		| { codeMode?: unknown; aggregateTedis?: unknown }
		| undefined;
	return (
		mcpConfig?.codeMode === true || Array.isArray(mcpConfig?.aggregateTedis)
	);
}

const APP_SETTINGS_SECTION_ITEMS = [
	["Gateway", "app-settings-gateway"],
	["Details", "app-settings-details"],
	["MCP & access", "app-settings-mcp"],
	["Tedis", "app-settings-tedis"],
	["Secrets", "app-settings-secrets"],
	["Danger", "app-settings-danger"],
] as const;

// =============================================================================
// MAIN PAGE
// =============================================================================

export function AppSettingsPage() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";
	const canManage = useCanManageApps();

	const detail = useQuery({
		...appDetailQueryOptions(appId),
		enabled: appId.length > 0,
	});
	const app = detail.data?.app ?? null;
	const tools = detail.data?.tools ?? [];

	if (detail.isPending) {
		return (
			<AppTabSection title="Settings">
				<AppTabLoading label="Loading app settings" />
			</AppTabSection>
		);
	}
	if (detail.isError && !detail.data) {
		return (
			<AppTabSection title="Settings">
				<AppTabError title="App settings are unavailable" query={detail}>
					{errorMessage(detail.error, "The app settings could not be read.")}
				</AppTabError>
			</AppTabSection>
		);
	}
	if (!app) return null;

	return (
		<div className="space-y-6 pb-1">
			<AppTabHeader
				title="Settings"
				description="Manage this app, access and secrets."
			/>
			{detail.isError ? (
				<StaleReadNotice
					title="App settings could not be refreshed"
					error={detail.error}
					query={detail}
					before="Showing the settings last loaded"
					after="— they may be out of date."
				/>
			) : null}
			<SettingsSectionNavigation
				ariaLabel="App settings sections"
				items={APP_SETTINGS_SECTION_ITEMS}
			/>
			<div id="app-settings-gateway" className="scroll-mt-24">
				<AppGatewayMembership appId={appId} canManage={canManage} />
			</div>
			<div id="app-settings-details" className="scroll-mt-24">
				<AppDetailsForm app={app} canManage={canManage} />
			</div>
			<div id="app-settings-mcp" className="scroll-mt-24 space-y-6">
				<McpConfigDisplay app={app} />
				<Suspense fallback={<Skeleton className="h-24 w-full" />}>
					<McpOAuthSettings
						appId={appId}
						mcpConfig={app.metadata?.mcpConfig}
						tools={tools}
						metadata={app.metadata}
						canManage={canManage}
					/>
				</Suspense>
			</div>
			<div id="app-settings-tedis" className="scroll-mt-24 space-y-6">
				<Suspense fallback={<Skeleton className="h-24 w-full" />}>
					<AppTediAssignments appId={appId} />
				</Suspense>
				{isGatewayApp(app) ? (
					<Suspense fallback={<Skeleton className="h-24 w-full" />}>
						<AppAggregatedTedis app={app} canManage={canManage} />
					</Suspense>
				) : null}
			</div>
			<div id="app-settings-secrets" className="scroll-mt-24">
				<SecretsSection appId={appId} />
			</div>
			<div id="app-settings-danger" className="scroll-mt-24">
				<DangerZone appId={appId} appName={app.name} canManage={canManage} />
			</div>
		</div>
	);
}

// =============================================================================
// APP DETAILS FORM
// =============================================================================

const UpdateAppSchema = z.object({
	name: z.string().min(1, "Name is required").max(100),
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
			"Lowercase alphanumeric with hyphens",
		),
	description: z.string().max(500).optional().or(z.literal("")),
	primaryDomain: z.string().optional().or(z.literal("")),
	visibility: z.enum(["public", "private", "disabled"]),
});

function AppDetailsForm({ app, canManage }: { app: App; canManage: boolean }) {
	const queryClient = useQueryClient();

	const updateMutation = useMutation({
		mutationFn: (values: z.infer<typeof UpdateAppSchema>) =>
			osApi.apps.update({
				appId: app.id,
				name: values.name,
				slug: values.slug,
				description: values.description || null,
				primaryDomain: values.primaryDomain || null,
				visibility: values.visibility,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
			toast.success("App updated");
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to update app",
			);
		},
	});

	const form = useZodForm({
		schema: UpdateAppSchema,
		defaultValues: {
			name: app.name,
			slug: app.slug,
			description: app.description ?? "",
			primaryDomain: app.primaryDomain ?? "",
			visibility: (app.visibility ?? "private") as
				| "public"
				| "private"
				| "disabled",
		},
		onSubmit: ({ value }) => {
			updateMutation.mutate(value);
		},
	});

	return (
		<AppTabSection title="App details">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					form.handleSubmit();
				}}
				className="space-y-4"
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<FormField form={form} name="name" label="Name">
						{(field, meta) => (
							<FormInput
								field={field}
								id={meta.id}
								descriptionId={meta.descriptionId}
								errorId={meta.errorId}
								placeholder="My App"
								disabled={!canManage}
							/>
						)}
					</FormField>

					<FormField form={form} name="slug" label="Slug">
						{(field, meta) => (
							<FormInput
								field={field}
								id={meta.id}
								descriptionId={meta.descriptionId}
								errorId={meta.errorId}
								placeholder="my-app"
								disabled={!canManage}
							/>
						)}
					</FormField>
				</div>

				<FormField form={form} name="description" label="Description" optional>
					{(field, meta) => (
						<FormTextarea
							field={field}
							id={meta.id}
							descriptionId={meta.descriptionId}
							errorId={meta.errorId}
							placeholder="What this app does..."
							rows={2}
							disabled={!canManage}
						/>
					)}
				</FormField>

				<div className="grid gap-4 sm:grid-cols-2">
					<FormField
						form={form}
						name="primaryDomain"
						label="Primary domain"
						optional
					>
						{(field, meta) => (
							<FormInput
								field={field}
								id={meta.id}
								descriptionId={meta.descriptionId}
								errorId={meta.errorId}
								placeholder="https://example.com"
								disabled={!canManage}
							/>
						)}
					</FormField>

					<FormField form={form} name="visibility" label="Visibility">
						{(field, meta) => (
							<FormSelect
								field={field}
								id={meta.id}
								descriptionId={meta.descriptionId}
								errorId={meta.errorId}
								placeholder="Select visibility"
								disabled={!canManage}
							>
								<SelectItem value="public">Public</SelectItem>
								<SelectItem value="private">Private</SelectItem>
								<SelectItem value="disabled">Disabled</SelectItem>
							</FormSelect>
						)}
					</FormField>
				</div>

				<div className="space-y-2">
					<Text as="p" role="body" weight="medium" className="m-0">
						Logo
					</Text>
					<AppImageUpload
						appId={app.id}
						currentImageUrl={app.logoUrl}
						fallbackText={app.name}
						disabled={!canManage}
					/>
				</div>

				<form.Subscribe
					selector={(s) => [s.canSubmit, s.isPristine, s.isSubmitting]}
				>
					{([canSubmit, isPristine, isSubmitting]) => (
						<Button
							type="submit"
							disabled={
								!canManage ||
								!canSubmit ||
								isPristine ||
								updateMutation.isPending
							}
							title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
						>
							{isSubmitting || updateMutation.isPending
								? "Saving..."
								: "Save changes"}
						</Button>
					)}
				</form.Subscribe>
			</form>
		</AppTabSection>
	);
}

// =============================================================================
// MCP CONFIG DISPLAY
// =============================================================================

function McpConfigRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 justify-between gap-3">
			<Text as="span" role="body" tone="secondary" className="shrink-0">
				{label}
			</Text>
			{children}
		</div>
	);
}

function McpConfigDisplay({ app }: { app: App }) {
	const mcpConfig = app.metadata?.mcpConfig;
	const endpoint = mcpEndpointUrl(app);

	return (
		<AppTabSection title="Connection">
			<div className="grid gap-3 text-sm">
				<McpConfigRow label="Endpoint">
					<ClipboardText text={endpoint} className="min-w-0 max-w-full" />
				</McpConfigRow>
				<McpConfigRow label="Server name">
					<span className="min-w-0 wrap-anywhere text-right">
						{mcpConfig?.serverName ?? "Tedix MCP"}
					</span>
				</McpConfigRow>
				<McpConfigRow label="Access mode">
					<Badge variant="outline" className="shrink-0">
						{mcpConfig?.authMode ?? "public"}
					</Badge>
				</McpConfigRow>
				<McpConfigRow label="Tool timeout">
					<span className="min-w-0 wrap-anywhere text-right">
						{mcpConfig?.toolTimeout ?? 30000}ms
					</span>
				</McpConfigRow>
			</div>
		</AppTabSection>
	);
}

// =============================================================================
// STALE READ NOTICE
// =============================================================================

type StaleReadQuery = {
	isFetching: boolean;
	dataUpdatedAt: number;
	refetch: () => Promise<unknown>;
};

/**
 * A failed refresh keeps the last cached read on screen, marked with when it
 * loaded — the rows are no longer verified current and a cold failure would
 * have nothing to show. `before`/`after` bracket the load timestamp.
 */
function StaleReadNotice({
	title,
	error,
	query,
	before,
	after,
}: {
	title: string;
	error: unknown;
	query: StaleReadQuery;
	before: ReactNode;
	after?: ReactNode;
}) {
	return (
		<LoadError
			title={title}
			error={error}
			onRetry={() => query.refetch()}
			retrying={query.isFetching}
			help={
				<>
					{before}{" "}
					<AppTabDate value={new Date(query.dataUpdatedAt).toISOString()} />
					{after ? ` ${after}` : null}
				</>
			}
		/>
	);
}

// =============================================================================
// SECRETS SECTION
// =============================================================================

function SecretsSection({ appId }: { appId: string }) {
	const canManageSecrets = useCanManageSecrets();
	const secrets = useQuery({
		...appSecretsListQueryOptions(appId),
		enabled: appId.length > 0,
		staleTime: 30_000,
	});
	const secretRows = secrets.data?.data ?? [];
	const secretsStale = secrets.isError && secrets.data != null;

	return (
		<AppTabSection title="Secrets">
			{secrets.isPending && <AppTabLoading label="Loading secrets" />}
			{secrets.isError && !secrets.data && (
				<AppTabError title="Secrets are unavailable" query={secrets}>
					{errorMessage(secrets.error, "The secrets could not be read.")}
				</AppTabError>
			)}
			{secretsStale && (
				<StaleReadNotice
					title="Secrets could not be refreshed"
					error={secrets.error}
					query={secrets}
					before={
						secretRows.length
							? "Showing the secrets last loaded"
							: "No secrets were configured as of"
					}
					after={
						secretRows.length
							? "— they may be out of date."
							: "— that is not confirmed now."
					}
				/>
			)}
			{secrets.data && !secretsStale && secretRows.length === 0 && (
				<AppTabEmpty
					icon={<Key size={20} />}
					title="No secrets configured"
					description="No secrets configured for this app."
				/>
			)}

			{secretRows.length > 0 && (
				<AppTabTable
					label="App secrets"
					headings={
						<>
							<TableHead>Secret</TableHead>
							<TableHead>Added</TableHead>
							<TableHead className="text-right">
								<span className="sr-only">Actions</span>
							</TableHead>
						</>
					}
				>
					{secretRows.map((secret) => (
						<SecretRow
							key={secret.id}
							secret={secret}
							appId={appId}
							canManage={canManageSecrets}
						/>
					))}
				</AppTabTable>
			)}
		</AppTabSection>
	);
}

function SecretRow({
	secret,
	appId,
	canManage,
}: {
	secret: {
		id: string;
		name: string;
		hint: string | null;
		createdAt: string;
	};
	appId: string;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const listKey = appSecretsListQueryOptions(appId).queryKey;

	const deleteMutation = useMutation({
		mutationFn: () => osApi.appSecrets.delete({ appId, secretId: secret.id }),
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey: osQueryKeys.appSecrets() });
			const previous = queryClient.getQueryData(listKey);
			queryClient.setQueryData(listKey, (old) =>
				old
					? { ...old, data: old.data.filter((row) => row.id !== secret.id) }
					: old,
			);
			return { previous };
		},
		onError: (_error, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(listKey, context.previous);
			}
			toast.error("Failed to delete secret");
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.appSecrets() });
		},
		onSuccess: () => {
			toast.success("Secret deleted");
		},
	});

	return (
		<TableRow>
			<TableCell className="whitespace-normal break-all">
				<div className="min-w-0">
					<Text as="span" role="body" tone="mono">
						{secret.name}
					</Text>
					{secret.hint && (
						<Text as="span" role="label" tone="secondary" className="ml-2">
							({secret.hint})
						</Text>
					)}
				</div>
			</TableCell>
			<TableCell>
				<AppTabDate value={secret.createdAt} />
			</TableCell>
			<TableCell className="text-right">
				<AlertDialog>
					<AlertDialogTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								className="self-end text-kumo-danger hover:text-kumo-danger sm:self-auto"
								disabled={!canManage || deleteMutation.isPending}
								title={canManage ? undefined : SECRETS_MANAGE_DENIED_REASON}
								aria-label={`Delete secret ${secret.name}`}
								icon={<Trash size={14} />}
							/>
						}
					/>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete {secret.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								Requests that depend on this secret may stop working. This
								action cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								disabled={deleteMutation.isPending}
								onClick={() => deleteMutation.mutate()}
							>
								{deleteMutation.isPending ? "Deleting..." : "Delete secret"}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}

// =============================================================================
// DANGER ZONE
// =============================================================================

function DangerZone({
	appId,
	appName,
	canManage,
}: {
	appId: string;
	appName: string;
	canManage: boolean;
}) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const deleteMutation = useMutation({
		mutationFn: () => osApi.apps.delete({ appId }),
		onSuccess: () => {
			toast.success("App deleted");
			// The deleted app is gone from the list and detail entries alike.
			queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
			navigate({ to: "/apps" });
		},
	});

	return (
		<Card id="app-danger-zone" tabIndex={-1}>
			<CardHeader>
				<CardTitle className="text-kumo-danger">Delete app</CardTitle>
			</CardHeader>
			<CardContent>
				<Text as="p" role="body" tone="secondary" className="mb-4">
					Permanently delete this app and all associated data (tools, adapters,
					content, analytics).
				</Text>
				<Button
					variant="destructive"
					size="sm"
					disabled={!canManage}
					title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
					onClick={() => setOpen(true)}
				>
					Delete app
				</Button>
				<TypedConfirmDialog
					open={open}
					onOpenChange={(nextOpen) => {
						if (!nextOpen) deleteMutation.reset();
						setOpen(nextOpen);
					}}
					title={`Delete ${appName}?`}
					description="This action cannot be undone. Type the app name to confirm."
					expectedName={appName}
					nameLabel="App name"
					confirmLabel="Delete forever"
					pendingLabel="Deleting…"
					destructive
					isPending={deleteMutation.isPending}
					error={deleteMutation.error}
					onConfirm={() => deleteMutation.mutate()}
				/>
			</CardContent>
		</Card>
	);
}
