import { ShieldCheck } from "@phosphor-icons/react";
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
	session: string;
	expiresAt: number;
	role: "use";
	revisionId: string;
	app: {
		id: string;
		name: string;
		description: string | null;
		workspaceId: string;
		revision: number;
		client: string;
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
	};
	sessionToken?: string;
};
export type GuestShare = Redeemed;

export type GuestPageState = PageState;
type PageState =
	| { status: "loading" }
	| { status: "identify"; share: Redeemed; sessionToken: string }
	| {
			status: "ready";
			share: Redeemed;
			sessionToken: string;
			app: GuestOpen;
			guestName: string;
	  }
	| { status: "unavailable" };

// The guest's name for this tab. A link's session lives under its own id
// (`tedix.os.share.<id>`, see share-link-session.ts); the link secret itself
// never enters storage.
const GUEST_NAME_KEY = "tedix.os.guest.name.v1";
/** Before permanent addresses, one tab kept one guest session here. */
const LEGACY_GUEST_SESSION_KEY = "tedix.os.guest.session.v1";
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
/** Read and drop a session an older page kept for this tab, if any. */
function takeLegacyGuestSession(): string | null {
	try {
		const token = window.sessionStorage.getItem(LEGACY_GUEST_SESSION_KEY);
		window.sessionStorage.removeItem(LEGACY_GUEST_SESSION_KEY);
		return token;
	} catch {
		return null;
	}
}
function forgetGuest(): void {
	try {
		window.sessionStorage.removeItem(LEGACY_GUEST_SESSION_KEY);
		window.sessionStorage.removeItem(GUEST_NAME_KEY);
	} catch {
		/* Nothing was stored. */
	}
}

async function guestRequest<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		credentials: "omit",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error("Share unavailable");
	return (await response.json()) as T;
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

/** The guest's document follows the device: there is no account to keep a choice on. */
export function followSystemTheme(): () => void {
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	const apply = () => {
		const mode = media.matches ? "dark" : "light";
		document.documentElement.dataset.theme = "tedix";
		document.documentElement.dataset.mode = mode;
		document.documentElement.classList.toggle("dark", mode === "dark");
	};
	apply();
	media.addEventListener("change", apply);
	return () => media.removeEventListener("change", apply);
}

export function GuestAppPage() {
	const [state, setState] = useState<PageState>({ status: "loading" });
	// One redemption survives StrictMode's effect replay: the first run strips
	// the fragment, so the replay finds nothing to redeem.
	const opening = useRef<Promise<PageState> | null>(null);

	useEffect(() => followSystemTheme(), []);

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
		const resumeToken = takeLegacyGuestSession();
		if (!token && !resumeToken && !opening.current) {
			setState({ status: "unavailable" });
			return;
		}
		opening.current ??= (async (): Promise<PageState> => {
			const share = token
				? await guestRequest<Redeemed>("/api/os-shared/redeem", { token })
				: await guestRequest<Redeemed>("/api/os-shared/session", {
						sessionToken: resumeToken,
					});
			const sessionToken = token ? share.sessionToken : resumeToken;
			if (!sessionToken) throw new Error("Share unavailable");
			// An old link, or a session an older page kept, moves to the link's
			// permanent address and its own session key; the router then shows
			// that page, which resumes this session.
			if (share.share.publicId) {
				adoptShareLinkAddress(share.share.publicId, sessionToken);
				return { status: "loading" };
			}
			return openGuestApp(share, sessionToken);
		})().catch((): PageState => {
			forgetGuest();
			return { status: "unavailable" };
		});
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
): Promise<GuestPageState> {
	const guestName = storedGuestName();
	if (!guestName) return { status: "identify", share, sessionToken };
	const app = await guestRequest<GuestOpen>("/api/os-shared/app/open", {
		sessionToken,
		guestName,
	});
	return { status: "ready", share, sessionToken, app, guestName };
}

/** A guest's app once its share session is known, in the organization's words. */
export function GuestAppScreen({
	state,
	setState,
	forget,
}: {
	state: GuestPageState;
	setState: (state: GuestPageState) => void;
	/** Drops the stored share session after the server refuses it. */
	forget: () => void;
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
				onContinue={async (guestName) => {
					try {
						const app = await guestRequest<GuestOpen>(
							"/api/os-shared/app/open",
							{ sessionToken: state.sessionToken, guestName },
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
	return <GuestApp state={state} t={t} />;
}

function GuestName({
	t,
	onContinue,
}: {
	t: Translate;
	onContinue: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const parsed = AppRuntimeGuestNameSchema.safeParse(name);
	return (
		<main className="mx-auto grid min-h-dvh w-full max-w-md place-items-center p-4">
			<form
				className="flex w-full flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!parsed.success || busy) return;
					setBusy(true);
					void onContinue(parsed.data);
				}}
			>
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
					type="submit"
					disabled={!parsed.success || busy}
				>
					{t("share_guest_continue")}
				</Button>
			</form>
		</main>
	);
}

function GuestApp({
	state,
	t,
}: {
	state: Extract<PageState, { status: "ready" }>;
	t: Translate;
}) {
	const { app, sessionToken, share, guestName } = state;
	const translation = useAppRuntimeTranslation(app.app.settings);
	const context = useMemo<AppRuntimeContext>(
		() => ({
			workspaceId: app.app.workspaceId,
			gadget: {
				id: app.app.id,
				name: app.app.name,
				revision: app.app.revision,
			},
			role: "use",
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
							{ sessionToken, guestName },
						);
						return next;
					},
					call: async (input) => {
						return guestRequest<{ result: JsonValue }>(
							"/api/os-shared/app/call",
							{
								sessionToken,
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
		[app, sessionToken, guestName],
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
					readSlot: async (slot) =>
						(
							await guestRequest<{ revision: { content: OsOutputContent } }>(
								"/api/os-shared/app/read",
								{ sessionToken, slot },
							)
						).revision.content,
					callServer,
				},
				method,
				args,
			),
		[context, callServer, sessionToken],
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
		<main className="flex h-dvh w-full flex-col" data-guest-app>
			<div
				className="shrink-0 border-b border-kumo-hairline bg-kumo-base"
				data-guest-bar
			>
				{/* One row, the organization's mark and name only. Viewer tools
				    such as Translate join the trailing group. */}
				<header className="flex min-h-10 min-w-0 items-center gap-2 px-3 sm:px-4">
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
					<div
						className="flex shrink-0 items-center gap-1"
						data-guest-bar-tools
					>
						<Badge variant="success" title={t("share_no_sign_in")}>
							<ShieldCheck size={13} aria-hidden /> {t("share_can_use")}
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
								<AlertDescription>{share.share.policyReason}</AlertDescription>
							</Alert>
						)}
					</div>
				)}
			</div>
			<AppRuntimeFrame
				key={app.revisionId}
				html={html}
				title={app.app.name}
				onCall={onCall}
				layout="fill"
				translation={translation.channel}
			/>
		</main>
	);
}
