import {
	ArrowRight,
	Article,
	Browser,
	Buildings,
	CaretDown,
	Check,
	Copy,
	type Icon,
	MagnifyingGlass,
	PlugsConnected,
	Plus,
	SignOut,
	Signpost,
	UserCircle,
} from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import * as z from "zod";
import {
	buildLocalOsUrl,
	buildTenantOsUrl,
	type DirectorySurface,
	type LauncherWorkspace,
	suggestOsOrganizationSlug,
	resolveOsPlatformDomain,
} from "@/account/launcher-routing";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card } from "@/components/kumo/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Kbd } from "@/components/kumo/kbd";
import { Link } from "@/components/kumo/link";
import { SearchInput } from "@/components/kumo/search-input";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { OS_LOGOUT_PATH } from "@/shared/session-status";
import { TedixBrandMark } from "@/shared/tedix-brand";

/**
 * The bounded panel every account surface centers inside the full-viewport
 * `.org-launcher` interstitial. `Surface` owns background, semantic line, and
 * radius; only the lane width and the phone-width edge-to-edge collapse stay
 * here, because both are layout rather than surface tone.
 */
const LAUNCHER_PANEL =
	"flex w-full flex-col gap-4 p-5 sm:p-8 max-md:min-h-dvh max-md:rounded-none max-md:border-0";

/**
 * The same treatment `PageHeading` gives an in-shell route title. These
 * surfaces render outside the shell, so they compose the class directly rather
 * than mounting a `Page` lane they have no header/actions for.
 */
const PANEL_TITLE =
	"text-balance font-semibold text-xl leading-tight sm:text-2xl";

/** Divided-collection row rhythm, shared by the enabled and provisioning rows. */
const WORKSPACE_ROW =
	"group/row flex min-h-15 items-center gap-2 px-2 py-1.5 transition-colors duration-tedix-fast ease-tedix-standard motion-reduce:transition-none max-[460px]:min-h-17 max-[460px]:px-1";

/**
 * Presentation metadata per surface. The directory owns provisioning and
 * canonical URLs; the launcher owns only how each surface is labeled and which
 * ones route out (os/cms) versus copy (mcp).
 */
const SURFACE_META: Record<
	DirectorySurface,
	{ label: string; description: string; Icon: Icon }
> = {
	os: { label: "OS", description: "Working interface", Icon: Browser },
	cms: { label: "CMS", description: "Emdash content admin", Icon: Article },
	mcp: {
		label: "MCP gateway",
		description: "Copy to connect your tools",
		Icon: PlugsConnected,
	},
};

const RECENT_WORKSPACES_KEY = "tedix:recent-workspaces";

/** Debounce before the pre-submit availability read fires while the user types. */
const SLUG_AVAILABILITY_DEBOUNCE_MS = 350;

/**
 * A syntactically valid DNS label — the same shape the API's hostname grammar
 * accepts. The pre-submit availability check only fires for a well-formed slug;
 * the server stays the uniqueness and grammar authority.
 */
const WELL_FORMED_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const organizationOnboardingSchema = z.object({
	name: z.string().trim().min(1, "Enter a workspace name.").max(120),
	slug: z
		.string()
		.trim()
		.regex(WELL_FORMED_SLUG, "Enter a valid workspace URL."),
});

function readRecentWorkspaceIds(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const value = JSON.parse(
			window.localStorage.getItem(RECENT_WORKSPACES_KEY) ?? "[]",
		);
		return Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

function displayHost(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return value;
	}
}

export interface OnboardingOrganization {
	id: string;
	name: string;
	slug: string;
}

/**
 * Matches the typed oRPC CONFLICT error the API throws when the requested
 * workspace URL is already taken. Every other failure — most importantly the
 * non-atomic provisioning SERVICE_UNAVAILABLE — is a retry-the-same-submit
 * case, because the server reuses whatever it already provisioned.
 */
/** Long enough to read "Your workspace is ready", short enough to feel instant. */
export const ONBOARDING_SUCCESS_NAVIGATE_DELAY_MS = 1200;

