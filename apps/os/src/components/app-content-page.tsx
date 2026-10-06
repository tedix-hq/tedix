/**
 * /apps/$appId/content — content-source ingestion management.
 *
 * The source list refetches every 30s while mounted so ingest status
 * transitions land without a reload; a pending→success/failed transition is
 * surfaced as a toast. Source removal is optimistic on the generated key.
 * The sync interval is a field of `app.metadata.contentConfig`, written
 * through `apps.update` and read back through the one app-record entry
 * (`apps.getByIdWithTools`).
 *
 * Write affordances render disabled without `apps:update` — mirroring the
 * server's `AUTHZ.appsWrite` gates, never replacing them.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { AppMetadata } from "@tedix/api-contract/schemas/app";
import { ArrowsClockwise, FileText, Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/kumo/toast";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
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
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/kumo/dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Loader } from "@/components/kumo/loader";
import {
	Collection,
	PageActions,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	KumoSelect,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { osApi } from "@/lib/api";
import {
	APPS_MANAGE_DENIED_REASON,
	useCanManageApps,
} from "@/lib/app-permissions";
import {
	appDetailQueryOptions,
	contentSourcesQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { relativeTime } from "@/lib/time";

type SyncInterval = "daily" | "weekly" | "monthly" | "disabled";

const STATUS_BADGE: Record<string, { variant: BadgeVariant; label: string }> = {
	pending: { variant: "outline", label: "Pending" },
	success: { variant: "success", label: "Synced" },
	failed: { variant: "destructive", label: "Failed" },
	stale: { variant: "secondary", label: "Stale" },
};

interface SourceRowData {
	id: string;
	sourceType: string;
	sourceUrl: string;
	title: string | null;
	lastIngestedAt: string | null;
	lastIngestStatus: string | null;
	documentCount: number | null;
	lastError: string | null;
}

export function AppContentPage() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";
	const queryClient = useQueryClient();
	const canManage = useCanManageApps();

	const detail = useQuery({
		...appDetailQueryOptions(appId),
		enabled: appId.length > 0,
		staleTime: 60_000,
	});
	const app = detail.data?.app ?? null;
	const metadata: AppMetadata | null = app?.metadata ?? null;
	const syncInterval: SyncInterval =
		metadata?.contentConfig?.syncInterval ?? "disabled";

	const syncIntervalMutation = useMutation({
		mutationFn: (value: SyncInterval) =>
			osApi.apps.update({
				appId,
				metadata: {
					...metadata,
					contentConfig: {
						...metadata?.contentConfig,
						syncInterval: value,
					},
				},
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
			toast.success("Sync interval updated");
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update sync interval",
			);
		},
	});

	const sources = useQuery({
		...contentSourcesQueryOptions(appId),
		enabled: appId.length > 0,
		staleTime: 30_000,
		refetchInterval: 30_000,
	});
	const sourceRows = sources.data?.sources ?? [];

	// Track status transitions to notify on ingestion completion. Only
	// transitions FROM "pending" toast — the initial load stays silent.
	const prevStatusRef = useRef<Map<string, string | null>>(new Map());
	useEffect(() => {
		const prev = prevStatusRef.current;
		for (const source of sourceRows) {
			const prevStatus = prev.get(source.id);
			if (prevStatus === "pending" && source.lastIngestStatus === "success") {
				toast.success(
					`"${source.title || source.sourceUrl}" synced successfully (${source.documentCount ?? 0} sections)`,
				);
			} else if (
				prevStatus === "pending" &&
				source.lastIngestStatus === "failed"
			) {
				toast.error(
					`"${source.title || source.sourceUrl}" ingestion failed: ${source.lastError ?? "Unknown error"}`,
				);
			}
		}
		const next = new Map<string, string | null>();
		for (const source of sourceRows) {
			next.set(source.id, source.lastIngestStatus);
		}
		prevStatusRef.current = next;
	}, [sourceRows]);

	const ingestAllMutation = useMutation({
		mutationFn: () => osApi.content.ingestAll({ appId }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appContentSources(),
			});
			toast.success("Re-ingestion started for all sources");
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to start ingestion",
			);
		},
	});

	return (
		<PageSection aria-labelledby="app-content-sources-title">
			<SectionHeader>
				<SectionHeading>
					<span className="flex flex-wrap items-center gap-2">
						<SectionTitle id="app-content-sources-title">
							Content sources
						</SectionTitle>
						<Badge variant="secondary">
							{sources.data ? sourceRows.length : "—"}
						</Badge>
					</span>
					<SectionDescription>
						Sources ingested into this app's governed content index.
					</SectionDescription>
				</SectionHeading>
				<PageActions>
					<span title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}>
						<KumoSelect<SyncInterval>
							value={syncInterval}
							onValueChange={(value) => {
								if (value) syncIntervalMutation.mutate(value as SyncInterval);
							}}
							disabled={
								!canManage ||
								!detail.isSuccess ||
								syncIntervalMutation.isPending
							}
							aria-label="Content sync interval"
							className="w-full sm:w-[130px]"
							size="sm"
							items={{
								daily: "Daily",
								weekly: "Weekly",
								monthly: "Monthly",
								disabled: "Manual only",
							}}
						/>
					</span>
					{sourceRows.length > 0 && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => ingestAllMutation.mutate()}
							disabled={!canManage || ingestAllMutation.isPending}
							title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
							icon={
								ingestAllMutation.isPending ? (
									<Loader aria-label="Syncing" size={14} />
								) : (
									<ArrowsClockwise size={14} />
								)
							}
						>
							Sync all
						</Button>
					)}
					<AddSourceDialog appId={appId} canManage={canManage} />
				</PageActions>
			</SectionHeader>

			{detail.isPending ? (
				<p role="status" className="m-0 text-kumo-subtle text-sm">
					Loading content settings...
				</p>
			) : detail.isError ? (
				<p role="alert" className="m-0 text-kumo-danger text-sm">
					Content settings could not be loaded. Sync scheduling is unavailable.
				</p>
			) : null}

			{sources.isPending && <ListSkeleton />}
			{sources.isError && (
				<Alert variant="destructive">
					<AlertTitle>Content sources are unavailable</AlertTitle>
					<AlertDescription>
						{(sources.error as Error).message}
					</AlertDescription>
				</Alert>
			)}

			{sources.data && sourceRows.length === 0 && (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FileText size={20} />
						</EmptyMedia>
						<EmptyTitle>No content sources yet</EmptyTitle>
						<EmptyDescription>
							Add one to start ingesting content.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<AddSourceDialog
							appId={appId}
							canManage={canManage}
							buttonVariant="outline"
						/>
					</EmptyContent>
				</Empty>
			)}

			{sourceRows.length > 0 && (
				<Collection>
					{sourceRows.map((source) => (
						<SourceRow
							key={source.id}
							source={source}
							appId={appId}
							canManage={canManage}
						/>
					))}
				</Collection>
			)}
		</PageSection>
	);
}

function SourceRow({
	source,
	appId,
	canManage,
}: {
	source: SourceRowData;
	appId: string;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const listKey = contentSourcesQueryOptions(appId).queryKey;

	const ingestMutation = useMutation({
		mutationFn: () =>
			osApi.content.ingestSource({ appId, sourceId: source.id }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appContentSources(),
			});
			toast.success("Ingestion started");
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to start ingestion",
			);
		},
	});

	const removeMutation = useMutation({
		mutationFn: () =>
			osApi.content.removeSource({ appId, sourceId: source.id }),
		onMutate: async () => {
			await queryClient.cancelQueries({
				queryKey: osQueryKeys.appContentSources(),
			});
			const previous = queryClient.getQueryData(listKey);
			queryClient.setQueryData(listKey, (old) =>
				old
					? {
							...old,
							sources: old.sources.filter((row) => row.id !== source.id),
						}
					: old,
			);
			return { previous };
		},
		onError: (_error, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(listKey, context.previous);
			}
			toast.error("Failed to remove source");
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appContentSources(),
			});
		},
		onSuccess: () => {
			toast.success("Source removed");
		},
	});

	const statusInfo = STATUS_BADGE[source.lastIngestStatus ?? "pending"] ?? {
		variant: "outline" as const,
		label: "Pending",
	};

	return (
		<li className="flex flex-col gap-3 px-4 py-3 transition-colors duration-150 hover:bg-kumo-tint sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Text
						as="span"
						role="body"
						weight="medium"
						className="min-w-0 max-w-full truncate"
					>
						{source.title || source.sourceUrl}
					</Text>
					<Badge variant="outline">{source.sourceType}</Badge>
					<Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
				</div>
				{source.title && (
					<Text
						as="p"
						role="label"
						tone="mono-secondary"
						className="mt-0.5 mb-0 truncate"
					>
						{source.sourceUrl}
					</Text>
				)}
				<div className="mt-1.5 flex items-center gap-3 text-kumo-subtle text-xs">
					{source.documentCount != null && (
						<span>{source.documentCount} sections</span>
					)}
					{source.lastIngestedAt && (
						<span>Last synced {relativeTime(source.lastIngestedAt)}</span>
					)}
				</div>
				{source.lastError && source.lastIngestStatus === "failed" && (
					<Text
						as="p"
						role="label"
						tone="error"
						className="mt-1 mb-0 line-clamp-1"
					>
						{source.lastError}
					</Text>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
				<Button
					variant="ghost"
					size="sm"
					aria-label="Re-ingest source"
					onClick={() => ingestMutation.mutate()}
					disabled={!canManage || ingestMutation.isPending}
					title={canManage ? "Re-ingest" : APPS_MANAGE_DENIED_REASON}
					icon={
						ingestMutation.isPending ? (
							<Loader aria-label="Syncing" size={14} />
						) : (
							<ArrowsClockwise size={14} />
						)
					}
				/>
				<AlertDialog>
					<AlertDialogTrigger
						render={
							<Button
								variant="ghost"
								size="sm"
								className="text-kumo-danger hover:text-kumo-danger"
								aria-label="Remove source"
								disabled={!canManage || removeMutation.isPending}
								title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
								icon={<Trash size={14} />}
							/>
						}
					/>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Remove content source?</AlertDialogTitle>
							<AlertDialogDescription>
								This will remove the source and its ingested content. This
								action cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={() => removeMutation.mutate()}>
								Remove
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		</li>
	);
}

// =============================================================================
// ADD SOURCE DIALOG
// =============================================================================

const AddSourceSchema = z.object({
	sourceUrl: z.string().url("Must be a valid URL"),
	sourceType: z
		.enum(["webpage", "website", "sitemap", "rss", "manual", "pdf"])
		.default("webpage"),
	title: z.string().max(200).optional().or(z.literal("")),
});

function AddSourceDialog({
	appId,
	canManage,
	buttonVariant = "default",
}: {
	appId: string;
	canManage: boolean;
	buttonVariant?: "default" | "outline";
}) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);

	const addMutation = useMutation({
		mutationFn: (values: {
			sourceUrl: string;
			sourceType: "webpage" | "website" | "sitemap" | "rss" | "manual" | "pdf";
			title?: string;
		}) =>
			osApi.content.addSource({
				appId,
				sourceUrl: values.sourceUrl,
				sourceType: values.sourceType,
				title: values.title || undefined,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appContentSources(),
			});
			toast.success("Source added");
			setOpen(false);
			form.reset();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to add source",
			);
		},
	});

	const form = useZodForm({
		schema: AddSourceSchema,
		defaultValues: {
			sourceUrl: "",
			sourceType: "webpage" as const,
			title: "",
		},
		onSubmit: ({ value }) => {
			addMutation.mutate(value);
		},
	});

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button
						variant={buttonVariant}
						size="sm"
						disabled={!canManage}
						title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
						icon={<Plus size={14} />}
					/>
				}
			>
				Add source
			</DialogTrigger>
			<DialogContent size="lg">
				<DialogHeader>
					<DialogTitle>Add content source</DialogTitle>
				</DialogHeader>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						form.handleSubmit();
					}}
					className="space-y-4"
				>
					<FormField form={form} name="sourceUrl" label="URL">
						{(field, meta) => (
							<FormInput
								field={field}
								id={meta.id}
								descriptionId={meta.descriptionId}
								errorId={meta.errorId}
								placeholder="https://docs.example.com"
							/>
						)}
					</FormField>

					<FormField form={form} name="sourceType" label="Source type">
						{(field, meta) => (
							<FormSelect
								field={field}
								id={meta.id}
								descriptionId={meta.descriptionId}
								errorId={meta.errorId}
								placeholder="Select type"
							>
								<SelectItem value="webpage">Webpage</SelectItem>
								<SelectItem value="website">Website</SelectItem>
								<SelectItem value="sitemap">Sitemap</SelectItem>
								<SelectItem value="rss">RSS feed</SelectItem>
								<SelectItem value="manual">Manual</SelectItem>
								<SelectItem value="pdf">PDF</SelectItem>
							</FormSelect>
						)}
					</FormField>

					<FormField form={form} name="title" label="Title" optional>
						{(field, meta) => (
							<FormInput
								field={field}
								id={meta.id}
								descriptionId={meta.descriptionId}
								errorId={meta.errorId}
								placeholder="Documentation"
							/>
						)}
					</FormField>

					{addMutation.isError ? (
						<p role="alert" className="m-0 text-kumo-danger text-sm">
							{addMutation.error.message || "Failed to add source"}
						</p>
					) : null}
					<div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<form.Subscribe selector={(state) => state.canSubmit}>
							{(canSubmit) => (
								<Button
									type="submit"
									disabled={!canSubmit || addMutation.isPending}
								>
									{addMutation.isPending ? "Adding..." : "Add source"}
								</Button>
							)}
						</form.Subscribe>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
