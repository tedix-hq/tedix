import {
	ArrowClockwise,
	CaretDown,
	ClockCounterClockwise,
} from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getOsSurface } from "@/lib/os-navigation";
import { useMemo, useState, useContext } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { Text } from "@/components/kumo/text";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	Collection,
	Page,
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageToolbar,
	PageTitle,
} from "@/components/kumo/page";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Pagination } from "@/components/kumo/pagination";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { KumoTabs } from "@/components/kumo/tabs";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Surface } from "@/components/kumo/surface";
import { osApi } from "@/lib/api";
import {
	AUDIT_ALL_RESOURCES,
	AUDIT_PAGE_SIZE,
	type AuditSearch,
	auditSearchInput,
	isDefaultAuditSearch,
} from "@/lib/audit-search";
import {
	useOsFormattingPreferences,
	formatCount,
	humanize,
	sentenceCase,
} from "@/lib/format";
import { auditSearchQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
} from "@/components/work-actor-avatar";
import type { ActorDirectory } from "@/lib/work-actor";
import { useTediNames } from "@/lib/use-tedi-names";

// ---------------------------------------------------------------------------
// Types (contract-derived — the audit contract exports no schema types)
// ---------------------------------------------------------------------------

/** One immutable org audit event, as `GET /audit` returns it. */
export type AuditEvent = Awaited<
	ReturnType<typeof osApi.audit.search>
>["data"][number];

export type AuditActorType = AuditEvent["actorType"];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Chip tones follow the shared OS governance-tone vocabulary. */
export type ActorTone = "neutral" | "active" | "done" | "warn";

/**
 * Human actors read as active, tedis as first-class workers, external harness
 * agents as noteworthy; kernel/service/machine callers stay neutral — being a
 * machine actor on the audit trail is normal, not a warning.
 */
export function actorTone(actorType: AuditActorType): ActorTone {
	switch (actorType) {
		case "user":
			return "active";
		case "tedi":
			return "done";
		case "external_agent":
			return "warn";
		default:
			return "neutral";
	}
}

export const ACTOR_TONE_BADGE_VARIANTS: Record<ActorTone, BadgeVariant> = {
	neutral: "secondary",
	active: "info",
	done: "success",
	warn: "warning",
};

/** Display names keep internal actor types out of the activity list. */
const ACTOR_TYPE_LABELS: Partial<Record<AuditActorType, string>> = {
	user: "Person",
	external_agent: "Coding assistant",
	kernel: "Tedix",
	api_key: "API key",
	m2m: "M2M",
};

export function auditActionLabel(action: string): string {
	if (action === "home.tool_write" || action === "home_tool_write")
		return "Chat action";
	if (action.split(".").at(-1)?.toLowerCase() === "createmany")
		return "Created multiple records";
	return sentenceCase(action);
}

export function actorTypeLabel(actorType: AuditActorType): string {
	return ACTOR_TYPE_LABELS[actorType] ?? sentenceCase(actorType);
}

/** Names use the shared actor directory; IDs remain diagnostic fields. */
export function actorLabel(
	event: AuditEvent,
	tediNames: Record<string, string> = {},
	directory: ActorDirectory = new Map(),
): string | null {
	if (event.actorType === "anonymous") return null;
	const known = directory.get(`${event.actorType}:${event.actorId}`)?.name;
	if (known) return known;
	if (event.actorType === "tedi")
		return tediNames[event.actorId] ?? "Name unavailable";
	if (event.actorType === "user" || event.actorType === "external_agent")
		return "Name unavailable";
	return event.actorId;
}

function AuditIdentity({
	event,
	tediNames,
}: {
	event: AuditEvent;
	tediNames: Record<string, string>;
}) {
	const directory = useContext(WorkActorDirectoryContext);
	const name = actorLabel(event, tediNames, directory);
	return (
		<span className="inline-flex min-w-0 items-center gap-2">
			{name && (
				<WorkActorAvatar
					actor={{ type: event.actorType, id: event.actorId }}
					name={name}
					detail={`${actorTypeLabel(event.actorType)}: ${event.actorId}`}
					className="max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11"
				/>
			)}
			<span className="min-w-0">
				<AuditActorChip actorType={event.actorType} />
				{name && (
					<Text as="span" role="label" className="block truncate">
						{name}
					</Text>
				)}
				{name && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="block truncate"
						title={event.actorId}
					>
						{event.actorId.slice(0, 8)}
					</Text>
				)}
			</span>
		</span>
	);
}