export function isSlugConflictError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "CONFLICT"
	);
}

export function OrganizationOnboardingFormView({
	email,
	initialName,
	initialSlug,
	organizationSlug,
	onEdit,
	onRetry,
	onSubmit,
	provisioningError = false,
	slugConflictMessage,
	submitting,
	successUrl = null,
	localEvaluation = false,
	localPort = "3030",
	completionTarget = "workspace",
}: {
	email: string;
	initialName: string;
	initialSlug: string;
	organizationSlug?: string;
	/** Clears a rejected submit while the user corrects either field. */
	onEdit?: () => void;
	/** Re-runs the same mutation after a provisioning failure. */
	onRetry?: () => void;
	onSubmit: (value: z.output<typeof organizationOnboardingSchema>) => void;
	/** Non-conflict failure: provisioning/SERVICE_UNAVAILABLE and everything else. */
	provisioningError?: boolean;
	/** CONFLICT: the requested workspace URL is taken; keep the form enabled. */
	slugConflictMessage?: string;
	/**
	 * A confirmed pre-submit availability failure for the current slug. Unlike a
	 * post-submit CONFLICT, this disables submit so the user cannot fire a call
	 * that is already known to fail. An in-flight check must NOT set this.
	 */
	submitting: boolean;
	/** When set, the workspace exists: render the completion moment instead of the form. */
	successUrl?: string | null;
	localEvaluation?: boolean;
	localPort?: string;
	completionTarget?: "workspace" | "cli";
}) {
	const [slugEdited, setSlugEdited] = useState(false);
	const form = useZodForm({
		schema: organizationOnboardingSchema,
		defaultValues: { name: initialName, slug: initialSlug },
		onSubmit: ({ value }) => onSubmit(value),
	});
	const { name, slug } = useStore(form.store, (state) => state.values);
	const [debouncedSlug, setDebouncedSlug] = useState(slug);
	const [unavailableSlug, setUnavailableSlug] = useState<string | null>(null);
	useEffect(() => {
		const handle = window.setTimeout(
			() => setDebouncedSlug(slug),
			SLUG_AVAILABILITY_DEBOUNCE_MS,
		);
		return () => window.clearTimeout(handle);
	}, [slug]);
	const slugCheckEnabled =
		debouncedSlug.length > 0 &&
		WELL_FORMED_SLUG.test(debouncedSlug) &&
		debouncedSlug !== organizationSlug;
	useEffect(() => {
		if (!slugCheckEnabled) {
			setUnavailableSlug(null);
			return;
		}
		let active = true;
		void osApi.organizations
			.isSlugAvailable({ slug: debouncedSlug })
			.then((result) => {
				if (active) setUnavailableSlug(result.available ? null : debouncedSlug);
			})
			.catch(() => {
				if (active) setUnavailableSlug(null);
			});
		return () => {
			active = false;
		};
	}, [slugCheckEnabled, debouncedSlug]);
	const slugUnavailable = unavailableSlug !== null && unavailableSlug === slug;
	const workspaceUrl = localEvaluation
		? buildLocalOsUrl(slug, localPort)
		: buildTenantOsUrl(slug, resolveOsPlatformDomain(window.location.hostname));
	const valid =
		name.trim().length > 0 && workspaceUrl !== null && !slugUnavailable;
	if (successUrl) {
		return (
			<main className="org-launcher">
				<Surface tier="panel" className={`${LAUNCHER_PANEL} max-w-140`}>
					<TedixBrandMark />
					<div
						className="grid justify-items-center gap-2.5 pt-4 pb-2 text-center"
						role="status"
					>
						<span
							className="grid size-11 place-items-center rounded-full bg-kumo-fill text-kumo-brand"
							aria-hidden="true"
						>
							<Check size={24} weight="bold" />
						</span>
						<h1 className={PANEL_TITLE}>Your workspace is ready</h1>
						<Link className="break-all font-mono" href={successUrl}>
							{displayHost(successUrl)}
						</Link>
						<Text role="control" tone="secondary">
							Opening your workspace…
						</Text>
					</div>
				</Surface>
			</main>
		);
	}
	return (
		<main className="org-launcher">
			<Surface tier="panel" className={`${LAUNCHER_PANEL} max-w-140`}>
				<TedixBrandMark />
				<p className="eyebrow">
					{localEvaluation
						? "START YOUR LOCAL TEDIX OS"
						: "WELCOME TO TEDIX OS"}
				</p>
				<h1 className={PANEL_TITLE}>
					{localEvaluation ? "Name your OS" : "Create your workspace"}
				</h1>
				<Text role="control" tone="secondary">
					{localEvaluation
						? "Start with an empty, durable workspace on this machine. Choose its name and local address."
						: "Choose a name and web address for your workspace. Tedix Cloud is in private beta, by invitation."}
				</Text>
				{email ? (
					<Text role="control" tone="secondary">
						{localEvaluation ? "Local profile" : "Signed in as"}{" "}
						<Text as="span" role="control" weight="semibold">
							{email}
						</Text>
						{localEvaluation ? null : (
							<>
								{" · "}
								<Link href={OS_LOGOUT_PATH}>Sign out</Link>
							</>
						)}
					</Text>
				) : null}
				<form
					className="mt-1 grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!slugUnavailable) void form.handleSubmit();
					}}
				>
					<FormField form={form} name="name" label="Workspace name">
						{(field, meta) => (
							<Input
								id={meta.id}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								aria-labelledby={`${meta.id}-label`}
								aria-invalid={meta.invalid || undefined}
								aria-describedby={meta.descriptionId}
								aria-errormessage={meta.errorId}
								placeholder="Acme Studio"
								autoComplete="organization"
								autoFocus
								disabled={submitting}
								onChange={(event) => {
									onEdit?.();
									field.handleChange(event.target.value);
									if (!slugEdited)
										form.setFieldValue(
											"slug",
											suggestOsOrganizationSlug(
												event.target.value,
												organizationSlug,
											),
										);
								}}
							/>
						)}
					</FormField>
					<FormField form={form} name="slug" label="Workspace URL">
						{(field, meta) => (
							<Input
								id={meta.id}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								aria-labelledby={`${meta.id}-label`}
								aria-describedby={meta.descriptionId}
								aria-errormessage={meta.errorId}
								placeholder="acme-studio"
								autoCapitalize="none"
								autoComplete="off"
								spellCheck={false}
								disabled={submitting}
								aria-invalid={
									slugConflictMessage || slugUnavailable ? true : meta.invalid
								}
								onChange={(event) => {
									onEdit?.();
									setSlugEdited(true);
									field.handleChange(
										suggestOsOrganizationSlug(
											event.target.value,
											organizationSlug,
										),
									);
								}}
							/>
						)}
					</FormField>
					{slugConflictMessage || slugUnavailable ? (
						<div className="-mt-2" role="alert">
							<Text role="label" tone="error">
								{slugConflictMessage ?? "That workspace URL is taken."} Pick a
								different workspace URL above.
							</Text>
						</div>
					) : null}
					<Text
						role="label"
						tone="mono-secondary"
						className="-mt-2 break-all"
						aria-live="polite"
					>
						{workspaceUrl ??
							(localEvaluation
								? `http://your-os.localhost${localPort ? `:${localPort}` : ""}/`
								: "https://your-workspace.os.tedix.dev/")}
					</Text>
					{provisioningError && !submitting ? (
						<Alert variant="destructive">
							<AlertTitle>
								Something went wrong preparing your workspace.
							</AlertTitle>
							<AlertDescription>
								<p>
									Retrying is safe: setup resumes where it stopped and reuses
									anything already provisioned.
								</p>
								{onRetry ? (
									<Button
										type="button"
										variant="secondary"
										size="sm"
										onClick={onRetry}
									>
										Try again
									</Button>
								) : null}
							</AlertDescription>
						</Alert>
					) : null}
					<Text
						role="label"
						tone="secondary"
						className="-mt-1.5 min-h-4.5"
						aria-live="polite"
					>
						{submitting
							? "Setting up your workspace… this can take a few seconds."
							: null}
					</Text>
					<Button
						type="submit"
						size="lg"
						loading={submitting}
						disabled={!valid || submitting}
						// While provisioning runs, the button is disabled only to block a
						// double submit — keep it visually strong instead of ghosted so
						// the screen still reads as actively working.
						className={submitting ? "w-full disabled:opacity-100" : "w-full"}
					>
						{localEvaluation
							? "Start my OS"
							: completionTarget === "cli"
								? "Create workspace and continue"
								: "Create workspace"}
					</Button>
				</form>
				<Text role="caption" tone="secondary" className="pt-1 text-center">
					{localEvaluation
						? "Your workspace data stays on this machine. If you enable AI, prompts are sent to your configured provider and may incur charges. No Tedix Cloud account is needed."
						: completionTarget === "cli"
							? "Tedix creates your workspace, then returns you to the CLI on your device."
							: "Your workspace gets its own private address. Invite your team and adjust settings once you're in."}
				</Text>
			</Surface>
		</main>
	);
}

