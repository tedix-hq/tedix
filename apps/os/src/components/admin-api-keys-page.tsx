/**
 * Admin › API keys
 *
 * API-key management, backed by the same `organizations` oRPC contract. Full CRUD: list,
 * create, revoke, rotate, delete; the raw key is shown once on create/rotate.
 *
 * The organization id comes from the credential-resolved operational context —
 * never from the hostname or a path segment. Section access is gated once by
 * the /admin layout (`admin-layout.tsx`); the API re-checks `api_keys:manage`
 * on every mutation, so this page carries no per-page role check.
 *
 * Rotation is step-up-gated server-side (`requireStepUp` on
 * `organizations.rotateApiKey`): the stepped-up session JWT travels as a
 * mutation ARGUMENT through `getAuthenticatedOsApi(token)` because the OS
 * same-origin `/api` proxy strips Authorization — see `@/lib/step-up-auth`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import type { ApiKey } from "@tedix/api-contract/schemas/organization";
import {
	API_KEY_SCOPE_GROUPS,
	API_KEY_SCOPE_METADATA,
	type ApiKeyScope,
	type ApiKeyScopeGroup,
	TENANT_DELEGABLE_API_KEY_SCOPES,
} from "@tedix/api-contract/schemas/organization";
import {
	ArrowsClockwise,
	CalendarDots,
	DotsThree,
	Key,
	Plus,
	ShieldWarning,
	Trash,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import {
	buildApiKeysWebMcpTools,
	type ApiKeyDraft,
} from "@/components/api-keys-webmcp-tools";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/kumo/alert-dialog";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { DataTable, type TableColumn } from "@/components/kumo/data-table";
import { DatePicker } from "@/components/kumo/date-picker";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Loader } from "@/components/kumo/loader";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Pagination } from "@/components/kumo/pagination";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/kumo/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Separator } from "@/components/kumo/separator";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { getAuthenticatedOsApi, osApi } from "@/lib/api";
import {
	API_KEYS_PAGE_SIZE,
	apiKeyListQueryOptions,
	EXPIRING_API_KEYS_WINDOW_DAYS,
	expiringApiKeysQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { useStepUpAuth, useStepUpResume } from "@/lib/step-up-auth";
import { normalizeD1Timestamp, relativeTime } from "@/lib/time";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type KeyAction = {
	type: "rotate" | "revoke" | "delete";
	id: string;
	name: string;
};

export function keyActionTitle(action: KeyAction | null): string {
	if (action?.type === "rotate") return `Rotate ${action.name}?`;
	if (action?.type === "revoke") return `Revoke ${action.name}?`;
	return `Delete ${action?.name ?? "API key"}?`;
}

export function keyActionDescription(action: KeyAction | null): string {
	if (action?.type === "rotate") {
		return "The current key will stop working immediately. You must update every service that uses it.";
	}
	if (action?.type === "revoke") {
		return "This key will stop working immediately. You can delete the record afterward.";
	}
	return "This permanently removes the key record. This action cannot be undone.";
}

export function keyActionLabel(action: KeyAction | null): string {
	if (action?.type === "rotate") return "Rotate key";
	if (action?.type === "revoke") return "Revoke key";
	return "Delete key";
}

/** Row timestamp: relative, D1-normalized; null input reads as absence. */
export function keyTimestampLabel(iso: string | null): string {
	return iso ? relativeTime(normalizeD1Timestamp(iso)) : "Never";
}

/**
 * Treat an expiration as a calendar-day policy, matching the Cloudflare token
 * flow. The credential remains valid through the selected UTC day rather than
 * expiring at an implicit browser-local instant.
 */
export function apiKeyExpirationDateToIso(
	value: Date | undefined,
): string | undefined {
	if (!value || Number.isNaN(value.getTime())) return undefined;
	return new Date(
		Date.UTC(
			value.getFullYear(),
			value.getMonth(),
			value.getDate(),
			23,
			59,
			59,
			999,
		),
	).toISOString();
}

export function apiKeyExpirationDateLabel(
	value: Date,
	locale?: Intl.LocalesArgument,
): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(value);
}

// ---------------------------------------------------------------------------
// Step-up round trip
// ---------------------------------------------------------------------------

/**
 * Key issuance and rotation are step-up gated. A redirecting step-up persists
 * only mutation input; the stepped-up JWT and raw key stay in memory.
 * See `@/lib/step-up-continuation` for the one-shot guarantee.
 */