/** How many resource-type facet tabs render beside "All". */
export const FACET_LIMIT = 4;

/**
 * Resource-type facets derived from returned data — `resourceType` is an open
 * string in the contract, so the filter values must come from the events
 * themselves, never a hardcoded enum. Most frequent first, name-tiebroken.
 */
export function resourceTypeFacets(
	events: readonly AuditEvent[],
	cap: number = FACET_LIMIT,
): string[] {
	const counts = new Map<string, number>();
	for (const event of events) {
		counts.set(event.resourceType, (counts.get(event.resourceType) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, cap)
		.map(([type]) => type);
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function AuditActorChip({ actorType }: { actorType: AuditActorType }) {
	const tone = actorTone(actorType);
	return (
		<Badge variant={ACTOR_TONE_BADGE_VARIANTS[tone]} data-tone={tone}>
			{actorTypeLabel(actorType)}
		</Badge>
	);
}

export function AuditEventRow({
	event,
	tediNames = {},
	onInspect,
}: {
	event: AuditEvent;
	tediNames?: Record<string, string>;
	onInspect?: (event: AuditEvent) => void;
}) {
	useOsFormattingPreferences();
	return (
		<li className="relative flex min-w-0 items-start gap-3 px-3 py-3 has-[button]:hover:bg-kumo-tint has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-kumo-ring">
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<AuditIdentity event={event} tediNames={tediNames} />
				{/* The exact action string stays on title — filters take exact values. */}
				<Text
					role="body"
					tone="strong"
					weight="medium"
					as="strong"
					truncate
					title={event.action}
				>
					{auditActionLabel(event.action)}
				</Text>
				<Text role="label" tone="secondary" as="span" truncate>
					{humanize(event.resourceType)}
					{event.resourceId ? ` · ${event.resourceId}` : ""}
					{" · "}
					<time
						dateTime={event.timestamp}
						title={absoluteTime(event.timestamp)}
					>
						{relativeTime(event.timestamp)}
					</time>
					{event.ipAddress ? ` · from ${event.ipAddress}` : ""}
				</Text>
			</span>
			{onInspect && (
				<Button
					variant="ghost"
					size="sm"
					className="min-h-11 shrink-0"
					onClick={() => onInspect(event)}
					aria-label={`View details for ${event.action} event`}
				>
					Details
				</Button>
			)}
		</li>
	);
}

/**
 * The desktop audit projection is a Kumo table, rather than a second list
 * recipe. It keeps the fields people scan across immutable event records in
 * stable columns, while the existing row recipe remains the narrow-screen
 * representation where that density would force horizontal scanning.
 */
export function AuditEventTable({
	events,
	tediNames = {},
	onInspect,
}: {
	events: readonly AuditEvent[];
	tediNames?: Record<string, string>;
	onInspect?: (event: AuditEvent) => void;
}) {
	useOsFormattingPreferences();
	return (
		<div className="hidden lg:block">
			<Table aria-label="Audit events" scrollLabel="Audit events table">
				<TableHeader>
					<TableRow>
						<TableHead>Actor</TableHead>
						<TableHead>Action</TableHead>
						<TableHead>Resource</TableHead>
						<TableHead>Source</TableHead>
						<TableHead>When</TableHead>
						{onInspect && <TableHead>Details</TableHead>}
					</TableRow>
				</TableHeader>
				<TableBody>
					{events.map((event) => {
						return (
							<TableRow
								key={event.id}
								className="relative has-[button]:hover:bg-kumo-tint has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-kumo-ring"
							>
								<TableCell className="max-w-52">
									<AuditIdentity event={event} tediNames={tediNames} />
								</TableCell>
								<TableCell className="max-w-60">
									<Text
										role="body"
										weight="medium"
										as="span"
										truncate
										className="block"
										title={event.action}
									>
										{auditActionLabel(event.action)}
									</Text>
								</TableCell>
								<TableCell className="max-w-60">
									<Text
										role="label"
										tone="secondary"
										as="span"
										truncate
										className="block"
										title={event.resourceId ?? undefined}
									>
										{humanize(event.resourceType)}
										{event.resourceId ? ` · ${event.resourceId}` : ""}
									</Text>
								</TableCell>
								<TableCell className="max-w-40 text-kumo-subtle">
									<span
										className="block truncate"
										title={event.ipAddress ?? undefined}
									>
										{event.ipAddress ?? "—"}
									</span>
								</TableCell>
								<TableCell className="text-kumo-subtle">
									<time
										dateTime={event.timestamp}
										title={absoluteTime(event.timestamp)}
									>
										{relativeTime(event.timestamp)}
									</time>
								</TableCell>
								{onInspect && (
									<TableCell>
										<Button
											variant="ghost"
											size="sm"
											className="min-h-11"
											onClick={() => onInspect(event)}
											aria-label={`View details for ${event.action} event`}
										>
											Details
										</Button>
									</TableCell>
								)}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}

/** Audit metadata comes from an open JSON field. Render it as escaped text. */
export function formatAuditMetadata(metadata: AuditEvent["metadata"]): string {
	if (metadata == null) return "No metadata recorded";
	try {
		return JSON.stringify(metadata, null, 2) ?? "No metadata recorded";
	} catch {
		return "Metadata could not be displayed";
	}
}

export function AuditEventDetails({
	event,
	tediNames = {},
}: {
	event: AuditEvent;
	tediNames?: Record<string, string>;
}) {
	const directory = useContext(WorkActorDirectoryContext);
	const actor = actorLabel(event, tediNames, directory);
	const fields = [
		["Actor", actor ?? actorTypeLabel(event.actorType)],
		["Actor type", actorTypeLabel(event.actorType)],
		["Actor ID", event.actorId],
		["Action", event.action],
		["Resource type", event.resourceType],
		["Resource ID", event.resourceId ?? "Not recorded"],
		["Source IP", event.ipAddress ?? "Not recorded"],
		["User agent", event.userAgent ?? "Not recorded"],
		["Event ID", event.id],
		["Organization ID", event.organizationId],
	] as const;

	return (
		<div className="grid min-w-0 gap-4">
			<dl className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2">
				{fields.map(([label, value]) => (
					<div key={label} className="min-w-0">
						<dt className="text-kumo-subtle type-tedix-label">{label}</dt>
						<dd className="break-all text-kumo-default type-tedix-body">
							{value}
						</dd>
					</div>
				))}
			</dl>
			<Surface className="min-w-0 p-3">
				<Text role="label" tone="secondary" as="h3">
					Metadata
				</Text>
				<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-kumo-default type-tedix-label">
					{formatAuditMetadata(event.metadata)}
				</pre>
			</Surface>
		</div>
	);
}

export function AuditEmpty({ filtered }: { filtered: boolean }) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ClockCounterClockwise size={20} />
				</EmptyMedia>
				<EmptyTitle>
					{filtered
						? "No audit events match this filter"
						: "No audit events yet"}
				</EmptyTitle>
				<EmptyDescription>
					The audit trail is the immutable org event log — every governed action
					by a user, tedi, or service is recorded here automatically as it
					happens.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

/**
 * The free-text escape hatch beside the facet tabs: exact-match `action` and
 * `resourceType` filters (the server filters with `eq`, so values must match
 * the raw strings the trail records — the tabs and each row's title attribute
 * surface them). Drafts are component state; only APPLIED values live in the
 * URL, so the parent re-keys this form on the applied pair to keep drafts
 * back/forward-correct.
 */
export function AuditFilters({
	appliedAction,
	appliedResourceType,
	onApply,
	onClear,
}: {
	appliedAction: string;
	appliedResourceType: string;
	onApply: (filters: { action: string; resourceType: string }) => void;
	onClear: () => void;
}) {
	const hasApplied =
		appliedAction.trim() !== "" ||
		(appliedResourceType !== AUDIT_ALL_RESOURCES &&
			appliedResourceType.trim() !== "");
	const activeFilterCount = [
		appliedAction.trim() !== "",
		appliedResourceType !== AUDIT_ALL_RESOURCES &&
			appliedResourceType.trim() !== "",
	].filter(Boolean).length;
	const [mobileFiltersOpen, setMobileFiltersOpen] = useState(hasApplied);
	const summary = hasApplied
		? `${activeFilterCount} active · ${appliedAction || "Any action"} · ${
				appliedResourceType === AUDIT_ALL_RESOURCES
					? "All resource types"
					: sentenceCase(appliedResourceType)
			}`
		: "All actions · all resource types";

	return (
		<>
			<Surface
				className="md:hidden"
				render={
					<Collapsible
						open={mobileFiltersOpen}
						onOpenChange={setMobileFiltersOpen}
					/>
				}
			>
				<CollapsibleTrigger className="w-full justify-between rounded-lg px-3 py-2">
					<span className="min-w-0">
						<span className="block font-medium text-kumo-default">Filters</span>
						<span className="block truncate text-kumo-subtle type-tedix-label">
							{summary}
						</span>
					</span>
					<CaretDown
						aria-hidden
						className={`size-4 shrink-0 transition-transform duration-tedix-standard motion-reduce:transition-none ${mobileFiltersOpen ? "rotate-180" : ""}`}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="border-kumo-line border-t p-3">
						<AuditFilterForm
							appearance="inline"
							appliedAction={appliedAction}
							appliedResourceType={appliedResourceType}
							onApply={onApply}
							onClear={onClear}
						/>
					</div>
				</CollapsibleContent>
			</Surface>
			<div className="hidden md:block">
				<AuditFilterForm
					appearance="inline"
					appliedAction={appliedAction}
					appliedResourceType={appliedResourceType}
					onApply={onApply}
					onClear={onClear}
				/>
			</div>
		</>
	);
}

function AuditFilterForm({
	appearance,
	appliedAction,
	appliedResourceType,
	onApply,
	onClear,
}: {
	appearance?: "bounded" | "inline";
	appliedAction: string;
	appliedResourceType: string;
	onApply: (filters: { action: string; resourceType: string }) => void;
	onClear: () => void;
}) {
	const form = useZodForm({
		schema: z.object({
			action: z.string().trim(),
			resourceType: z.string().trim(),
		}),
		defaultValues: {
			action: appliedAction,
			resourceType:
				appliedResourceType === AUDIT_ALL_RESOURCES ? "" : appliedResourceType,
		},
		onSubmit: ({ value }) =>
			onApply({
				action: value.action,
				resourceType: value.resourceType || AUDIT_ALL_RESOURCES,
			}),
	});
	const hasApplied =
		appliedAction.trim() !== "" ||
		(appliedResourceType !== AUDIT_ALL_RESOURCES &&
			appliedResourceType.trim() !== "");

	return (
		<PageToolbar aria-label="Audit filters" appearance={appearance}>
			<form
				className="grid w-full gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<FormField form={form} name="action" label="Action">
					{(field, meta) => (
						<FormInput
							field={field}
							{...meta}
							placeholder="e.g. record_skill"
						/>
					)}
				</FormField>
				<FormField form={form} name="resourceType" label="Resource type">
					{(field, meta) => (
						<FormInput
							field={field}
							{...meta}
							placeholder="e.g. organization"
						/>
					)}
				</FormField>
				<div className="flex gap-2">
					<Button type="submit" size="sm" variant="secondary">
						Apply
					</Button>
					{hasApplied ? (
						<Button type="button" size="sm" variant="ghost" onClick={onClear}>
							Clear
						</Button>
					) : null}
				</div>
			</form>
		</PageToolbar>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AuditPage({
	search,
	onSearchChange,
}: {
	/** Validated URL state from the route — never component state. */
	search: AuditSearch;
	onSearchChange: (next: Partial<AuditSearch>) => void;
}) {
	useOsFormattingPreferences();
	const surface = getOsSurface("audit");
	const facet = search.resourceType;
	const defaultView = isDefaultAuditSearch(search);
	const [inspectedEvent, setInspectedEvent] = useState<AuditEvent | null>(null);

	// The unfiltered newest-first page is both the default view and the source
	// of the facet values (resourceType is an open string in the contract).
	const events = useQuery(auditSearchQueryOptions({ limit: AUDIT_PAGE_SIZE }));

	// Filtering and paging are server-side (contract filters + offset), so a
	// narrowed view surfaces events beyond the first unfiltered page. The
	// input-derived key keeps every filter/page combination a distinct cache
	// entry; keepPreviousData holds the current rows while the next page loads.
	const filteredEvents = useQuery({
		...auditSearchQueryOptions(auditSearchInput(search)),
		enabled: !defaultView,
		placeholderData: keepPreviousData,
		staleTime: 15_000,
	});

	const activeQuery = defaultView ? events : filteredEvents;
	const tediNames = useTediNames();

	const facets = useMemo(
		() => resourceTypeFacets(events.data?.data ?? []),
		[events.data],
	);
	// Keep the selected facet addressable even if a base refetch drops it from
	// the top-N (or it was typed into the escape hatch) — a Tabs value must
	// always have its trigger.
	const facetTabs =
		facet === AUDIT_ALL_RESOURCES || facets.includes(facet)
			? facets
			: [...facets, facet];
	const filtered = facet !== AUDIT_ALL_RESOURCES || search.action.trim() !== "";

	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>{surface.description}</PageDescription>
				</PageHeading>
				<PageActions>
					<Button
						variant="outline"
						disabled={activeQuery.isFetching}
						onClick={() => void activeQuery.refetch()}
					>
						<ArrowClockwise
							size={14}
							className={activeQuery.isFetching ? "animate-spin" : undefined}
						/>
						Refresh
					</Button>
				</PageActions>
			</PageHeader>

			<section className="grid min-w-0 gap-3">
				<SectionEyebrow
					title="Audit events"
					count={activeQuery.data?.pagination.total}
					// The facet filter composes into the eyebrow row, mirroring the
					// Activity status tabs. It only appears once there is something
					// to narrow by.
					actions={
						facets.length > 1 ? (
							<KumoTabs
								aria-label="Resource type"
								value={facet}
								onValueChange={(value) =>
									onSearchChange({ resourceType: value as string, page: 1 })
								}
								className="shrink-0 max-sm:[&_button]:min-w-11 coarse:[&_button]:min-w-11"
								tabs={[
									{ value: AUDIT_ALL_RESOURCES, label: "All" },
									...facetTabs.map((type) => ({
										value: type,
										label: sentenceCase(type),
									})),
								]}
							/>
						) : undefined
					}
				/>
				<AuditFilters
					// Re-key on the applied pair so a back/forward navigation reseeds
					// the drafts from the URL instead of showing stale text.
					key={`${search.action}\u0000${search.resourceType}`}
					appliedAction={search.action}
					appliedResourceType={search.resourceType}
					onApply={({ action, resourceType }) =>
						onSearchChange({ action, resourceType, page: 1 })
					}
					onClear={() =>
						onSearchChange({
							action: "",
							resourceType: AUDIT_ALL_RESOURCES,
							page: 1,
						})
					}
				/>
				{activeQuery.isPending && <ListSkeleton />}
				{activeQuery.isError && (
					<Alert variant="destructive">
						<AlertTitle>The audit trail is unavailable</AlertTitle>
						<AlertDescription>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<span>{(activeQuery.error as Error).message}</span>
								<Button
									disabled={activeQuery.isFetching}
									onClick={() => void activeQuery.refetch()}
									size="sm"
									variant="secondary"
								>
									Retry
								</Button>
							</div>
						</AlertDescription>
					</Alert>
				)}
				{activeQuery.data && activeQuery.data.data.length === 0 && (
					<AuditEmpty filtered={filtered} />
				)}
				{activeQuery.data && activeQuery.data.data.length > 0 && (
					<>
						<div aria-busy={activeQuery.isFetching || undefined}>
							<AuditEventTable
								events={activeQuery.data.data}
								tediNames={tediNames}
								onInspect={setInspectedEvent}
							/>
							<Collection aria-label="Audit events" className="lg:hidden">
								{activeQuery.data.data.map((event) => (
									<AuditEventRow
										key={event.id}
										event={event}
										tediNames={tediNames}
										onInspect={setInspectedEvent}
									/>
								))}
							</Collection>
						</div>
						{activeQuery.data.pagination.total > AUDIT_PAGE_SIZE && (
							<Pagination
								className="flex-col items-stretch gap-3 border-kumo-hairline border-t pt-3 sm:flex-row sm:items-center"
								page={search.page}
								perPage={AUDIT_PAGE_SIZE}
								totalCount={activeQuery.data.pagination.total}
								setPage={(nextPage) => onSearchChange({ page: nextPage })}
							>
								<Pagination.Info>
									{({ totalCount }) =>
										`${formatCount(totalCount ?? 0)} events · Page ${formatCount(search.page)}`
									}
								</Pagination.Info>
								<Pagination.Controls controls="simple" />
							</Pagination>
						)}
					</>
				)}
			</section>
			<Dialog
				open={inspectedEvent !== null}
				onOpenChange={(open) => {
					if (!open) setInspectedEvent(null);
				}}
			>
				{inspectedEvent && (
					<DialogContent size="lg">
						<DialogHeader>
							<DialogTitle>Audit event</DialogTitle>
							<DialogDescription>
								{auditActionLabel(inspectedEvent.action)} ·{" "}
								<time dateTime={inspectedEvent.timestamp}>
									{absoluteTime(inspectedEvent.timestamp)}
								</time>
							</DialogDescription>
						</DialogHeader>
						<AuditEventDetails event={inspectedEvent} tediNames={tediNames} />
					</DialogContent>
				)}
			</Dialog>
		</Page>
	);
}