export function OrganizationOnboardingForm({
	email,
	organization = null,
	localEvaluation,
	onComplete,
	completionTarget = "workspace",
}: {
	email: string;
	/** null: create a brand-new organization first, then complete onboarding. */
	organization?: OnboardingOrganization | null;
	localEvaluation: boolean;
	onComplete?: (organization: OnboardingOrganization) => void;
	completionTarget?: "workspace" | "cli";
}) {
	// Seed the field with the org's OWN slug, which the bootstrap already minted
	// globally unique (`personal-<shortId>`). Deriving it from the generic
	// bootstrap NAME ("Personal Workspace") would collide across every signup.
	// A brand-new (`organization === null`) signup starts empty and re-slugs
	// live from the typed name below.
	const [successUrl, setSuccessUrl] = useState<string | null>(null);
	// Once a brand-new organization is created, retries (a provisioning
	// failure, an edited slug after a conflict) reuse it instead of minting
	// another org per attempt.
	const createdOrganization = useRef<OnboardingOrganization | null>(
		organization,
	);
	const complete = useMutation({
		mutationFn: async (
			value: z.output<typeof organizationOnboardingSchema>,
		) => {
			if (!createdOrganization.current) {
				const created = await osApi.organizations.create({
					name: value.name,
					slug: value.slug,
				});
				createdOrganization.current = {
					id: created.id,
					name: created.name,
					slug: created.slug,
				};
			}
			return osApi.organizations.completeOsOnboarding({
				organizationId: createdOrganization.current.id,
				name: value.name,
				slug: value.slug,
			});
		},
		onSuccess: (updated) => {
			if (onComplete) {
				onComplete(updated);
				return;
			}
			let target = localEvaluation
				? buildLocalOsUrl(updated.slug, window.location.port)
				: buildTenantOsUrl(
						updated.slug,
						resolveOsPlatformDomain(window.location.hostname),
					);
			if (!target) return;
			// Open the device setup prompt on the first visit to a newly created
			// workspace. The prompt remains optional and does not run local code.
			target = new URL("/workspaces?setup=1", target).href;
			// A brief "you're all set" moment before the workspace opens. The
			// success card also renders the URL as a plain anchor, so a blocked
			// or failed navigation still leaves the user a manual path in.
			setSuccessUrl(target);
			window.setTimeout(() => {
				window.location.assign(target);
			}, ONBOARDING_SUCCESS_NAVIGATE_DELAY_MS);
		},
	});
	const slugConflict =
		complete.error !== null && isSlugConflictError(complete.error);

	return (
		<OrganizationOnboardingFormView
			email={email}
			initialName={organization?.name ?? ""}
			initialSlug={organization?.slug ?? ""}
			organizationSlug={organization?.slug}
			onEdit={() => complete.reset()}
			slugConflictMessage={
				slugConflict
					? complete.error instanceof Error
						? complete.error.message
						: `${complete.variables?.slug ?? "That workspace"}.os.tedix.dev is already taken.`
					: undefined
			}
			provisioningError={complete.error !== null && !slugConflict}
			onRetry={() => complete.variables && complete.mutate(complete.variables)}
			successUrl={successUrl}
			localEvaluation={localEvaluation}
			localPort={window.location.port}
			completionTarget={completionTarget}
			submitting={complete.isPending}
			onSubmit={(value) => {
				if (complete.error !== null) complete.reset();
				complete.mutate(value);
			}}
		/>
	);
}

