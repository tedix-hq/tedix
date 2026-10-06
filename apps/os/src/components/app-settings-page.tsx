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
import { Check, Copy, Key, Trash } from "@phosphor-icons/react";
import { lazy, Suspense, useState } from "react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { FormField } from "@/components/kumo/forms/form-field";
import { exactConfirmationSchema } from "@/components/kumo/forms/exact-confirmation-schema";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Input } from "@/components/kumo/input";
import { SelectItem } from "@/components/kumo/select";
import { Separator } from "@/components/kumo/separator";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { SettingsSectionNavigation } from "@/components/settings-section-navigation";
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
import { relativeTime } from "@/lib/time";

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

function SectionSkeleton() {
	return <Skeleton className="h-24 w-full rounded-lg" />;
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
			<div
				aria-busy="true"
				aria-label="Loading app settings"
				className="grid gap-4"
			>
				<SectionSkeleton />
				<SectionSkeleton />
				<SectionSkeleton />
			</div>
		);
	}
	if (detail.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>App settings are unavailable</AlertTitle>
				<AlertDescription>{(detail.error as Error).message}</AlertDescription>
			</Alert>
		);
	}
	if (!app) return null;

	return (
		<div className="space-y-6 pb-1">
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
			<Separator />
			<div id="app-settings-mcp" className="scroll-mt-24 space-y-6">
				<McpConfigDisplay app={app} />
				<Suspense fallback={<SectionSkeleton />}>
					<McpOAuthSettings
						appId={appId}
						mcpConfig={app.metadata?.mcpConfig}
						tools={tools}
						metadata={app.metadata}
						canManage={canManage}
					/>
				</Suspense>
			</div>
			<Separator />
			<div id="app-settings-tedis" className="scroll-mt-24">
				<Suspense fallback={<SectionSkeleton />}>
					<AppTediAssignments appId={appId} />
				</Suspense>
			</div>
			<Separator />
			<div id="app-settings-secrets" className="scroll-mt-24">
				<SecretsSection appId={appId} />
			</div>
			<Separator />
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
		<Card>
			<CardHeader>
				<CardTitle>App Details</CardTitle>
			</CardHeader>
			<CardContent>
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

					<FormField
						form={form}
						name="description"
						label="Description"
						optional
					>
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
							label="Primary Domain"
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
									: "Save Changes"}
							</Button>
						)}
					</form.Subscribe>
				</form>
			</CardContent>
		</Card>
	);
}

// =============================================================================
// MCP CONFIG DISPLAY
// =============================================================================

