import { ArrowLeft, ShieldCheck } from "@phosphor-icons/react";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	AppRuntimeGuestNameSchema,
	type AppRuntimeFiles,
} from "@tedix/api-contract/schemas/os-app-runtime";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { buildTranslate, type Translate } from "@tedix/widget-i18n";
import {
	resolveWidgetCatalog,
	WIDGET_CATALOGS,
	WIDGET_SOURCE_LOCALE,
} from "@tedix/widget-i18n/catalogs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
import { AppTranslateButton } from "@/components/app-translate-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import {
	type AppRuntimeContext,
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
} from "@/lib/app-runtime-host";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import { useAppRuntimeTranslation } from "@/lib/app-runtime-translation";
import { ShareControls } from "@/components/share-controls";
import { followDeviceTheme } from "@/lib/theme";
import { adoptShareLinkAddress } from "@/lib/share-link-session";
import { OrganizationMark } from "@/shared/organization-mark";

/**
 * A share-link guest using a runtime app without a Tedix account. The page
 * holds only the share session the link was exchanged for; the app's client
 * runs in the OS sandbox with the `use` role, its server calls and Output
 * reads go through the guest routes, and every one of them re-checks the
 * link. Nothing here is a member view: no navigation, no cookies, no data
 * beyond what the app itself shows.
 */

type GuestOpen = {
	verifiedEmail?: string | null;
	session: string;
	expiresAt: number;
	/** `edit` when the link lets this invited visitor save changes. */
	role: "use" | "edit";
	revisionId: string;
	app: {
		id: string;
		name: string;
		description: string | null;
		workspaceId: string;
		workspaceName?: string;
		revision: number;
		client: string;
		recordsGuestInput?: boolean;
		settings: Record<string, JsonValue>;
		grants: { slot: string; operations: string[] }[];
	};
};

type Redeemed = {
	organization?: {
		name: string;
		logoUrl: string | null;
		/** The language the organization publishes to visitors; null when unset. */
		locale?: string | null;
		/** The organization's own `share_*` wording, keyed by locale. */
		copy?: Record<string, Record<string, string>>;
	} | null;
	share: {
		note: string | null;
		policyReason: string | null;
		/** The link's permanent id; an old `#token=` link moves to `/s/<id>`. */
		publicId?: string;
		createdAt?: string;
		/** Who made the link, for the "Shared by <name> · <date>" line. */
		sharedByName?: string | null;
		/** The readable suffix of the link's address. */
		slug?: string;
	};
	/** True when the visitor may manage this link, so the bar offers Share. */
	canManage?: boolean;
	sessionToken?: string;
};
export type GuestShare = Redeemed;

export type GuestPageState = PageState;
/**
 * `appId` names the app when the link is to a whole workspace; an app link
 * names its own app, so it is absent there.
 */
type PageState =
	| { status: "loading" }
	| {
			status: "identify";
			app: GuestOpen;
			share: Redeemed;
			sessionToken: string;
			appId?: string;
	  }
	| {
			status: "ready";
			share: Redeemed;
			sessionToken: string;
			app: GuestOpen;
			guestName: string;
			appId?: string;
	  }
	| { status: "unavailable" };

// The guest's name for this tab. A link's session lives under its own id
// (`tedix.os.share.<id>`, see share-link-session.ts); the link secret itself
// never enters storage.
const GUEST_NAME_KEY = "tedix.os.guest.name.v1";
function storedGuestName(): string | null {
	try {
		const name = AppRuntimeGuestNameSchema.safeParse(
			window.sessionStorage.getItem(GUEST_NAME_KEY),
		);
		return name.success ? name.data : null;
	} catch {
		return null;
	}
}
function forgetGuest(): void {
	try {
		window.sessionStorage.removeItem(GUEST_NAME_KEY);
	} catch {
		/* Nothing was stored. */
	}
}

async function guestRequest<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		credentials: "omit",
		// An app saves on a click without waiting; a reload or a closed tab
		// right after must not cancel the call that carries that save.
		keepalive: true,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error("Share unavailable");
	return (await response.json()) as T;
}

/**
 * Save a visitor's change. A refusal the editor can act on (someone else
 * saved first, or the change does not fit) is thrown with its code and
 * details, as a signed-in save's is; anything else means the link no longer
 * lets this visitor save.
 */