/** Copy an MCP gateway endpoint to the clipboard with transient confirmation. */
function CopySurfaceEntry({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	const meta = SURFACE_META.mcp;
	return (
		<Button
			aria-label={copied ? "MCP gateway copied" : "Copy MCP gateway"}
			title={copied ? "Copied" : `${meta.label}: ${displayHost(value)}`}
			type="button"
			size="icon-sm"
			variant="ghost"
			onClick={() => {
				navigator.clipboard
					?.writeText(value)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1600);
					})
					.catch(() => undefined);
			}}
		>
			{copied ? (
				<Check size={16} aria-hidden="true" />
			) : (
				<Copy size={16} aria-hidden="true" />
			)}
		</Button>
	);
}

/** A session route-out anchor: the tenant surface starts its own session on arrival. */
function RouteSurfaceEntry({
	surface,
	href,
}: {
	surface: DirectorySurface;
	href: string;
}) {
	const meta = SURFACE_META[surface];
	return (
		<Button
			aria-label={`Open ${meta.label}`}
			render={<a href={href} />}
			size="icon-sm"
			title={`${meta.label}: ${displayHost(href)}`}
			variant="ghost"
		>
			<meta.Icon size={16} aria-hidden="true" />
		</Button>
	);
}

function WorkspaceRow({
	workspace,
	onOpen,
}: {
	workspace: LauncherWorkspace;
	onOpen: (organizationId: string) => void;
}) {
	const disabled = !workspace.provisioned;
	const osSurface = workspace.surfaces.find(
		(entry) => entry.surface === "os" && entry.href,
	);
	const secondarySurfaces = workspace.surfaces.filter(
		(entry) => entry.surface !== "os",
	);
	const identity = (
		<>
			<span
				className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-fill text-kumo-brand"
				aria-hidden="true"
			>
				<Buildings size={18} />
			</span>
			<span className="grid min-w-0 flex-1 gap-0.5 text-left">
				<Text as="span" role="body" weight="medium" truncate>
					{workspace.name}
				</Text>
				<Text as="span" role="label" tone="secondary" truncate>
					{workspace.slug}
				</Text>
			</span>
		</>
	);
	return (
		<div
			className={`${WORKSPACE_ROW} ${
				disabled
					? "bg-kumo-tint opacity-70"
					: "bg-kumo-base focus-within:bg-kumo-tint hover:bg-kumo-tint"
			}`}
			aria-disabled={disabled || undefined}
		>
			{osSurface?.href ? (
				<Button
					className="min-w-0 flex-1 justify-start gap-3 self-stretch px-2 font-normal!"
					multiline
					render={
						<a
							data-workspace-link
							href={osSurface.href}
							onClick={() => onOpen(workspace.organizationId)}
						/>
					}
					variant="ghost"
				>
					{identity}
					<ArrowRight size={16} aria-hidden="true" />
				</Button>
			) : (
				<div className="flex min-w-0 flex-1 items-center gap-3 px-2 py-1.5">
					{identity}
				</div>
			)}
			{disabled ? (
				<div className="flex items-center gap-0.5">
					<Badge variant="secondary">Provisioning</Badge>
				</div>
			) : secondarySurfaces.length > 0 ? (
				<div className="flex items-center gap-0.5 transition-opacity motion-reduce:transition-none pointer-fine:opacity-0 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:group-hover/row:opacity-100">
					{secondarySurfaces.map((entry) =>
						entry.surface === "mcp" && entry.copyValue ? (
							<CopySurfaceEntry key={entry.surface} value={entry.copyValue} />
						) : entry.href ? (
							<RouteSurfaceEntry
								key={entry.surface}
								surface={entry.surface}
								href={entry.href}
							/>
						) : null,
					)}
				</div>
			) : null}
			{disabled ? (
				<Text role="label" tone="secondary" className="max-w-65 px-2">
					This workspace is still being set up.
				</Text>
			) : !osSurface && secondarySurfaces.length === 0 ? (
				<Text role="label" tone="secondary" className="max-w-65 px-2">
					Nothing to open yet.
				</Text>
			) : null}
		</div>
	);
}