function McpConfigDisplay({ app }: { app: App }) {
	const mcpConfig = app.metadata?.mcpConfig;
	const endpoint = mcpEndpointUrl(app);
	const [copied, setCopied] = useState(false);

	const handleCopyEndpoint = async () => {
		try {
			await navigator.clipboard.writeText(endpoint);
			setCopied(true);
			toast.success("Endpoint copied to clipboard");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Failed to copy");
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>MCP Configuration</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="grid gap-3 text-sm">
					<div className="flex min-w-0 justify-between gap-3">
						<Text as="span" role="body" tone="secondary" className="shrink-0">
							Endpoint
						</Text>
						<span className="flex min-w-0 items-center gap-1.5">
							<Text
								as="span"
								role="body"
								tone="mono"
								className="min-w-0 truncate"
							>
								{endpoint}
							</Text>
							<Button
								type="button"
								onClick={handleCopyEndpoint}
								variant="ghost"
								size="icon-xs"
								className="shrink-0 text-kumo-subtle"
								aria-label="Copy endpoint"
								icon={
									copied ? (
										<Check size={14} className="text-kumo-success" />
									) : (
										<Copy size={14} />
									)
								}
							/>
						</span>
					</div>
					<div className="flex justify-between">
						<Text as="span" role="body" tone="secondary">
							Server Name
						</Text>
						<span>{mcpConfig?.serverName ?? "Tedix MCP"}</span>
					</div>
					<div className="flex justify-between">
						<Text as="span" role="body" tone="secondary">
							Auth Mode
						</Text>
						<Badge variant="outline">{mcpConfig?.authMode ?? "public"}</Badge>
					</div>
					<div className="flex justify-between">
						<Text as="span" role="body" tone="secondary">
							Tool Timeout
						</Text>
						<span>{mcpConfig?.toolTimeout ?? 30000}ms</span>
					</div>
				</div>
			</CardContent>
		</Card>
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

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Key size={16} aria-hidden className="text-kumo-subtle" />
				<Text as="h3" role="section" weight="semibold" className="m-0">
					Secrets
				</Text>
			</div>

			{secrets.isPending && <SectionSkeleton />}
			{secrets.isError && (
				<Alert variant="destructive">
					<AlertTitle>Secrets are unavailable</AlertTitle>
					<AlertDescription>
						{(secrets.error as Error).message}
					</AlertDescription>
				</Alert>
			)}

			{secrets.data && secretRows.length === 0 && (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Key size={20} />
						</EmptyMedia>
						<EmptyTitle>No secrets configured</EmptyTitle>
						<EmptyDescription>
							No secrets configured for this app.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}

			{secretRows.length > 0 && (
				<div className="space-y-2">
					{secretRows.map((secret) => (
						<SecretRow
							key={secret.id}
							secret={secret}
							appId={appId}
							canManage={canManageSecrets}
						/>
					))}
				</div>
			)}
		</div>
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
		<Card>
			<CardContent className="flex flex-col gap-3 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0">
					<Text as="span" role="body" tone="mono">
						{secret.name}
					</Text>
					{secret.hint && (
						<Text as="span" role="label" tone="secondary" className="ml-2">
							({secret.hint})
						</Text>
					)}
					<Text as="p" role="label" tone="secondary" className="m-0">
						Added {relativeTime(secret.createdAt)}
					</Text>
				</div>
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
			</CardContent>
		</Card>
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
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete app",
			);
		},
	});
	const confirmationForm = useZodForm({
		schema: exactConfirmationSchema(appName, "App name"),
		defaultValues: { confirmation: "" },
		onSubmit: () => deleteMutation.mutate(),
	});

	return (
		<Card id="app-danger-zone" tabIndex={-1}>
			<CardHeader>
				<CardTitle className="text-kumo-danger">Danger Zone</CardTitle>
			</CardHeader>
			<CardContent>
				<Text as="p" role="body" tone="secondary" className="mb-4">
					Permanently delete this app and all associated data (tools, adapters,
					content, analytics).
				</Text>
				<Dialog
					open={open}
					onOpenChange={(nextOpen) => {
						setOpen(nextOpen);
						if (!nextOpen) confirmationForm.reset();
					}}
				>
					<Button
						variant="destructive"
						size="sm"
						disabled={!canManage}
						title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
						onClick={() => {
							confirmationForm.reset();
							setOpen(true);
						}}
					>
						Delete App
					</Button>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Delete {appName}?</DialogTitle>
							<DialogDescription>
								This action cannot be undone. Type the app name to confirm.
							</DialogDescription>
						</DialogHeader>
						<form
							className="space-y-4 pt-2"
							onSubmit={(event) => {
								event.preventDefault();
								void confirmationForm.handleSubmit();
							}}
						>
							<FormField
								form={confirmationForm}
								name="confirmation"
								label={`Type ${appName} to confirm deletion`}
							>
								{(field, meta) => (
									<FormInput field={field} {...meta} placeholder={appName} />
								)}
							</FormField>
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => setOpen(false)}
								>
									Cancel
								</Button>
								<confirmationForm.Subscribe
									selector={(state) => state.canSubmit}
								>
									{(canSubmit) => (
										<Button
											type="submit"
											variant="destructive"
											disabled={!canSubmit || deleteMutation.isPending}
										>
											{deleteMutation.isPending
												? "Deleting..."
												: "Delete Forever"}
										</Button>
									)}
								</confirmationForm.Subscribe>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			</CardContent>
		</Card>
	);
}