export const CREATE_API_KEY_STEP_UP_INTENT = "admin-api-keys:create";
export const ROTATE_API_KEY_STEP_UP_INTENT = "admin-api-keys:rotate";

export interface CreateKeyDraft {
	name: string;
	description: string;
	environment: "test" | "live";
	scopes: ApiKeyScope[];
}

export function parseCreateKeyDraft(payload: unknown): CreateKeyDraft | null {
	if (!payload || typeof payload !== "object") return null;
	const draft = payload as Partial<CreateKeyDraft>;
	if (typeof draft.name !== "string" || draft.name.trim() === "") return null;
	if (draft.environment !== "test" && draft.environment !== "live") return null;
	if (!Array.isArray(draft.scopes)) return null;
	const scopes = draft.scopes.filter((scope): scope is ApiKeyScope =>
		(TENANT_DELEGABLE_API_KEY_SCOPES as readonly string[]).includes(scope),
	);
	if (scopes.length === 0) return null;
	return {
		name: draft.name,
		description: typeof draft.description === "string" ? draft.description : "",
		environment: draft.environment,
		scopes,
	};
}

export interface RotateKeyIntent {
	keyId: string;
	name: string;
}

export function parseRotateKeyIntent(payload: unknown): RotateKeyIntent | null {
	if (!payload || typeof payload !== "object") return null;
	const intent = payload as Partial<RotateKeyIntent>;
	if (typeof intent.keyId !== "string" || intent.keyId === "") return null;
	return { keyId: intent.keyId, name: intent.name ?? "API key" };
}

export function scopesSummary(scopes: readonly string[] | null): string {
	if (!scopes || scopes.length === 0) return "--";
	if (scopes.includes("*")) return "Full access";
	return `${scopes.length} scope${scopes.length > 1 ? "s" : ""}`;
}

export function apiKeyStatusVariant(status: ApiKey["status"]): BadgeVariant {
	if (status === "active" || status === null) return "success";
	if (status === "revoked") return "destructive";
	return "secondary";
}

function ApiKeyActionsMenu({
	apiKey,
	onAction,
}: {
	apiKey: ApiKey;
	onAction: (action: KeyAction) => void;
}) {
	const status = apiKey.status ?? "active";
	const { id, name } = apiKey;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={`API key actions for ${name}`}
						className="max-sm:min-h-11 max-sm:min-w-11"
						size="icon-sm"
						variant="ghost"
					/>
				}
			>
				<DotsThree className="size-4" weight="bold" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{status === "active" ? (
					<>
						<DropdownMenuItem
							onClick={() => onAction({ type: "rotate", id, name })}
						>
							<ArrowsClockwise className="size-3.5" />
							Rotate
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => onAction({ type: "revoke", id, name })}
							variant="destructive"
						>
							<ShieldWarning className="size-3.5" />
							Revoke
						</DropdownMenuItem>
					</>
				) : null}
				<DropdownMenuItem
					onClick={() => onAction({ type: "delete", id, name })}
					variant="destructive"
				>
					<Trash className="size-3.5" />
					Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Narrow-screen projection of the same credential ledger. A horizontally
 * scrollable eight-column table is appropriate only once every recency and
 * policy column retains useful width. Below the large breakpoint its sticky
 * name and action columns obscure the state people need to scan before
 * rotating or revoking a key.
 */
export function ApiKeyMobileRow({
	apiKey,
	onAction,
}: {
	apiKey: ApiKey;
	onAction: (action: KeyAction) => void;
}) {
	const status = apiKey.status ?? "active";
	return (
		<li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-3 py-3">
			<div className="grid min-w-0 gap-1">
				<div className="flex min-w-0 items-center gap-2">
					<Key className="size-3.5 shrink-0 text-kumo-subtle" />
					<Text as="strong" weight="medium" truncate title={apiKey.name}>
						{apiKey.name}
					</Text>
				</div>
				<Text as="span" role="label" tone="mono-secondary">
					{apiKey.keyPreview}
				</Text>
			</div>
			<ApiKeyActionsMenu apiKey={apiKey} onAction={onAction} />
			<div className="col-span-2 flex flex-wrap items-center gap-1.5">
				<Badge
					variant={apiKey.environment === "live" ? "default" : "secondary"}
				>
					{apiKey.environment ?? "test"}
				</Badge>
				<Badge variant={apiKeyStatusVariant(apiKey.status)}>
					{status.charAt(0).toUpperCase() + status.slice(1)}
				</Badge>
				<Badge variant="outline">{scopesSummary(apiKey.scopes)}</Badge>
			</div>
			<Text as="span" role="label" tone="secondary" className="col-span-2">
				Last used {keyTimestampLabel(apiKey.lastUsedAt)} · Created{" "}
				{keyTimestampLabel(apiKey.createdAt)}
			</Text>
		</li>
	);
}

function mutationErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

type ExpiringKey = ApiKey & { warningType: "expiring" | "rotation_overdue" };

/** One sentence for the expiring-keys banner; null when nothing needs action. */
export function expiringKeysSummary(
	keys: readonly Pick<ExpiringKey, "name" | "warningType">[],
	withinDays: number,
): string | null {
	if (keys.length === 0) return null;
	const expiring = keys.filter((key) => key.warningType === "expiring");
	const overdue = keys.filter((key) => key.warningType === "rotation_overdue");
	const parts: string[] = [];
	if (expiring.length > 0) {
		parts.push(
			`${expiring.map((key) => key.name).join(", ")} ${expiring.length === 1 ? "expires" : "expire"} within ${withinDays} days`,
		);
	}
	if (overdue.length > 0) {
		parts.push(
			`${overdue.map((key) => key.name).join(", ")} ${overdue.length === 1 ? "is" : "are"} overdue for rotation`,
		);
	}
	return `${parts.join("; ")}.`;
}

function ApiKeysPanelPending() {
	return (
		<PageSection aria-busy="true" aria-label="Loading API keys">
			<Surface tier="panel" className="space-y-3 p-4">
				{Array.from({ length: 3 }).map((_, index) => (
					<Skeleton className="h-16 w-full" key={index} />
				))}
			</Surface>
		</PageSection>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AdminApiKeysPage({
	page,
	onPageChange,
}: {
	/** 1-based page from the route's validated search — never component state. */
	page: number;
	onPageChange: (page: number) => void;
}) {
	const context = useOsOperationalContext();

	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>API keys</PageTitle>
					<PageDescription>
						Manage API keys for programmatic access to the Tedix API
					</PageDescription>
				</PageHeading>
			</PageHeader>
			{context.isPending ? (
				<ApiKeysPanelPending />
			) : context.isError || !context.data ? (
				<Alert variant="destructive">
					<AlertTitle>API keys are unavailable</AlertTitle>
					<AlertDescription>
						{mutationErrorMessage(
							context.error,
							"The operational context read failed.",
						)}
					</AlertDescription>
				</Alert>
			) : (
				<AdminApiKeysBody
					onPageChange={onPageChange}
					descopeTenantId={
						context.data.organization.descopeTenantId ?? undefined
					}
					organizationId={context.data.organization.id}
					page={page}
				/>
			)}
		</Page>
	);
}

function AdminApiKeysBody({
	descopeTenantId,
	organizationId,
	page,
	onPageChange,
}: {
	descopeTenantId?: string;
	organizationId: string;
	page: number;
	onPageChange: (page: number) => void;
}) {
	const queryClient = useQueryClient();
	const offset = (page - 1) * API_KEYS_PAGE_SIZE;
	const createResume = useStepUpResume<CreateKeyDraft>({
		key: CREATE_API_KEY_STEP_UP_INTENT,
		parse: parseCreateKeyDraft,
	});
	const rotateResume = useStepUpResume<RotateKeyIntent>({
		key: ROTATE_API_KEY_STEP_UP_INTENT,
		parse: parseRotateKeyIntent,
	});
	const [showCreate, setShowCreate] = useState(createResume.intent !== null);
	const [initialDraft, setInitialDraft] = useState<ApiKeyDraft | null>(null);
	const [pendingAction, setPendingAction] = useState<KeyAction | null>(null);
	const [rawKeyDialog, setRawKeyDialog] = useState<{
		rawKey: string;
		name: string;
	} | null>(null);
	const [actionFailure, setActionFailure] = useState<string | null>(
		createResume.failure ?? rotateResume.failure,
	);

	const listQuery = useQuery({
		...apiKeyListQueryOptions({
			organizationId,
			limit: API_KEYS_PAGE_SIZE,
			offset,
		}),
		staleTime: 30_000,
	});

	// `organizations.getExpiringKeys`: a quiet read — the banner renders only when a key
	// actually needs attention, and a failed read stays silent.
	const expiringQuery = useQuery(
		expiringApiKeysQueryOptions(organizationId, EXPIRING_API_KEYS_WINDOW_DAYS),
	);

	/** Every mutation can change both the list and the expiring set. */
	function invalidate() {
		return Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.apiKeys() }),
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.expiringApiKeys(),
			}),
		]);
	}

	const revokeMutation = useMutation({
		mutationFn: (keyId: string) =>
			osApi.organizations.revokeApiKey({ organizationId, keyId }),
		onSuccess: async () => {
			await invalidate();
			setPendingAction(null);
		},
		onError: (error) =>
			setActionFailure(mutationErrorMessage(error, "Failed to revoke API key")),
	});

	const deleteMutation = useMutation({
		mutationFn: (keyId: string) =>
			osApi.organizations.deleteApiKey({ organizationId, keyId }),
		onSuccess: async () => {
			await invalidate();
			setPendingAction(null);
		},
		onError: (error) =>
			setActionFailure(mutationErrorMessage(error, "Failed to delete API key")),
	});

	// Step-up: the API rejects organizations.rotateApiKey unless the presented
	// token carries Descope's `su` claim. The token travels as a mutation
	// argument rather than component state — the step-up callback fires and the
	// mutation is dispatched in the same tick, so a `useState` token would still
	// be null when `mutationFn` read it.
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		tenantId: descopeTenantId,
		title: "Confirm your identity",
		description:
			"Rotating an API key issues a new live credential. Please re-authenticate to continue.",
		onFailure: (message) => setActionFailure(message),
		// A step-up flow that redirects loses this component. The key id rides
		// the round trip in sessionStorage so the rotation still happens.
		intentKey: ROTATE_API_KEY_STEP_UP_INTENT,
		autoResume: rotateResume.intent !== null,
		onResume: (steppedUpToken) => {
			const keyId = rotateResume.intent?.keyId;
			if (!keyId) return;
			rotateMutation.mutate({ keyId, steppedUpToken });
		},
	});

	const rotateMutation = useMutation({
		mutationFn: ({
			keyId,
			steppedUpToken,
		}: {
			keyId: string;
			steppedUpToken: string;
		}) =>
			getAuthenticatedOsApi(steppedUpToken).organizations.rotateApiKey({
				organizationId,
				keyId,
			}),
		onSuccess: (result) => {
			setPendingAction(null);
			setRawKeyDialog({ rawKey: result.rawKey, name: result.apiKey.name });
			void invalidate();
		},
		onError: (error) =>
			setActionFailure(mutationErrorMessage(error, "Failed to rotate API key")),
	});

	// A synchronous reservation prevents concurrent browser calls from replacing
	// a human draft before React has rendered the dialog. No step-up intent is
	// manufactured by the browser adapter.
	const webMcpContext = useRef({
		organizationId,
		offset,
		limit: API_KEYS_PAGE_SIZE,
		busy: false,
	});
	webMcpContext.current = {
		organizationId,
		offset,
		limit: API_KEYS_PAGE_SIZE,
		busy:
			showCreate ||
			pendingAction !== null ||
			rawKeyDialog !== null ||
			rotateMutation.isPending ||
			revokeMutation.isPending ||
			deleteMutation.isPending ||
			rotateResume.intent !== null,
	};
	useWebMcpTools(
		"api-keys",
		() =>
			buildApiKeysWebMcpTools({
				context: () => webMcpContext.current,
				prepareCreate: (draft) => {
					if (webMcpContext.current.busy) return false;
					webMcpContext.current.busy = true;
					setInitialDraft(draft);
					setShowCreate(true);
					return true;
				},
				prepareAction: (action) => {
					if (webMcpContext.current.busy) return false;
					webMcpContext.current.busy = true;
					setPendingAction(action);
					return true;
				},
			}),
		[organizationId, offset],
	);

	const data = listQuery.data;
	const keys = data?.data ?? [];
	const total = data?.pagination.total ?? 0;
	const expiringSummary = expiringQuery.data
		? expiringKeysSummary(
				expiringQuery.data.data,
				EXPIRING_API_KEYS_WINDOW_DAYS,
			)
		: null;

	const actionMutation =
		pendingAction?.type === "rotate"
			? rotateMutation
			: pendingAction?.type === "revoke"
				? revokeMutation
				: deleteMutation;

	const columns: TableColumn<ApiKey>[] = [
		{
			header: "Name",
			width: "180px",
			sticky: "left",
			accessor: (row) => (
				<div className="flex items-center gap-2">
					<Key className="size-3.5 text-kumo-subtle" />
					<Text as="span" weight="medium">
						{row.name}
					</Text>
				</div>
			),
		},
		{
			header: "Key",
			accessor: (row) => (
				<Text as="span" role="label" tone="mono-secondary">
					{row.keyPreview}
				</Text>
			),
		},
		{
			header: "Environment",
			accessor: (row) => (
				<Badge variant={row.environment === "live" ? "default" : "secondary"}>
					{row.environment ?? "test"}
				</Badge>
			),
		},
		{
			header: "Status",
			accessor: (row) => {
				const status = row.status ?? "active";
				return (
					<Badge variant={apiKeyStatusVariant(row.status)}>
						{status.charAt(0).toUpperCase() + status.slice(1)}
					</Badge>
				);
			},
		},
		{
			header: "Scopes",
			accessor: (row) =>
				row.scopes?.includes("*") ? (
					<Badge variant="outline">Full access</Badge>
				) : (
					<Text as="span" role="label" tone="secondary">
						{scopesSummary(row.scopes)}
					</Text>
				),
		},
		{
			header: "Last used",
			accessor: (row) => (
				<Text as="span" role="label" tone="secondary">
					{keyTimestampLabel(row.lastUsedAt)}
				</Text>
			),
		},
		{
			header: "Created",
			accessor: (row) => (
				<Text as="span" role="label" tone="secondary">
					{keyTimestampLabel(row.createdAt)}
				</Text>
			),
		},
		{
			header: "",
			width: "48px",
			align: "right",
			sticky: "right",
			accessor: (row) => (
				<ApiKeyActionsMenu apiKey={row} onAction={setPendingAction} />
			),
		},
	];

	return (
		<>
			{expiringSummary ? (
				<Alert variant="warning">
					<AlertTitle>Keys need rotation</AlertTitle>
					<AlertDescription>{expiringSummary}</AlertDescription>
				</Alert>
			) : null}

			{actionFailure ? (
				<Alert variant="destructive">
					<AlertTitle>The last key action failed</AlertTitle>
					<AlertDescription>{actionFailure}</AlertDescription>
				</Alert>
			) : null}

			<PageSection aria-labelledby="api-key-list-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="api-key-list-title">Keys ({total})</SectionTitle>
						<SectionDescription>
							Active and revoked credentials for this organization.
						</SectionDescription>
					</SectionHeading>
					<SectionActions>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										aria-label="Refresh API keys"
										className="max-sm:min-h-11 max-sm:min-w-11"
										disabled={listQuery.isFetching}
										onClick={() => void listQuery.refetch()}
										size="icon-sm"
										variant="ghost"
									/>
								}
							>
								{listQuery.isFetching ? (
									<Loader aria-label="Refreshing" size={14} />
								) : (
									<ArrowsClockwise className="size-3.5" />
								)}
							</TooltipTrigger>
							<TooltipContent>Refresh</TooltipContent>
						</Tooltip>
						<Button
							className="max-sm:min-h-11"
							onClick={() => {
								setInitialDraft(null);
								setShowCreate(true);
							}}
							size="sm"
						>
							<Plus className="size-4" />
							Create key
						</Button>
					</SectionActions>
				</SectionHeader>
				<Surface tier="panel" className="overflow-hidden">
					{keys.length > 0 ? (
						<Collection
							aria-label="API keys"
							className="rounded-none border-0 lg:hidden"
						>
							{keys.map((apiKey) => (
								<ApiKeyMobileRow
									key={apiKey.id}
									apiKey={apiKey}
									onAction={setPendingAction}
								/>
							))}
						</Collection>
					) : null}
					<DataTable
						className={keys.length > 0 ? "max-lg:hidden" : undefined}
						data={keys}
						columns={columns}
						error={
							listQuery.isError
								? mutationErrorMessage(listQuery.error, "The key read failed.")
								: null
						}
						errorTitle="The API key list is unavailable"
						isLoading={listQuery.isPending}
						loadingRows={3}
						onRetry={() => void listQuery.refetch()}
						rowKey="id"
						scrollLabel="API keys"
						tableClassName="min-w-[760px]"
						emptyTitle="No API keys"
						emptyMessage="Create your first API key to get started."
						emptyIcon={<Key className="size-8 text-kumo-subtle" />}
					/>
					{total > 0 ? (
						<Pagination
							className="flex-col items-stretch gap-3 border-t px-4 py-4 sm:flex-row sm:items-center sm:px-6"
							page={page}
							perPage={API_KEYS_PAGE_SIZE}
							totalCount={total}
							setPage={onPageChange}
						>
							<Pagination.Info />
							<Pagination.Controls controls="simple" />
						</Pagination>
					) : null}
				</Surface>
			</PageSection>

			{showCreate ? (
				<CreateKeyDialog
					descopeTenantId={descopeTenantId}
					organizationId={organizationId}
					resume={createResume.intent}
					initialDraft={initialDraft}
					onCreated={(rawKey, name) => {
						setShowCreate(false);
						setRawKeyDialog({ rawKey, name });
						void invalidate();
					}}
					onCancel={() => setShowCreate(false)}
				/>
			) : null}

			{rawKeyDialog ? (
				<RawKeyDialog
					rawKey={rawKeyDialog.rawKey}
					name={rawKeyDialog.name}
					onClose={() => setRawKeyDialog(null)}
				/>
			) : null}

			<AlertDialog
				open={pendingAction !== null}
				onOpenChange={(open) => {
					if (open) return;
					if (actionMutation.isPending) return;
					actionMutation.reset();
					setPendingAction(null);
				}}
			>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{keyActionTitle(pendingAction)}</AlertDialogTitle>
						<AlertDialogDescription>
							{keyActionDescription(pendingAction)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{actionMutation.isError && actionFailure ? (
						<Alert variant="destructive">
							<AlertTitle>The key action failed</AlertTitle>
							<AlertDescription>{actionFailure}</AlertDescription>
						</Alert>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={actionMutation.isPending}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={!pendingAction || actionMutation.isPending}
							onClick={(event) => {
								if (!pendingAction) return;
								setActionFailure(null);
								// Dialog.Close closes on click regardless of preventDefault.
								// Revoke and delete keep this dialog open until the request
								// settles; rotation hands off to the step-up dialog.
								if (pendingAction.type !== "rotate")
									event.preventBaseUIHandler();
								if (pendingAction.type === "rotate") {
									const keyId = pendingAction.id;
									const name = pendingAction.name;
									requireStepUp(
										(steppedUpToken) =>
											rotateMutation.mutate({ keyId, steppedUpToken }),
										{ keyId, name } satisfies RotateKeyIntent,
									);
								}
								if (pendingAction.type === "revoke")
									revokeMutation.mutate(pendingAction.id);
								if (pendingAction.type === "delete")
									deleteMutation.mutate(pendingAction.id);
							}}
							variant={
								pendingAction?.type === "rotate" ? "default" : "destructive"
							}
						>
							{actionMutation.isPending
								? "Working…"
								: keyActionLabel(pendingAction)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<StepUpDialog />
		</>
	);
}

// ---------------------------------------------------------------------------
// Create Key Dialog
// ---------------------------------------------------------------------------

const SCOPE_GROUP_LABELS: Record<ApiKeyScopeGroup, string> = {
	apps: "Apps",
	tedis: "Digital workers",
	organization: "Organization",
	automation: "Automation",
};

/**
 * Least-privilege starting point: read-only across the surfaces a key is
 * normally minted for. Every write scope is an explicit opt-in. The API
 * refuses `["*"]` from any non-platform caller (`assertDelegatableApiKeyScopes`),
 * so a wildcard default would break key creation for ordinary tenant admins.
 */
export const DEFAULT_KEY_SCOPES = [
	"apps:read",
	"analytics:read",
] as const satisfies readonly ApiKeyScope[];

const apiKeyFormSchema = z.object({
	name: z.string().trim().min(1, "Enter a key name."),
	description: z.string().trim(),
	environment: z.enum(["test", "live"]),
	scopes: z.array(z.custom<ApiKeyScope>()).min(1, "Select at least one scope."),
	expirationDate: z.date().optional(),
	ipAllowlist: z.string(),
	rotationScheduleDays: z
		.string()
		.refine((value) => !value || Number(value) >= 1, "Use at least 1 day."),
});

function CreateKeyDialog({
	descopeTenantId,
	organizationId,
	resume,
	initialDraft,
	onCreated,
	onCancel,
}: {
	descopeTenantId?: string;
	organizationId: string;
	resume: CreateKeyDraft | null;
	initialDraft: ApiKeyDraft | null;
	onCreated: (rawKey: string, name: string) => void;
	onCancel: () => void;
}) {
	const draft = resume ?? initialDraft;
	const [expirationPickerOpen, setExpirationPickerOpen] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [stepUpFailure, setStepUpFailure] = useState<string | null>(null);
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		tenantId: descopeTenantId,
		description: "Creating an API key requires re-authentication to proceed.",
		onFailure: (message) => setStepUpFailure(message),
		intentKey: CREATE_API_KEY_STEP_UP_INTENT,
		autoResume: resume !== null,
		onResume: (steppedUpToken) => mutation.mutate({ steppedUpToken }),
	});

	const form = useZodForm({
		schema: apiKeyFormSchema,
		defaultValues: {
			name: draft?.name ?? "",
			description: draft?.description ?? "",
			environment: draft?.environment ?? "test",
			scopes: draft ? [...draft.scopes] : [...DEFAULT_KEY_SCOPES],
			expirationDate: undefined,
			ipAllowlist: "",
			rotationScheduleDays: "",
		},
		validateOn: "submit",
		onSubmit: ({ value }) => {
			if (!reviewing) {
				setReviewing(true);
				return;
			}
			setStepUpFailure(null);
			requireStepUp((steppedUpToken) => mutation.mutate({ steppedUpToken }), {
				name: value.name,
				description: value.description,
				environment: value.environment,
				scopes: value.scopes,
			} satisfies CreateKeyDraft);
		},
	});
	const values = useStore(form.store, (state) => state.values);

	const toggleScope = (scope: ApiKeyScope, checked: boolean) =>
		form.setFieldValue("scopes", (current) =>
			checked
				? current.includes(scope)
					? current
					: [...current, scope]
				: current.filter((entry) => entry !== scope),
		);

	const mutation = useMutation({
		mutationFn: ({ steppedUpToken }: { steppedUpToken: string }) =>
			getAuthenticatedOsApi(steppedUpToken).organizations.createApiKey({
				organizationId,
				name: values.name,
				description: values.description || undefined,
				environment: values.environment,
				scopes: values.scopes,
				ipAllowlist: values.ipAllowlist
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean),
				expiresAt: apiKeyExpirationDateToIso(values.expirationDate),
				rotationScheduleDays: values.rotationScheduleDays
					? Number(values.rotationScheduleDays)
					: undefined,
			}),
		onSuccess: (result) => onCreated(result.rawKey, result.apiKey.name),
	});

	return (
		<Dialog open onOpenChange={(open) => !open && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create API key</DialogTitle>
					<DialogDescription>
						The key will only be shown once. Store it securely.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{reviewing ? (
						<Surface className="space-y-3 p-4">
							<Text weight="medium">Review token summary</Text>
							<Text>Name: {values.name}</Text>
							<Text>Environment: {values.environment}</Text>
							<Text>
								Permissions:{" "}
								{values.scopes
									.map((scope) => API_KEY_SCOPE_METADATA[scope].label)
									.join(", ")}
							</Text>
							<Text>
								Expiration:{" "}
								{values.expirationDate
									? apiKeyExpirationDateLabel(values.expirationDate)
									: "None"}
							</Text>
							<Text>
								IP restrictions: {values.ipAllowlist.trim() || "None"}
							</Text>
							<Text>
								Rotation reminder:{" "}
								{values.rotationScheduleDays
									? `${values.rotationScheduleDays} days`
									: "None"}
							</Text>
						</Surface>
					) : (
						<>
							<FormField form={form} name="name" label="Name">
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder="e.g. CI/CD Pipeline"
									/>
								)}
							</FormField>

							<div className="space-y-2">
								<Label htmlFor="key-expiry">Expiration date (optional)</Label>
								<Popover
									open={expirationPickerOpen}
									onOpenChange={setExpirationPickerOpen}
								>
									<PopoverTrigger
										render={
											<Button
												aria-label="Expiration date"
												className="w-full justify-start"
												id="key-expiry"
												icon={<CalendarDots aria-hidden className="size-4" />}
												variant="outline"
											/>
										}
									>
										{values.expirationDate
											? apiKeyExpirationDateLabel(values.expirationDate)
											: "No expiration"}
									</PopoverTrigger>
									<PopoverContent align="start" className="w-auto p-3">
										<DatePicker
											mode="single"
											selected={values.expirationDate}
											onChange={(date) => {
												form.setFieldValue("expirationDate", date);
												if (date) setExpirationPickerOpen(false);
											}}
										/>
									</PopoverContent>
								</Popover>
							</div>

							<FormField
								form={form}
								name="ipAllowlist"
								label="Allowed IP ranges"
								description="Comma-separated CIDR ranges."
								optional
							>
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder="192.0.2.10/32, 198.51.100.0/24"
									/>
								)}
							</FormField>

							<FormField
								form={form}
								name="rotationScheduleDays"
								label="Rotation reminder (days)"
								optional
							>
								{(field, meta) => (
									<FormInput field={field} {...meta} min="1" type="number" />
								)}
							</FormField>

							<FormField
								form={form}
								name="description"
								label="Description"
								optional
							>
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder="What is this key for?"
									/>
								)}
							</FormField>

							<FormField form={form} name="environment" label="Environment">
								{(field, meta) => (
									<FormSelect field={field} {...meta}>
										<SelectItem value="test">Test</SelectItem>
										<SelectItem value="live">Live</SelectItem>
									</FormSelect>
								)}
							</FormField>

							<div className="space-y-2">
								<Label>Scopes</Label>
								<Text role="label" tone="secondary">
									Grant only what this key needs. A key with no scope can call
									nothing.
								</Text>
								<Surface className="max-h-64 space-y-3 overflow-y-auto p-3">
									{API_KEY_SCOPE_GROUPS.map((group) => {
										const inGroup = TENANT_DELEGABLE_API_KEY_SCOPES.filter(
											(scope) => API_KEY_SCOPE_METADATA[scope].group === group,
										);
										if (inGroup.length === 0) return null;
										return (
											<fieldset key={group}>
												<Text
													as="legend"
													className="mb-1 uppercase tracking-wide"
													role="caption"
													tone="secondary"
													weight="medium"
												>
													{SCOPE_GROUP_LABELS[group]}
												</Text>
												<div className="space-y-1.5">
													{inGroup.map((scope) => {
														const meta = API_KEY_SCOPE_METADATA[scope];
														return (
															<Checkbox
																checked={values.scopes.includes(scope)}
																key={scope}
																label={
																	<span className="flex flex-col">
																		<Text as="span">
																			{meta.label}
																			{meta.write ? (
																				<Badge
																					className="ml-2"
																					variant="outline"
																				>
																					Write
																				</Badge>
																			) : null}
																		</Text>
																		<Text
																			as="span"
																			role="label"
																			tone="secondary"
																		>
																			{meta.description}
																		</Text>
																	</span>
																}
																onCheckedChange={(checked) =>
																	toggleScope(scope, checked === true)
																}
															/>
														);
													})}
												</div>
											</fieldset>
										);
									})}
								</Surface>
							</div>
						</>
					)}

					{mutation.isError || stepUpFailure ? (
						<Alert variant="destructive">
							<AlertTitle>The key was not created</AlertTitle>
							<AlertDescription>
								{stepUpFailure ??
									mutationErrorMessage(
										mutation.error,
										"Failed to create API key",
									)}
							</AlertDescription>
						</Alert>
					) : null}
				</div>

				<DialogFooter>
					<Button
						onClick={() => (reviewing ? setReviewing(false) : onCancel())}
						variant="outline"
					>
						{reviewing ? "Edit token" : "Cancel"}
					</Button>
					<Button
						disabled={
							!values.name.trim() ||
							values.scopes.length === 0 ||
							mutation.isPending
						}
						onClick={() => {
							void form.handleSubmit();
						}}
					>
						{mutation.isPending
							? "Creating…"
							: reviewing
								? "Create token"
								: "Continue to summary"}
					</Button>
				</DialogFooter>
			</DialogContent>
			<StepUpDialog />
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// Raw Key Display Dialog (shown once after create/rotate)
// ---------------------------------------------------------------------------

function RawKeyDialog({
	rawKey,
	name,
	onClose,
}: {
	rawKey: string;
	name: string;
	onClose: () => void;
}) {
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>API key created</DialogTitle>
					<DialogDescription>
						Copy your key now — it won't be shown again.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<Text weight="medium">{name}</Text>
					<ClipboardText text={rawKey} />
				</div>

				<Separator />

				<Text role="label" tone="secondary">
					Store this key in a secure location. You will not be able to see it
					again after closing this dialog.
				</Text>

				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