export function OrganizationLauncherContent({
	workspaces,
	email,
	blockedReturnTarget = false,
	localEvaluation = false,
}: {
	workspaces: readonly LauncherWorkspace[];
	email: string;
	blockedReturnTarget?: boolean;
	localEvaluation?: boolean;
}) {
	const [query, setQuery] = useState("");
	const [recentWorkspaceIds, setRecentWorkspaceIds] = useState(
		readRecentWorkspaceIds,
	);
	const searchRef = useRef<HTMLInputElement>(null);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const sortedWorkspaces = useMemo(() => {
		const recency = new Map(
			recentWorkspaceIds.map((organizationId, index) => [
				organizationId,
				index,
			]),
		);
		return [...workspaces].sort((left, right) => {
			const leftIndex = recency.get(left.organizationId);
			const rightIndex = recency.get(right.organizationId);
			if (leftIndex !== undefined || rightIndex !== undefined) {
				if (leftIndex === undefined) return 1;
				if (rightIndex === undefined) return -1;
				return leftIndex - rightIndex;
			}
			return left.name.localeCompare(right.name);
		});
	}, [recentWorkspaceIds, workspaces]);
	const visibleWorkspaces = useMemo(
		() =>
			normalizedQuery.length === 0
				? sortedWorkspaces
				: sortedWorkspaces.filter((workspace) =>
						[workspace.name, workspace.slug]
							.join("\n")
							.toLocaleLowerCase()
							.includes(normalizedQuery),
					),
		[normalizedQuery, sortedWorkspaces],
	);
	const workspaceCountLabel = `${visibleWorkspaces.length} ${
		visibleWorkspaces.length === 1 ? "workspace" : "workspaces"
	}`;
	useEffect(() => {
		const focusSearch = (event: globalThis.KeyboardEvent) => {
			const target = event.target;
			if (
				event.key !== "/" ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				(target instanceof HTMLElement &&
					(target.isContentEditable ||
						/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
			)
				return;
			event.preventDefault();
			searchRef.current?.focus();
		};
		window.addEventListener("keydown", focusSearch);
		return () => window.removeEventListener("keydown", focusSearch);
	}, []);
	const recordWorkspaceOpen = (organizationId: string) => {
		const next = [
			organizationId,
			...recentWorkspaceIds.filter((id) => id !== organizationId),
		].slice(0, 8);
		setRecentWorkspaceIds(next);
		try {
			window.localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
		} catch {
			// A blocked storage API must never block navigation.
		}
	};
	const moveWorkspaceFocus = (event: KeyboardEvent<HTMLUListElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const links = Array.from(
			event.currentTarget.querySelectorAll<HTMLAnchorElement>(
				"[data-workspace-link]",
			),
		);
		const current = links.indexOf(document.activeElement as HTMLAnchorElement);
		if (current < 0) return;
		event.preventDefault();
		const offset = event.key === "ArrowDown" ? 1 : -1;
		links[(current + offset + links.length) % links.length]?.focus();
	};

	return (
		<main className="org-launcher">
			<Surface tier="panel" className={`${LAUNCHER_PANEL} max-w-215`}>
				<header className="grid gap-6">
					<div className="flex items-center justify-between gap-5">
						<TedixBrandMark />
						{email ? (
							localEvaluation ? (
								<Text
									role="control"
									tone="secondary"
									truncate
									className="max-w-70 max-[460px]:max-w-[150px]"
								>
									{email}
								</Text>
							) : (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												className="max-w-70 max-[460px]:max-w-[150px]"
												size="sm"
												variant="ghost"
											/>
										}
									>
										<span className="truncate">{email}</span>
										<CaretDown size={13} aria-hidden="true" />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-60">
										<DropdownMenuGroup>
											<DropdownMenuLabel>{email}</DropdownMenuLabel>
											<DropdownMenuLinkItem href="/account/authorizations">
												Connected applications
											</DropdownMenuLinkItem>
											<DropdownMenuLinkItem href="/account/profile">
												<UserCircle size={15} aria-hidden="true" />
												Profile
											</DropdownMenuLinkItem>
											<DropdownMenuItem
												onClick={() => window.location.assign(OS_LOGOUT_PATH)}
											>
												<SignOut size={15} aria-hidden="true" />
												Sign out
											</DropdownMenuItem>
										</DropdownMenuGroup>
									</DropdownMenuContent>
								</DropdownMenu>
							)
						) : null}
					</div>
					<div className="flex flex-col items-start justify-between gap-5 md:flex-row md:items-end">
						<div className="min-w-0">
							<h1 className={PANEL_TITLE}>
								{localEvaluation ? "Open your local OS" : "Workspaces"}
							</h1>
							<Text role="control" tone="secondary">
								{localEvaluation
									? "Your local OS data stays on this machine."
									: "Open a workspace or use its connected services."}
							</Text>
						</div>
						{localEvaluation ? null : (
							<Button render={<a href="/account/onboarding?new=1" />} size="sm">
								<Plus size={15} aria-hidden="true" />
								New workspace
							</Button>
						)}
					</div>
				</header>
				{blockedReturnTarget ? (
					<Alert variant="destructive">
						<AlertTitle>That workspace is not available</AlertTitle>
						<AlertDescription>
							Pick a workspace you are a member of from the list below.
						</AlertDescription>
					</Alert>
				) : null}
				{workspaces.length > 0 ? (
					<SearchInput
						containerClassName="w-full"
						ref={searchRef}
						aria-label="Search workspaces"
						placeholder="Search workspaces"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						trailing={
							<>
								<Text
									as="span"
									role="label"
									tone="secondary"
									className="whitespace-nowrap tabular-nums max-[460px]:hidden"
									aria-live="polite"
								>
									{workspaceCountLabel}
								</Text>
								<Kbd>/</Kbd>
							</>
						}
					/>
				) : null}
				{workspaces.length === 0 ? (
					<Empty appearance="quiet" className="min-h-55">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Signpost />
							</EmptyMedia>
							<EmptyTitle>No workspace yet</EmptyTitle>
							<EmptyDescription>
								Ask an administrator for an invite or create a workspace.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : visibleWorkspaces.length === 0 ? (
					<Empty appearance="quiet" className="min-h-55">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<MagnifyingGlass />
							</EmptyMedia>
							<EmptyTitle>No matching workspace</EmptyTitle>
							<EmptyDescription>Try another name or slug.</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								size="sm"
								variant="secondary"
								onClick={() => setQuery("")}
							>
								Clear search
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<Card
						className="gap-0 divide-y divide-kumo-hairline overflow-hidden p-0"
						render={<ul onKeyDown={moveWorkspaceFocus} />}
					>
						{visibleWorkspaces.map((workspace) => (
							<li key={workspace.organizationId}>
								<WorkspaceRow
									workspace={workspace}
									onOpen={recordWorkspaceOpen}
								/>
							</li>
						))}
					</Card>
				)}
				{localEvaluation ? (
					<Text role="caption" tone="secondary" className="pt-1 text-center">
						This local profile stays on your machine, separate from production.
					</Text>
				) : null}
			</Surface>
		</main>
	);
}
