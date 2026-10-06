import {
	ArrowLeft,
	CaretRight,
	DownloadSimple,
	Plus,
	Trash,
	UploadSimple,
} from "@phosphor-icons/react";
import type {
	OsBlueprintGalleryItem,
	OsBlueprintVisibility,
	OsBlueprintWithVisibility,
} from "@tedix/api-contract/contracts/os-workspaces";
import type {
	OsBlueprintDefinition,
	OsBlueprintExport,
	OsBlueprintPreflight,
	OsBlueprintResourceBinding,
	OsBlueprintRevision,
	OsBlueprintStatus,
} from "@tedix/api-contract/schemas/os-workspaces";
import { OsBlueprintExportSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useStore } from "@tanstack/react-form";
import { getOsSurface } from "@/lib/os-navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Link } from "@/components/kumo/link";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Collection,
	Page,
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageToolbar,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SearchInput } from "@/components/kumo/search-input";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { ListSkeleton } from "@/components/list-skeleton";
import { osApi } from "@/lib/api";
import {
	BLUEPRINTS_LIST_LIMIT,
	BLUEPRINT_GALLERY_LIMIT,
	blueprintDetailQueryOptions,
	blueprintGalleryQueryOptions,
	blueprintListQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";
import { formatCount, sentenceCase } from "@/lib/format";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { absoluteTime, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const STATUS_VARIANTS: Record<OsBlueprintStatus, BadgeVariant> = {
	draft: "info",
	published: "success",
	archived: "secondary",
};

/** Initial owned-library window; expands in the same calm rhythm as Apps. */
export const BLUEPRINTS_VISIBLE_PAGE_SIZE = 15;

export function blueprintStatusVariant(
	status: OsBlueprintStatus,
): BadgeVariant {
	return STATUS_VARIANTS[status];
}

export function revisionIndicator(currentRevisionId: string | null): string {
	return currentRevisionId ? "Revision recorded" : "No revision yet";
}

/**
 * One line describing exactly what the revision pinned. It counts declarations
 * — it never claims any of them resolved; that is the preflight verb's answer.
 */
export function requirementsSummaryText(
	requirements: OsBlueprintDefinition["requirements"],
): string {
	if (!requirements) return "no pinned requirements";
	const parts = [
		`${formatCount(requirements.skills.length)} pinned skills`,
		`${formatCount(requirements.connections.length)} connections`,
		`${formatCount(requirements.policies.length)} policy packs`,
	];
	if ((requirements.resources ?? []).length > 0) {
		parts.push(
			`${formatCount(requirements.resources?.length ?? 0)} resource slots`,
		);
	}
	if (requirements.runtime) parts.push("a runtime constraint");
	if (requirements.layout) {
		parts.push(
			`${formatCount(requirements.layout.placements.length)} placements`,
		);
	}
	if (requirements.outputs.length > 0) {
		parts.push(`${formatCount(requirements.outputs.length)} outputs`);
	}
	return parts.join(" · ");
}

function RequirementsSummary({
	requirements,
}: {
	requirements: OsBlueprintDefinition["requirements"];
}) {
	return (
		<Text role="label" tone="secondary" className="m-0">
			{requirementsSummaryText(requirements)}
			{requirements
				? ". Pins are preserved as recorded — author them with revise_os_blueprint, then resolve them with preflight_os_blueprint."
				: "."}
		</Text>
	);
}

/** Comma- or newline-separated operator input → trimmed, non-empty entries. */
export function parseListInput(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export interface GadgetDraft {
	/** Local-only React key; never sent to the API. */
	id: string;
	name: string;
	entry: string;
	capabilities: string;
	notes: string;
}

export interface DefinitionDraft {
	gadgets: GadgetDraft[];
	/**
	 * The revision's version-pinned dependency declaration, carried through the
	 * editor untouched. Pins are authored through the API/MCP `revise` verb (they
	 * are structured `skillId`+`revision` / `(scope, slug, version)` references,
	 * not operator free text), so this surface preserves them verbatim rather
	 * than round-tripping them through comma-separated inputs that could not
	 * express a pin.
	 */
	requirements: OsBlueprintDefinition["requirements"];
}

let gadgetDraftSeq = 0;

export function newGadgetDraft(): GadgetDraft {
	gadgetDraftSeq += 1;
	return {
		id: `gadget-draft-${gadgetDraftSeq}`,
		name: "",
		entry: "",
		capabilities: "",
		notes: "",
	};
}

export function definitionToDraft(
	definition: OsBlueprintDefinition | null,
): DefinitionDraft {
	if (!definition) {
		return { gadgets: [], requirements: null };
	}
	return {
		gadgets: definition.gadgets.map((gadget) => ({
			...newGadgetDraft(),
			name: gadget.name,
			entry: gadget.manifest.entry,
			capabilities: gadget.manifest.capabilities.join(", "),
			notes: gadget.manifest.notes ?? "",
		})),
		requirements: definition.requirements,
	};
}

export function draftToDefinition(
	draft: DefinitionDraft,
): OsBlueprintDefinition {
	return {
		gadgets: draft.gadgets.map((gadget) => {
			const notes = gadget.notes.trim();
			return {
				name: gadget.name.trim(),
				manifest: {
					capabilities: parseListInput(gadget.capabilities),
					entry: gadget.entry.trim(),
					...(notes ? { notes } : {}),
				},
			};
		}),
		requirements: draft.requirements,
	};
}

/** The contract requires a non-empty name and entry on every declared gadget. */
export function draftValidationError(draft: DefinitionDraft): string | null {
	for (const [index, gadget] of draft.gadgets.entries()) {
		if (!gadget.name.trim()) return `Gadget ${index + 1} needs a name`;
		if (!gadget.entry.trim()) return `Gadget ${index + 1} needs an entry point`;
	}
	return null;
}

/** Matches the typed oRPC CONFLICT error (lost revision CAS / taken name). */
export function isConflictError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "CONFLICT"
	);
}

export function blueprintPackageFilename(
	name: string,
	revision: number,
): string {
	const safeName = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${safeName || "blueprint"}-r${revision}.tedix-blueprint.json`;
}

export function serializeBlueprintPackage(value: OsBlueprintExport): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function downloadBlueprintPackage(
	value: OsBlueprintExport,
	name: string,
	revision: number,
) {
	const url = URL.createObjectURL(
		new Blob([serializeBlueprintPackage(value)], {
			type: "application/json;charset=utf-8",
		}),
	);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = blueprintPackageFilename(name, revision);
	anchor.click();
	URL.revokeObjectURL(url);
}

async function readBlueprintPackageFile(file: File): Promise<string> {
	if (typeof file.text === "function") return file.text();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
		reader.addEventListener("error", () =>
			reject(new Error("The selected package could not be read.")),
		);
		reader.readAsText(file);
	});
}

// ---------------------------------------------------------------------------
// Presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

const BlueprintIcon = SURFACE_ICONS.blueprints;

export function BlueprintsEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<BlueprintIcon size={20} />
				</EmptyMedia>
				<EmptyTitle>No blueprints yet</EmptyTitle>
				<EmptyDescription>
					Blueprints are versioned workspace templates: declare gadgets, skills,
					connections, and policy requirements once, then instantiate whole
					workspaces from them.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function BlueprintRow({
	blueprint,
	onToggle,
}: {
	blueprint: OsBlueprintWithVisibility;
	onToggle?: () => void;
}) {
	return (
		<li className="grid min-w-0 gap-1">
			<Button
				onClick={onToggle}
				className="min-h-14 min-w-0 w-full items-start gap-3 rounded-none px-4 py-3 text-left"
				multiline
				variant="ghost"
			>
				<IconFrame aria-hidden>
					<BlueprintIcon size={18} />
				</IconFrame>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<Text as="strong" role="body" tone="strong" weight="medium" truncate>
						{blueprint.name}
					</Text>
					{blueprint.description && (
						<Text as="span" role="label" tone="secondary" truncate>
							{blueprint.description}
						</Text>
					)}
					<span className="flex flex-wrap items-center gap-1.5">
						<Badge
							variant={blueprintStatusVariant(blueprint.status)}
							data-status={blueprint.status}
						>
							{sentenceCase(blueprint.status)}
						</Badge>
						{blueprint.visibility === "catalog" && (
							<Badge variant="outline" data-visibility="catalog">
								In gallery
							</Badge>
						)}
						<Text as="span" role="label" tone="secondary">
							{revisionIndicator(blueprint.currentRevisionId)}
						</Text>
					</span>
				</span>
				<span className="flex shrink-0 items-center gap-2 self-center text-kumo-subtle type-tedix-label">
					<time
						dateTime={blueprint.updatedAt}
						title={absoluteTime(blueprint.updatedAt)}
						className="hidden tabular-nums sm:block"
					>
						{relativeTime(blueprint.updatedAt)}
					</time>
					<span>Open</span>
					<CaretRight size={14} aria-hidden />
				</span>
			</Button>
		</li>
	);
}

function EditorLabel({ children }: { children: ReactNode }) {
	return (
		<Text
			as="span"
			className="text-kumo-subtle uppercase tracking-[0.8px]"
			role="caption"
			weight="semibold"
		>
			{children}
		</Text>
	);
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

const createBlueprintSchema = z.object({
	name: z.string().trim().min(1, "Enter a Blueprint name.").max(120),
	description: z.string().trim().max(2_000),
});

function CreateBlueprintForm({
	onCreated,
	onCancel,
}: {
	onCreated: (blueprint: OsBlueprintWithVisibility) => void;
	onCancel: () => void;
}) {
	const queryClient = useQueryClient();

	const create = useMutation({
		mutationFn: (value: z.output<typeof createBlueprintSchema>) =>
			osApi.osWorkspaces.blueprints.create({
				name: value.name,
				description: value.description || undefined,
			}),
		onSuccess: ({ blueprint }) => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.blueprints() });
			onCreated(blueprint);
		},
	});
	const form = useZodForm({
		schema: createBlueprintSchema,
		defaultValues: { name: "", description: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => {
			create.mutate(value);
		},
	});

	return (
		<Surface
			as="form"
			className="grid gap-3 p-4"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<EditorLabel>New blueprint</EditorLabel>
			<FormField form={form} name="name" label="Name">
				{(field, meta) => (
					<FormInput
						field={field}
						{...meta}
						aria-label="Blueprint name"
						maxLength={120}
					/>
				)}
			</FormField>
			<FormField form={form} name="description" label="Description" optional>
				{(field, meta) => (
					<FormTextarea
						field={field}
						{...meta}
						aria-label="Blueprint description"
						maxLength={2_000}
					/>
				)}
			</FormField>
			<div className="flex items-center gap-2">
				<Button size="sm" disabled={create.isPending} type="submit">
					{create.isPending ? "Creating…" : "Create blueprint"}
				</Button>
				<Button size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
			{create.isError && (
				<Alert variant="destructive">
					<AlertTitle>Creating the blueprint failed</AlertTitle>
					<AlertDescription>{(create.error as Error).message}</AlertDescription>
				</Alert>
			)}
		</Surface>
	);
}

// ---------------------------------------------------------------------------
// Definition editor (draft blueprints only)
// ---------------------------------------------------------------------------

function DefinitionEditor({
	blueprintId,
	currentRevision,
}: {
	blueprintId: string;
	currentRevision: OsBlueprintRevision | null;
}) {
	const queryClient = useQueryClient();
	const defaultValues = useMemo(
		() => definitionToDraft(currentRevision?.definition ?? null),
		[currentRevision],
	);
	const form = useForm({
		defaultValues,
		onSubmit: ({ value }) => revise.mutate(draftToDefinition(value)),
	});
	useEffect(() => {
		form.reset(defaultValues);
	}, [defaultValues, form]);
	const draft = useStore(form.store, (state) => state.values);
	const validationError = draftValidationError(draft);

	const revise = useMutation({
		mutationFn: (definition: OsBlueprintDefinition) =>
			osApi.osWorkspaces.blueprints.revise({
				blueprintId,
				definition,
				expectedRevision: currentRevision?.revision ?? 0,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: blueprintDetailQueryOptions(blueprintId).queryKey,
			});
			queryClient.invalidateQueries({ queryKey: osQueryKeys.blueprints() });
		},
	});

	const reloadLatest = () => {
		revise.reset();
		queryClient.invalidateQueries({
			queryKey: blueprintDetailQueryOptions(blueprintId).queryKey,
		});
	};

	return (
		<form
			className="grid gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<EditorLabel>Definition</EditorLabel>
			{draft.gadgets.length === 0 && (
				<Text role="label" tone="secondary" className="m-0">
					No gadgets declared yet.
				</Text>
			)}
			<form.Field name="gadgets" mode="array">
				{(gadgetsField) =>
					draft.gadgets.length > 0 && (
						<ul className="m-0 grid list-none gap-3 p-0">
							{draft.gadgets.map((gadget, index) => (
								<Surface as="li" key={gadget.id} className="grid gap-2 p-3">
									<div className="flex items-center justify-between gap-2">
										<Text as="span" role="label" tone="secondary">
											Gadget {index + 1}
										</Text>
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label={`Remove gadget ${index + 1}`}
											onClick={() => gadgetsField.removeValue(index)}
										>
											<Trash size={14} />
										</Button>
									</div>
									{(["name", "entry", "capabilities"] as const).map((key) => (
										<FormField
											key={key}
											form={form}
											name={`gadgets[${index}].${key}`}
											label={
												key === "entry" ? "Entry point" : sentenceCase(key)
											}
										>
											{(field, meta) => (
												<FormInput
													field={field}
													{...meta}
													aria-label={`Gadget ${index + 1} ${key}`}
													placeholder={
														key === "entry" ? "gadgets/report.tsx" : undefined
													}
												/>
											)}
										</FormField>
									))}
									<FormField
										form={form}
										name={`gadgets[${index}].notes`}
										label="Notes"
										optional
									>
										{(field, meta) => (
											<FormTextarea
												field={field}
												{...meta}
												aria-label={`Gadget ${index + 1} notes`}
											/>
										)}
									</FormField>
								</Surface>
							))}
						</ul>
					)
				}
			</form.Field>
			<Button
				size="sm"
				variant="outline"
				className="w-fit"
				onClick={() => form.pushFieldValue("gadgets", newGadgetDraft())}
			>
				<Plus size={14} />
				Add gadget
			</Button>
			<div className="grid gap-1">
				<EditorLabel>Pinned requirements</EditorLabel>
				<RequirementsSummary requirements={draft.requirements} />
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					disabled={validationError !== null || revise.isPending}
					type="submit"
				>
					{revise.isPending ? "Saving…" : "Save definition"}
				</Button>
				{validationError && (
					<Text as="span" role="label" tone="secondary">
						{validationError}
					</Text>
				)}
			</div>
			{revise.isError &&
				(isConflictError(revise.error) ? (
					<Alert variant="destructive">
						<AlertTitle>Revision conflict</AlertTitle>
						<AlertDescription>
							A newer revision was recorded while you were editing — reload the
							latest definition and re-apply your changes.
						</AlertDescription>
						<Button
							size="sm"
							variant="outline"
							className="mt-2 w-fit"
							onClick={reloadLatest}
						>
							Reload latest
						</Button>
					</Alert>
				) : (
					<Alert variant="destructive">
						<AlertTitle>Saving the definition failed</AlertTitle>
						<AlertDescription>
							{(revise.error as Error).message}
						</AlertDescription>
					</Alert>
				))}
		</form>
	);
}

// ---------------------------------------------------------------------------
// Instantiate form (published blueprints only)
// ---------------------------------------------------------------------------

interface InstantiateSuccess {
	workspaceId: string;
	workspaceName: string;
	gadgetCount: number;
}

/** The instantiate result subset the form reports back; both blueprint verbs return it. */
interface InstantiateResult {
	workspace: { id: string; name: string };
	gadgets: unknown[];
}

function BlueprintSetupCheck({
	preflight,
}: {
	preflight: OsBlueprintPreflight;
}) {
	const title: Record<OsBlueprintPreflight["status"], string> = {
		not_configured: "No setup requirements declared",
		ready: "Ready to create",
		needs_consent: "Connections need consent after creation",
		needs_configuration: "Select the required resources",
		blocked: "Pinned requirements need attention",
	};
	const connections = preflight.requirements?.connections ?? [];
	return (
		<Surface
			className="grid gap-2 p-3"
			data-preflight-status={preflight.status}
		>
			<Text as="strong" role="label" tone="strong">
				{title[preflight.status]}
			</Text>
			<Text role="label" tone="secondary" className="m-0">
				Revision {preflight.revision} checked for this organization. Creation
				will check again before writing the workspace.
			</Text>
			{preflight.decisions.length > 0 && (
				<ul className="m-0 grid gap-1 pl-4 text-sm text-kumo-subtle">
					{preflight.decisions.map((decision, index) => (
						<li key={`${decision.kind}:${decision.subject}:${index}`}>
							{sentenceCase(decision.kind.replaceAll("_", " "))}:{" "}
							{decision.subject} —{" "}
							{sentenceCase(decision.verdict.replaceAll("_", " "))}.{" "}
							{decision.reason}
						</li>
					))}
				</ul>
			)}
			{connections.length > 0 && preflight.consentReasons.length > 0 && (
				<div className="flex flex-wrap gap-3">
					{connections.some(
						(connection) => connection.tokenScope === "tenant",
					) && (
						<Link href="/admin/connections">
							Manage organization connections
						</Link>
					)}
					{connections.some(
						(connection) => connection.tokenScope === "user",
					) && (
						<Link href="/account/connections">Manage personal connections</Link>
					)}
				</div>
			)}
		</Surface>
	);
}

/**
 * Workspace-name input plus instantiate button, shared by the own-blueprint
 * detail panel (`blueprints.instantiate`) and the Explore gallery cards
 * (`blueprints.instantiateFromGallery`) — only the request differs.
 */
function InstantiateForm({
	request,
	blueprintId,
	revisionId,
	resourceRequirements = [],
	nameFieldLabel = "Workspace name",
	successNote,
}: {
	request: (
		workspaceName: string,
		resourceBindings: OsBlueprintResourceBinding[],
	) => Promise<InstantiateResult>;
	blueprintId?: string;
	revisionId?: string;
	resourceRequirements?: NonNullable<
		OsBlueprintDefinition["requirements"]
	>["resources"];
	nameFieldLabel?: string;
	successNote?: string;
}) {
	const [success, setSuccess] = useState<InstantiateSuccess | null>(null);
	const defaultValues = useMemo(
		() => ({
			workspaceName: "",
			resourceSelections: {} as Record<
				string,
				{ providerResourceId: string; name: string }
			>,
		}),
		[],
	);
	const form = useForm({
		defaultValues,
		onSubmit: ({ value }) => instantiate.mutate(value),
	});
	const { workspaceName, resourceSelections } = useStore(
		form.store,
		(state) => state.values,
	);
	const bindings = (resourceRequirements ?? []).map((requirement) => ({
		slot: requirement.slot,
		selection: {
			providerId: requirement.providerId,
			connectionScope:
				requirement.tokenScope === "user"
					? ("user" as const)
					: ("tenant" as const),
			requiredScopes: requirement.scopes,
			resourceType: requirement.resourceType,
			providerResourceId:
				resourceSelections[requirement.slot]?.providerResourceId.trim() ?? "",
			name: resourceSelections[requirement.slot]?.name.trim() ?? "",
			metadata: {},
		},
	}));
	const resourcesComplete = bindings.every(
		(binding) =>
			binding.selection.providerResourceId.length > 0 &&
			binding.selection.name.length > 0,
	);
	const preflight = useQuery({
		...osQuery.osWorkspaces.blueprints.preflight.queryOptions({
			input: {
				blueprintId: blueprintId ?? "",
				resourceBindings: bindings.filter(
					(binding) =>
						binding.selection.providerResourceId.length > 0 &&
						binding.selection.name.length > 0,
				),
			},
		}),
		enabled: Boolean(blueprintId),
		retry: false,
	});
	const currentPreflight =
		preflight.data?.preflight &&
		preflight.data.preflight.revisionId === revisionId
			? preflight.data.preflight
			: null;
	const preflightBlocksInstantiation =
		Boolean(blueprintId) &&
		(preflight.isPending ||
			(preflight.isSuccess && currentPreflight === null) ||
			(currentPreflight !== null && !currentPreflight.instantiateAllowed));

	const instantiate = useMutation({
		mutationFn: (value: {
			workspaceName: string;
			resourceSelections: Record<
				string,
				{ providerResourceId: string; name: string }
			>;
		}) => {
			const submittedBindings = (resourceRequirements ?? []).map(
				(requirement) => ({
					slot: requirement.slot,
					selection: {
						providerId: requirement.providerId,
						connectionScope:
							requirement.tokenScope === "user"
								? ("user" as const)
								: ("tenant" as const),
						requiredScopes: requirement.scopes,
						resourceType: requirement.resourceType,
						providerResourceId:
							value.resourceSelections[
								requirement.slot
							]?.providerResourceId.trim() ?? "",
						name: value.resourceSelections[requirement.slot]?.name.trim() ?? "",
						metadata: {},
					},
				}),
			);
			return request(value.workspaceName.trim(), submittedBindings);
		},
		onSuccess: (result) => {
			setSuccess({
				workspaceId: result.workspace.id,
				workspaceName: result.workspace.name,
				gadgetCount: result.gadgets.length,
			});
			form.reset();
		},
	});

	return (
		<form
			className="grid gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				void form.handleSubmit();
			}}
		>
			{blueprintId && (
				<div className="grid gap-2" aria-live="polite">
					<EditorLabel>Setup check</EditorLabel>
					{preflight.isPending && (
						<Text role="label" tone="secondary" className="m-0">
							Checking this Blueprint against your organization…
						</Text>
					)}
					{preflight.isError && (
						<Alert variant="destructive">
							<AlertTitle>Setup check unavailable</AlertTitle>
							<AlertDescription>
								The server will check requirements again when you instantiate.
								<Button
									size="sm"
									variant="outline"
									className="mt-2 w-fit"
									type="button"
									onClick={() => void preflight.refetch()}
								>
									Try again
								</Button>
							</AlertDescription>
						</Alert>
					)}
					{preflight.isSuccess &&
						preflight.data?.preflight &&
						!currentPreflight && (
							<Text role="label" tone="error" className="m-0">
								The Blueprint revision changed. Reload this Blueprint before
								creating a workspace.
							</Text>
						)}
					{currentPreflight && (
						<BlueprintSetupCheck preflight={currentPreflight} />
					)}
				</div>
			)}
			{(resourceRequirements ?? []).map((requirement) => (
				<Surface key={requirement.slot} className="grid gap-2 p-3">
					<div className="flex flex-wrap items-center gap-2">
						<EditorLabel>{requirement.label}</EditorLabel>
						<Badge variant="outline">
							{requirement.providerId} · {requirement.resourceType}
						</Badge>
					</div>
					{(["providerResourceId", "name"] as const).map((key) => (
						<FormField
							key={key}
							form={form}
							name={`resourceSelections.${requirement.slot}.${key}`}
							label={
								key === "providerResourceId"
									? "Provider resource ID"
									: "Display name"
							}
						>
							{(field, meta) => (
								<FormInput
									field={field}
									{...meta}
									aria-label={`${requirement.label} ${key === "providerResourceId" ? "provider resource ID" : "display name"}`}
								/>
							)}
						</FormField>
					))}
				</Surface>
			))}
			<div className="flex flex-wrap items-center gap-2">
				<FormField form={form} name="workspaceName" label={nameFieldLabel}>
					{(field, meta) => (
						<FormInput field={field} {...meta} aria-label={nameFieldLabel} />
					)}
				</FormField>
				<Button
					size="sm"
					disabled={
						!workspaceName.trim() ||
						!resourcesComplete ||
						preflightBlocksInstantiation ||
						instantiate.isPending
					}
					type="submit"
				>
					{instantiate.isPending ? "Instantiating…" : "Instantiate workspace"}
				</Button>
			</div>
			{instantiate.isError &&
				(isConflictError(instantiate.error) ? (
					<Text role="label" tone="error" className="m-0">
						That workspace name is already taken — pick another.
					</Text>
				) : (
					<Alert variant="destructive">
						<AlertTitle>Instantiation failed</AlertTitle>
						<AlertDescription>
							{(instantiate.error as Error).message}
						</AlertDescription>
					</Alert>
				))}
			{success && (
				<div className="grid gap-1">
					<Text role="label" tone="secondary" className="m-0">
						Created workspace{" "}
						<strong className="text-kumo-strong">
							{success.workspaceName}
						</strong>{" "}
						({success.workspaceId}) with {formatCount(success.gadgetCount)}{" "}
						{success.gadgetCount === 1 ? "gadget" : "gadgets"}.
						{successNote ? ` ${successNote}` : ""}
					</Text>
					<Link href={`/workspace/${success.workspaceId}`} className="w-fit">
						Open workspace
					</Link>
				</div>
			)}
		</form>
	);
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function DefinitionSummary({
	definition,
}: {
	definition: OsBlueprintDefinition;
}) {
	return (
		<Text role="label" tone="secondary" className="m-0">
			{formatCount(definition.gadgets.length)}{" "}
			{definition.gadgets.length === 1 ? "gadget" : "gadgets"} ·{" "}
			{requirementsSummaryText(definition.requirements)}
		</Text>
	);
}

function BlueprintDetail({ blueprintId }: { blueprintId: string }) {
	const queryClient = useQueryClient();
	const detail = useQuery(blueprintDetailQueryOptions(blueprintId));

	const publish = useMutation({
		mutationFn: () => osApi.osWorkspaces.blueprints.publish({ blueprintId }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: blueprintDetailQueryOptions(blueprintId).queryKey,
			});
			queryClient.invalidateQueries({ queryKey: osQueryKeys.blueprints() });
		},
	});

	const setVisibility = useMutation({
		mutationFn: (visibility: OsBlueprintVisibility) =>
			osApi.osWorkspaces.blueprints.setVisibility({ blueprintId, visibility }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: blueprintDetailQueryOptions(blueprintId).queryKey,
			});
			queryClient.invalidateQueries({ queryKey: osQueryKeys.blueprints() });
			queryClient.invalidateQueries({
				queryKey: blueprintGalleryQueryOptions(BLUEPRINT_GALLERY_LIMIT)
					.queryKey,
			});
		},
	});

	const exportPackage = useMutation({
		mutationFn: (revisionId?: string) =>
			osApi.osWorkspaces.blueprints.export({ blueprintId, revisionId }),
		onSuccess: ({ export: portableExport }) => {
			downloadBlueprintPackage(
				portableExport,
				portableExport.blueprint.name,
				portableExport.revision.revision,
			);
		},
	});

	if (detail.isPending) {
		return <ListSkeleton rows={2} rowClassName="h-16" />;
	}
	if (detail.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>The blueprint is unavailable</AlertTitle>
				<AlertDescription>{(detail.error as Error).message}</AlertDescription>
			</Alert>
		);
	}

	const { blueprint, currentRevision } = detail.data;

	return (
		<Surface
			data-slot="blueprint-detail"
			className="grid min-w-0 gap-4 px-4 py-4"
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle text-xs">
				<span>
					{currentRevision
						? `Revision ${currentRevision.revision}`
						: "No revision yet"}
				</span>
				<span>
					· created{" "}
					<time
						dateTime={blueprint.createdAt}
						title={absoluteTime(blueprint.createdAt)}
					>
						{relativeTime(blueprint.createdAt)}
					</time>
				</span>
				{currentRevision?.publishedAt && (
					<span>
						· published{" "}
						<time
							dateTime={currentRevision.publishedAt}
							title={absoluteTime(currentRevision.publishedAt)}
						>
							{relativeTime(currentRevision.publishedAt)}
						</time>
					</span>
				)}
			</div>

			<div className="grid gap-2">
				<EditorLabel>Portable package</EditorLabel>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						disabled={currentRevision === null || exportPackage.isPending}
						loading={exportPackage.isPending}
						onClick={() => exportPackage.mutate(currentRevision?.id)}
						size="sm"
						variant="outline"
					>
						<DownloadSimple size={14} />
						{exportPackage.isPending ? "Exporting…" : "Export package"}
					</Button>
					<Text as="span" role="label" tone="secondary">
						Executable design and typed dependency shapes only — never
						credentials, live data, chat, or private memory.
					</Text>
				</div>
				{currentRevision === null && (
					<Text as="span" role="label" tone="secondary">
						Record a definition revision before exporting.
					</Text>
				)}
				{exportPackage.isSuccess && (
					<span className="text-kumo-success text-xs" role="status">
						Portable package downloaded.
					</span>
				)}
				{exportPackage.isError && (
					<Alert variant="destructive">
						<AlertTitle>Exporting the package failed</AlertTitle>
						<AlertDescription>
							{(exportPackage.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
			</div>

			{blueprint.status === "draft" ? (
				<DefinitionEditor
					key={currentRevision?.id ?? "unrevised"}
					blueprintId={blueprintId}
					currentRevision={currentRevision}
				/>
			) : currentRevision ? (
				<DefinitionSummary definition={currentRevision.definition} />
			) : null}

			{/* AUTHORITATIVE-ONLY. Publish stamps `publishedAt` and there is no
			    unpublish verb, so nothing here may render as published before the
			    server says so — the button stays busy and states the wait. */}
			{blueprint.status === "draft" && (
				<div
					className="flex flex-wrap items-center gap-2"
					data-pending={publish.isPending || undefined}
					aria-busy={publish.isPending || undefined}
				>
					<Button
						size="sm"
						loading={publish.isPending}
						disabled={currentRevision === null || publish.isPending}
						onClick={() => publish.mutate()}
					>
						{publish.isPending ? "Publishing…" : "Publish"}
					</Button>
					{publish.isPending && (
						<span className="text-kumo-subtle text-xs" role="status">
							Waiting for the server to confirm the publish…
						</span>
					)}
					{currentRevision === null && (
						<Text as="span" role="label" tone="secondary">
							Record a definition revision before publishing.
						</Text>
					)}
				</div>
			)}
			{publish.isError && (
				<Alert variant="destructive">
					<AlertTitle>Publishing failed</AlertTitle>
					<AlertDescription>
						{(publish.error as Error).message}
					</AlertDescription>
				</Alert>
			)}

			{blueprint.status === "published" && (
				<>
					<div className="grid gap-2">
						<EditorLabel>Gallery</EditorLabel>
						{/* Cross-org disclosure: `catalog` exposes this blueprint to every
						    authenticated tenant. Retractable, but the disclosure is not,
						    so the switch never moves before the server confirms. */}
						<div
							className="flex flex-wrap items-center gap-2"
							data-pending={setVisibility.isPending || undefined}
							aria-busy={setVisibility.isPending || undefined}
						>
							<Button
								size="sm"
								variant="outline"
								loading={setVisibility.isPending}
								disabled={setVisibility.isPending}
								onClick={() =>
									setVisibility.mutate(
										blueprint.visibility === "catalog" ? "org" : "catalog",
									)
								}
							>
								{setVisibility.isPending
									? "Saving…"
									: blueprint.visibility === "catalog"
										? "Remove from gallery"
										: "Publish to gallery"}
							</Button>
							<Text as="span" role="label" tone="secondary">
								{blueprint.visibility === "catalog"
									? "Listed in the cross-organization Explore gallery."
									: "Private to your organization."}
							</Text>
						</div>
						{setVisibility.isError && (
							<Alert variant="destructive">
								<AlertTitle>Updating gallery visibility failed</AlertTitle>
								<AlertDescription>
									{(setVisibility.error as Error).message}
								</AlertDescription>
							</Alert>
						)}
					</div>
					<div className="grid gap-2">
						<EditorLabel>Instantiate</EditorLabel>
						<InstantiateForm
							blueprintId={blueprintId}
							revisionId={currentRevision?.id}
							resourceRequirements={
								currentRevision?.definition.requirements?.resources
							}
							request={(workspaceName, resourceBindings) =>
								osApi.osWorkspaces.blueprints.instantiate({
									blueprintId,
									workspaceName,
									...(resourceBindings.length > 0 ? { resourceBindings } : {}),
								})
							}
						/>
					</div>
				</>
			)}
		</Surface>
	);
}

// ---------------------------------------------------------------------------
// Explore gallery
// ---------------------------------------------------------------------------

export function GalleryEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<BlueprintIcon size={20} />
				</EmptyMedia>
				<EmptyTitle>The gallery is empty</EmptyTitle>
				<EmptyDescription>
					No organization has published a blueprint to the gallery yet. Publish
					one of your own blueprints to share it with every tenant.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function GalleryCard({
	item,
	children,
}: {
	item: OsBlueprintGalleryItem;
	children?: ReactNode;
}) {
	return (
		<Surface as="li" className="blueprint-gallery-card overflow-hidden">
			<div className="blueprint-gallery-preview" aria-hidden="true">
				<span className="blueprint-gallery-preview-mark">
					<BlueprintIcon size={16} />
				</span>
				<div className="blueprint-gallery-preview-window">
					<span className="blueprint-gallery-preview-title" />
					<span className="blueprint-gallery-preview-line" />
					<span className="blueprint-gallery-preview-line" />
					<div className="blueprint-gallery-preview-grid">
						<span />
						<span />
						<span />
					</div>
				</div>
			</div>
			<div className="flex items-start gap-3 px-3 pt-3">
				<IconFrame aria-hidden size="sm">
					<BlueprintIcon size={16} />
				</IconFrame>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<Text as="strong" role="body" tone="strong" weight="medium" truncate>
						{item.name}
					</Text>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="flex flex-wrap items-center gap-x-2 gap-y-1"
					>
						<span>by {item.organizationName}</span>
						<span>
							· {formatCount(item.gadgetCount)}{" "}
							{item.gadgetCount === 1 ? "gadget" : "gadgets"}
						</span>
						{item.publishedAt && (
							<span>
								· published{" "}
								<time
									dateTime={item.publishedAt}
									title={absoluteTime(item.publishedAt)}
								>
									{relativeTime(item.publishedAt)}
								</time>
							</span>
						)}
					</Text>
					{item.description && (
						<Text as="span" role="label" tone="secondary">
							{item.description}
						</Text>
					)}
				</div>
			</div>
			{children ? <div className="px-3 pt-2 pb-3">{children}</div> : null}
		</Surface>
	);
}

// The gallery caps at 200 server-side; one honest page.

function GalleryExplore() {
	const queryClient = useQueryClient();
	const [query, setQuery] = useState("");
	const gallery = useQuery({
		...blueprintGalleryQueryOptions(BLUEPRINT_GALLERY_LIMIT),
		retry: false,
	});
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visibleItems = (gallery.data?.items ?? []).filter((item) =>
		[item.name, item.description ?? "", item.organizationName]
			.join(" ")
			.toLocaleLowerCase()
			.includes(normalizedQuery),
	);

	return (
		<PageSection aria-labelledby="blueprint-gallery-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="blueprint-gallery-title">
						Published blueprints
					</SectionTitle>
					<SectionDescription>
						Governed starting points shared by your organization and trusted
						tenant catalogs.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<PageToolbar aria-label="Blueprint gallery controls">
				<SearchInput
					aria-label="Search blueprint gallery"
					containerClassName="w-full sm:w-64 sm:shrink-0"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search blueprints"
					value={query}
				/>
				{gallery.data && (
					<Text
						role="label"
						tone="secondary"
						className="shrink-0"
						aria-live="polite"
					>
						{formatCount(visibleItems.length)} of{" "}
						{formatCount(gallery.data.items.length)} loaded blueprints
					</Text>
				)}
			</PageToolbar>
			{gallery.isPending && <ListSkeleton />}
			{gallery.isError && (
				<Alert variant="destructive">
					<AlertTitle>The gallery is unavailable</AlertTitle>
					<AlertDescription>
						<span>{(gallery.error as Error).message}</span>
						<Button
							variant="outline"
							size="sm"
							className="mt-2 w-fit"
							disabled={gallery.isFetching}
							onClick={() => void gallery.refetch()}
						>
							{gallery.isFetching ? "Trying again…" : "Try again"}
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{gallery.data && gallery.data.items.length === 0 && <GalleryEmpty />}
			{gallery.data &&
				gallery.data.items.length > 0 &&
				visibleItems.length === 0 && (
					<Empty appearance="quiet">
						<EmptyDescription>
							No blueprints match “{query.trim()}”.
						</EmptyDescription>
					</Empty>
				)}
			{gallery.data && visibleItems.length > 0 && (
				<ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
					{visibleItems.map((item) => (
						<GalleryCard key={item.id} item={item}>
							<InstantiateForm
								nameFieldLabel={`Workspace name for ${item.name}`}
								successNote="The blueprint was copied into your organization."
								request={async (workspaceName) => {
									const result =
										await osApi.osWorkspaces.blueprints.instantiateFromGallery({
											blueprintId: item.id,
											workspaceName,
										});
									// The copy lands in "My blueprints".
									queryClient.invalidateQueries({
										queryKey: osQueryKeys.blueprints(),
									});
									return result;
								}}
							/>
						</GalleryCard>
					))}
				</ul>
			)}
		</PageSection>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// The list caps at 200 server-side; 100 keeps one page honest and `truncated`
// tells us when more exist.

type BlueprintsTab = "mine" | "explore";

const BLUEPRINT_TABS = [
	{ value: "mine", label: "My blueprints" },
	{ value: "explore", label: "Explore" },
] as const;

const importBlueprintSchema = z.object({
	file: z.custom<File>((value) => value instanceof File, {
		message: "Choose a portable Blueprint package.",
	}),
	name: z.string().trim().max(120),
});

function BlueprintImportForm({
	onImported,
	onCancel,
}: {
	onImported: (blueprint: OsBlueprintWithVisibility) => void;
	onCancel: () => void;
}) {
	const queryClient = useQueryClient();

	const importPackage = useMutation({
		mutationFn: async (value: z.output<typeof importBlueprintSchema>) => {
			let submitted: unknown;
			try {
				submitted = JSON.parse(await readBlueprintPackageFile(value.file));
			} catch {
				throw new Error("The selected package is not valid JSON.");
			}
			const parsed = OsBlueprintExportSchema.safeParse(submitted);
			if (!parsed.success) {
				throw new Error(
					"The selected file is not a valid Tedix Blueprint package.",
				);
			}
			return osApi.osWorkspaces.blueprints.import({
				export: parsed.data,
				...(value.name ? { name: value.name } : {}),
			});
		},
		onSuccess: ({ blueprint }) => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.blueprints() });
			onImported(blueprint);
		},
	});
	const form = useZodForm({
		schema: importBlueprintSchema,
		defaultValues: { file: null as unknown as File, name: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => {
			importPackage.mutate(value);
		},
	});
	const file = useStore(form.store, (state) => state.values.file);

	const errorMessage = importPackage.isError
		? isConflictError(importPackage.error)
			? "A Blueprint with that name already exists. Enter a different imported name."
			: importPackage.error instanceof Error
				? importPackage.error.message
				: "Importing the Blueprint package failed."
		: null;

	return (
		<Surface
			as="form"
			className="grid gap-3 p-4"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<EditorLabel>Import portable package</EditorLabel>
			<Text role="label" tone="secondary" className="m-0">
				Tedix validates the versioned envelope and digest before it writes a
				private draft. Dependencies remain declarations until you preflight them
				in this organization.
			</Text>
			<FormField form={form} name="file" label="Portable Blueprint package">
				{(field, meta) => (
					<Input
						accept="application/json,.json,.tedix-blueprint.json"
						aria-describedby={meta.errorId ?? meta.descriptionId}
						aria-label="Portable Blueprint package"
						aria-invalid={meta.invalid}
						id={meta.id}
						onBlur={field.handleBlur}
						onChange={(event) => {
							field.handleChange(
								event.currentTarget.files?.[0] ?? (null as unknown as File),
							);
							importPackage.reset();
						}}
						type="file"
					/>
				)}
			</FormField>
			<FormField
				form={form}
				name="name"
				label="Imported Blueprint name"
				optional
			>
				{(field, meta) => (
					<FormInput
						field={field}
						{...meta}
						aria-label="Imported Blueprint name"
						maxLength={120}
						placeholder="Optional name override"
					/>
				)}
			</FormField>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					disabled={!file || importPackage.isPending}
					loading={importPackage.isPending}
					type="submit"
					size="sm"
				>
					<UploadSimple size={14} />
					{importPackage.isPending ? "Importing…" : "Import package"}
				</Button>
				<Button onClick={onCancel} size="sm" variant="ghost">
					Cancel
				</Button>
			</div>
			{errorMessage && (
				<Alert variant="destructive">
					<AlertTitle>Importing the package failed</AlertTitle>
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			)}
		</Surface>
	);
}

function MyBlueprints({
	selectedId,
	onSelect,
}: {
	selectedId: string | null;
	onSelect: (id: string | null) => void;
}) {
	const [query, setQuery] = useState("");
	const [visibleLimit, setVisibleLimit] = useState(
		BLUEPRINTS_VISIBLE_PAGE_SIZE,
	);
	const blueprints = useQuery({
		...blueprintListQueryOptions(BLUEPRINTS_LIST_LIMIT),
		retry: false,
	});
	const selected = blueprints.data?.items.find(
		(blueprint) => blueprint.id === selectedId,
	);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visibleItems = (blueprints.data?.items ?? []).filter((blueprint) =>
		[blueprint.name, blueprint.description ?? "", blueprint.status]
			.join(" ")
			.toLocaleLowerCase()
			.includes(normalizedQuery),
	);
	const displayedItems = visibleItems.slice(0, visibleLimit);
	const changeQuery = (value: string) => {
		setVisibleLimit(BLUEPRINTS_VISIBLE_PAGE_SIZE);
		setQuery(value);
	};

	if (selected) {
		return (
			<section className="blueprint-detail-view grid min-w-0 gap-4">
				<Button
					className="w-fit"
					onClick={() => onSelect(null)}
					size="sm"
					variant="ghost"
				>
					<ArrowLeft size={14} /> All blueprints
				</Button>
				<div className="blueprint-detail-heading">
					<div className="min-w-0">
						<div className="mb-2 flex flex-wrap items-center gap-1.5">
							<Badge variant={blueprintStatusVariant(selected.status)}>
								{sentenceCase(selected.status)}
							</Badge>
							{selected.visibility === "catalog" ? (
								<Badge variant="outline">In gallery</Badge>
							) : null}
						</div>
						<Text
							as="h2"
							role="metric"
							tone="strong"
							weight="semibold"
							className="m-0 text-balance"
						>
							{selected.name}
						</Text>
						<Text
							role="body"
							tone="secondary"
							className="m-0 mt-2 max-w-2xl leading-relaxed"
						>
							{selected.description ||
								"A versioned, governed starting point for creating a Tedix workspace."}
						</Text>
					</div>
				</div>
				<BlueprintDetail blueprintId={selected.id} />
			</section>
		);
	}

	return (
		<PageSection aria-labelledby="my-blueprints-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="my-blueprints-title">My blueprints</SectionTitle>
					<SectionDescription>
						Versioned workspace definitions owned by this organization.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<PageToolbar aria-label="Blueprint library controls">
				<SearchInput
					aria-label="Search blueprints"
					containerClassName="w-full sm:w-64 sm:shrink-0"
					onChange={(event) => changeQuery(event.target.value)}
					placeholder="Search blueprints"
					value={query}
				/>
				{blueprints.data && (
					<Text
						role="label"
						tone="secondary"
						className="shrink-0"
						aria-live="polite"
					>
						Showing {formatCount(displayedItems.length)} of{" "}
						{formatCount(visibleItems.length)}{" "}
						{query.trim() ? "matching blueprints" : "blueprints"}
					</Text>
				)}
			</PageToolbar>
			{blueprints.isPending && <ListSkeleton />}
			{blueprints.isError && (
				<Alert variant="destructive">
					<AlertTitle>Blueprints are unavailable</AlertTitle>
					<AlertDescription>
						<span>{(blueprints.error as Error).message}</span>
						<Button
							variant="outline"
							size="sm"
							className="mt-2 w-fit"
							disabled={blueprints.isFetching}
							onClick={() => void blueprints.refetch()}
						>
							{blueprints.isFetching ? "Trying again…" : "Try again"}
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{blueprints.data && blueprints.data.items.length === 0 && (
				<BlueprintsEmpty />
			)}
			{blueprints.data &&
				blueprints.data.items.length > 0 &&
				visibleItems.length === 0 && (
					<Empty appearance="quiet">
						<EmptyDescription>
							No blueprints match “{query.trim()}”.
						</EmptyDescription>
					</Empty>
				)}
			{blueprints.data && visibleItems.length > 0 && (
				<>
					<Collection
						aria-label="Owned blueprints"
						data-slot="blueprint-owned-list"
						className="min-w-0"
					>
						{displayedItems.map((blueprint) => (
							<BlueprintRow
								key={blueprint.id}
								blueprint={blueprint}
								onToggle={() => onSelect(blueprint.id)}
							/>
						))}
					</Collection>
					{visibleItems.length > BLUEPRINTS_VISIBLE_PAGE_SIZE ? (
						<div className="flex justify-end">
							{displayedItems.length < visibleItems.length ? (
								<Button
									className="w-full sm:w-auto"
									onClick={() =>
										setVisibleLimit((limit) =>
											Math.min(
												limit + BLUEPRINTS_VISIBLE_PAGE_SIZE,
												visibleItems.length,
											),
										)
									}
									variant="outline"
								>
									Show more
								</Button>
							) : null}
						</div>
					) : null}
					{blueprints.data.truncated && (
						<Text role="body" tone="secondary" className="m-0">
							Showing the first {formatCount(blueprints.data.items.length)}{" "}
							blueprints — more exist beyond this page.
						</Text>
					)}
				</>
			)}
		</PageSection>
	);
}

export function BlueprintsPage() {
	const surface = getOsSurface("blueprints");
	const [tab, setTab] = useState<BlueprintsTab>("mine");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	const [showImport, setShowImport] = useState(false);

	return (
		<Page width="lg" className="blueprints-surface">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>{surface.description}</PageDescription>
				</PageHeading>
				{tab === "mine" && (
					<PageActions>
						<Button
							onClick={() => {
								setShowImport((current) => !current);
								setShowCreate(false);
							}}
							variant="outline"
						>
							<UploadSimple size={14} />
							Import package
						</Button>
						<Button
							onClick={() => {
								setShowCreate((current) => !current);
								setShowImport(false);
							}}
						>
							<Plus size={14} />
							New blueprint
						</Button>
					</PageActions>
				)}
			</PageHeader>

			<SegmentedControl
				ariaLabel="Blueprint views"
				className="w-full sm:w-fit"
				value={tab}
				onValueChange={setTab}
				options={BLUEPRINT_TABS}
				compact
			/>

			{tab === "mine" && showCreate && (
				<CreateBlueprintForm
					onCreated={(blueprint) => {
						setShowCreate(false);
						setSelectedId(blueprint.id);
					}}
					onCancel={() => setShowCreate(false)}
				/>
			)}

			{tab === "mine" && showImport && (
				<BlueprintImportForm
					onImported={(blueprint) => {
						setShowImport(false);
						setSelectedId(blueprint.id);
					}}
					onCancel={() => setShowImport(false)}
				/>
			)}

			{tab === "mine" ? (
				<MyBlueprints selectedId={selectedId} onSelect={setSelectedId} />
			) : (
				<GalleryExplore />
			)}
		</Page>
	);
}