async function guestSave<T>(body: unknown): Promise<T> {
	const response = await fetch("/api/os-shared/app/save", {
		method: "POST",
		credentials: "omit",
		keepalive: true,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.ok) return (await response.json()) as T;
	if (response.status === 409 || response.status === 400)
		throw (await response.json()) as {
			code: string;
			message: string;
			data?: unknown;
		};
	throw new Error("This link no longer lets you save changes");
}

/**
 * The guest bar speaks the organization's visitor language, else the guest's
 * browser language. Wording comes from the shared copy catalog, and the
 * organization's own overrides win (exact locale, then its base language).
 */
export function guestCopy(organization?: Redeemed["organization"]): {
	locale: string;
	t: Translate;
} {
	const locale =
		organization?.locale || navigator.language || WIDGET_SOURCE_LOCALE;
	const base = locale.split("-")[0] ?? locale;
	const copy = organization?.copy ?? {};
	return {
		locale,
		t: buildTranslate(
			{
				...resolveWidgetCatalog(locale).catalog,
				...copy[base],
				...copy[locale],
			},
			WIDGET_CATALOGS[WIDGET_SOURCE_LOCALE],
		),
	};
}

/** The link's date in the guest's language, e.g. "27. Okt. 2026". */
function sharedOn(iso: string, locale: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	try {
		return date.toLocaleDateString(locale, { dateStyle: "medium" });
	} catch {
		return date.toLocaleDateString(WIDGET_SOURCE_LOCALE, {
			dateStyle: "medium",
		});
	}
}

export function GuestAppPage() {
	const [state, setState] = useState<PageState>({ status: "loading" });
	// One redemption survives StrictMode's effect replay: the first run strips
	// the fragment, so the replay finds nothing to redeem.
	const opening = useRef<Promise<PageState> | null>(null);

	useEffect(() => followDeviceTheme(), []);

	useEffect(() => {
		let alive = true;
		const token = new URLSearchParams(window.location.hash.slice(1)).get(
			"token",
		);
		window.history.replaceState(
			null,
			"",
			window.location.pathname + window.location.search,
		);
		if (!opening.current) {
			if (!token) {
				setState({ status: "unavailable" });
				return;
			}
			opening.current = (async (): Promise<PageState> => {
				const share = await guestRequest<Redeemed>("/api/os-shared/redeem", {
					token,
				});
				const sessionToken = share.sessionToken;
				if (!sessionToken) throw new Error("Share unavailable");
				// An old link moves to the link's permanent address and its own
				// session key; the router then shows that page, which resumes
				// this session.
				if (share.share.publicId) {
					adoptShareLinkAddress(
						share.share.publicId,
						sessionToken,
						share.share.slug,
					);
					return { status: "loading" };
				}
				return openGuestApp(share, sessionToken);
			})().catch((): PageState => {
				forgetGuest();
				return { status: "unavailable" };
			});
		}
		void opening.current.then((next) => {
			if (alive) setState(next);
		});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<GuestAppScreen state={state} setState={setState} forget={forgetGuest} />
	);
}

/** Open a share session's app, or ask the guest's name first. */
export async function openGuestApp(
	share: GuestShare,
	sessionToken: string,
	appId?: string,
): Promise<GuestPageState> {
	const guestName = storedGuestName();
	const app = await guestRequest<GuestOpen>("/api/os-shared/app/open", {
		sessionToken,
		...(guestName ? { guestName } : {}),
		...(appId ? { appId } : {}),
	});
	if (!guestName && !app.verifiedEmail && app.app.recordsGuestInput)
		return { status: "identify", share, sessionToken, app, appId };
	return {
		status: "ready",
		share,
		sessionToken,
		app,
		guestName: app.verifiedEmail ?? guestName ?? "Guest",
		appId,
	};
}

/** A guest's app once its share session is known, in the organization's words. */
export function GuestAppScreen({
	embedded = false,
	state,
	setState,
	forget,
	back,
}: {
	embedded?: boolean;
	state: GuestPageState;
	setState: (state: GuestPageState) => void;
	/** Drops the stored share session after the server refuses it. */
	forget: () => void;
	/** Returns to the shared workspace the app was opened from. */
	back?: { label: string; onBack: () => void };
}) {
	const organization =
		state.status === "ready" || state.status === "identify"
			? state.share.organization
			: null;
	const { locale, t } = useMemo(() => guestCopy(organization), [organization]);
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	if (state.status === "loading")
		return (
			<main
				className="mx-auto grid min-h-dvh w-full max-w-5xl place-items-center p-4"
				aria-busy
			>
				<Text as="p" role="body" tone="secondary" className="m-0">
					{t("share_opening_app")}
				</Text>
			</main>
		);
	if (state.status === "unavailable")
		return (
			<main className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center p-4">
				<Alert variant="destructive">
					<AlertTitle>{t("share_link_unavailable")}</AlertTitle>
					<AlertDescription>
						{t("share_link_unavailable_hint")}
					</AlertDescription>
				</Alert>
			</main>
		);
	if (state.status === "identify")
		return (
			<GuestName
				t={t}
				embedded={embedded}
				appName={state.app.app.name}
				back={
					back ?? {
						label:
							state.app.app.workspaceName ??
							state.share.organization?.name ??
							state.app.app.name,
						onBack: () => window.history.back(),
					}
				}
				onContinue={async (guestName) => {
					try {
						const app = await guestRequest<GuestOpen>(
							"/api/os-shared/app/open",
							{
								sessionToken: state.sessionToken,
								guestName,
								...(state.appId ? { appId: state.appId } : {}),
							},
						);
						try {
							window.sessionStorage.setItem(GUEST_NAME_KEY, guestName);
						} catch {
							/* The name remains in memory when storage is blocked. */
						}
						setState({ ...state, status: "ready", app, guestName });
					} catch {
						forget();
						setState({ status: "unavailable" });
					}
				}}
			/>
		);
	return (
		<GuestApp
			state={state}
			t={t}
			locale={locale}
			back={back}
			embedded={embedded}
		/>
	);
}

function GuestName({
	embedded,
	appName,
	back,
	t,
	onContinue,
}: {
	embedded?: boolean;
	appName: string;
	back?: { label: string; onBack: () => void };
	t: Translate;
	onContinue: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const parsed = AppRuntimeGuestNameSchema.safeParse(name);
	return (
		<div
			className={`mx-auto grid w-full max-w-md place-items-center p-4 ${embedded ? "min-h-80" : "min-h-dvh"}`}
		>
			<form
				className="flex w-full flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!parsed.success || busy) return;
					setBusy(true);
					void onContinue(parsed.data);
				}}
			>
				{back ? (
					<Button type="button" variant="ghost" onClick={back.onBack}>
						<ArrowLeft size={16} aria-hidden />
						{t("share_back", { name: back.label })}
					</Button>
				) : null}
				<Text as="p" role="body" className="m-0">
					{appName}
					{back ? ` · ${back.label}` : ""}
				</Text>
				<Text as="h1" role="section">
					{t("share_guest_name")}
				</Text>
				<Text as="p" className="m-0" tone="secondary" id="guest-name-hint">
					{t("share_guest_name_hint")}
				</Text>
				<Input
					className="min-h-11"
					aria-label={t("share_guest_name")}
					aria-describedby="guest-name-hint"
					autoComplete="name"
					maxLength={80}
					required
					value={name}
					onChange={(event) => setName(event.target.value)}
					disabled={busy}
				/>
				<Button
					className="min-h-11"
					style={{ color: "var(--primary-foreground)" }}
					type="submit"
					disabled={!parsed.success || busy}
				>
					{t("share_guest_continue")}
				</Button>
			</form>
		</div>
	);
}

function GuestApp({
	embedded,
	state,
	t,
	locale,
	back,
}: {
	embedded?: boolean;
	state: Extract<PageState, { status: "ready" }>;
	t: Translate;
	locale: string;
	back?: { label: string; onBack: () => void };
}) {
	// A workspace link names the app on every call; an app link names its own.
	const { app, sessionToken, share, guestName, appId } = state;
	const translation = useAppRuntimeTranslation(app.app.settings);
	const context = useMemo<AppRuntimeContext>(
		() => ({
			workspaceId: app.app.workspaceId,
			gadget: {
				id: app.app.id,
				name: app.app.name,
				revision: app.app.revision,
			},
			role: app.role,
			settings: app.app.settings,
			grants: app.app.grants,
		}),
		[app],
	);
	const callServer = useMemo(
		() =>
			createAppRuntimeServerCall(
				{
					open: async () => {
						const next = await guestRequest<GuestOpen>(
							"/api/os-shared/app/open",
							{ sessionToken, guestName, ...(appId ? { appId } : {}) },
						);
						return next;
					},
					call: async (input) => {
						return guestRequest<{ result: JsonValue }>(
							"/api/os-shared/app/call",
							{
								sessionToken,
								...(appId ? { appId } : {}),
								session: input.session,
								method: input.method,
								args: input.args,
							},
						);
					},
				},
				{
					workspaceId: app.app.workspaceId,
					gadgetId: app.app.id,
					revisionId: app.revisionId,
				},
			),
		[app, sessionToken, guestName, appId],
	);
	const target = useMemo(
		() => ({ sessionToken, ...(appId ? { appId } : {}) }),
		[sessionToken, appId],
	);
	const onCall = useCallback(
		(method: unknown, args: unknown) =>
			handleAppRuntimeCall(
				{
					context,
					resources: [],
					readOutput: async () => {
						throw new Error("Guests read through the share session");
					},
					// The page cannot see which file a slot is; each call names the
					// slot and the server checks the link, the visitor and the file.
					serverResolvesSlots: true,
					readOutputRevision: (_outputId, revision, slot) =>
						guestRequest("/api/os-shared/app/revision", {
							...target,
							slot,
							...(revision === undefined ? {} : { revision }),
						}),
					readOutputChanges: ({ slot, sinceRevision }) =>
						guestRequest("/api/os-shared/app/changes", {
							...target,
							slot,
							sinceRevision,
						}),
					readOutputImage: async ({ slot, url }) =>
						(
							await guestRequest<{ dataUrl: string }>(
								"/api/os-shared/app/image",
								{ ...target, slot, url },
							)
						).dataUrl,
					...(app.role === "edit"
						? {
								patchOutput: ({ slot, baseRevision, patch, explicit }) =>
									guestSave({
										...target,
										slot,
										baseRevision,
										patch,
										explicit,
									}),
							}
						: {}),
					readSlot: async (slot) =>
						(
							await guestRequest<{ revision: { content: OsOutputContent } }>(
								"/api/os-shared/app/read",
								{ sessionToken, ...(appId ? { appId } : {}), slot },
							)
						).revision.content,
					callServer,
				},
				method,
				args,
			),
		[context, callServer, sessionToken, appId, target, app.role],
	);
	const html = useMemo(
		() =>
			buildAppRuntimeDocument({
				"client.js": app.app.client,
			} as unknown as AppRuntimeFiles),
		[app.app.client],
	);
	return (
		// Like a shared artifact: one thin bar is the only chrome, and the app
		// fills the rest of the viewport edge to edge on its own background.
		<div
			className={`flex w-full flex-col ${embedded ? "min-h-[32rem] flex-1 lg:min-h-0" : "h-dvh"}`}
			data-guest-app
		>
			{!embedded && (
				<div
					className="shrink-0 border-b border-kumo-hairline bg-kumo-base"
					data-guest-bar
				>
					{/* One row, the organization's mark and name only. Viewer tools
				    such as Translate join the trailing group. */}
					<header className="flex min-h-10 min-w-0 items-center gap-2 px-3 sm:px-4">
						{back ? (
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("share_back", { name: back.label })}
								onClick={back.onBack}
								data-guest-back
							>
								<ArrowLeft size={16} aria-hidden />
							</Button>
						) : null}
						<OrganizationMark
							name={share.organization?.name ?? app.app.name}
							logoUrl={share.organization?.logoUrl ?? null}
						/>
						<Text
							as="h1"
							role="body"
							weight="semibold"
							className="m-0 min-w-0 flex-1 truncate"
						>
							{share.organization?.name && `${share.organization.name} · `}
							<Text as="span" tone="secondary">
								{app.app.name}
							</Text>
						</Text>
						<Text
							as="p"
							role="label"
							tone="secondary"
							className="m-0 shrink-0 max-sm:hidden"
							data-shared-by
						>
							{t("share_shared_by", {
								name: share.share.sharedByName ?? t("share_someone"),
							})}
							{share.share.createdAt
								? ` · ${sharedOn(share.share.createdAt, locale)}`
								: ""}
						</Text>
						<div
							className="flex shrink-0 items-center gap-1"
							hidden={embedded}
							data-guest-bar-tools
						>
							{share.canManage && !appId ? (
								<ShareControls
									resourceType="gadget"
									resourceId={app.app.id}
									currentRevisionId={app.revisionId}
								/>
							) : null}
							<Badge variant="success" title={t("share_no_sign_in")}>
								<ShieldCheck size={13} aria-hidden />{" "}
								{t(app.role === "edit" ? "share_can_edit" : "share_can_use")}
							</Badge>
							<AppTranslateButton translation={translation} compact />
						</div>
					</header>
					{(share.share.note || share.share.policyReason) && (
						<div className="grid gap-2 px-3 pb-2 sm:px-4">
							{share.share.note && (
								<Text as="p" role="body" tone="secondary" className="m-0">
									{share.share.note}
								</Text>
							)}
							{share.share.policyReason && (
								<Alert variant="warning">
									<AlertTitle>{t("share_access_narrowed")}</AlertTitle>
									<AlertDescription>
										{share.share.policyReason}
									</AlertDescription>
								</Alert>
							)}
						</div>
					)}
				</div>
			)}
			<AppRuntimeFrame
				key={app.revisionId}
				html={html}
				title={app.app.name}
				onCall={onCall}
				layout="fill"
				translation={translation.channel}
			/>
		</div>
	);
}
