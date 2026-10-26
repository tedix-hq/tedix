import { ShieldCheck } from "@phosphor-icons/react";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { AppRuntimeFiles } from "@tedix/api-contract/schemas/os-app-runtime";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { buildTranslate, type Translate } from "@tedix/widget-i18n";
import {
	resolveWidgetCatalog,
	WIDGET_CATALOGS,
	WIDGET_SOURCE_LOCALE,
} from "@tedix/widget-i18n/catalogs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Text } from "@/components/kumo/text";
import {
	type AppRuntimeContext,
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
} from "@/lib/app-runtime-host";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
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
	share: { note: string | null; policyReason: string | null };
	sessionToken?: string;
};

type PageState =
	| { status: "loading" }
	| { status: "ready"; share: Redeemed; sessionToken: string; app: GuestOpen }
	| { status: "unavailable" };

// Per-tab resume capability only; the link secret itself never enters storage.
const GUEST_SESSION_KEY = "tedix.os.guest.session.v1";
function storedGuestSession(): string | null {
	try {
		return window.sessionStorage.getItem(GUEST_SESSION_KEY);
	} catch {
		return null;
	}
}
function storeGuestSession(token: string | null): void {
	try {
		if (token) window.sessionStorage.setItem(GUEST_SESSION_KEY, token);
		else window.sessionStorage.removeItem(GUEST_SESSION_KEY);
	} catch {
		/* Blocked storage still permits this in-memory session. */
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
function followSystemTheme(): () => void {
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
	// One redemption survives StrictMode's effect replay: the link is one-time,
	// and the replay finds the fragment already stripped.
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
		const resumeToken = token ? null : storedGuestSession();
		if (token) storeGuestSession(null);
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
			const app = await guestRequest<GuestOpen>("/api/os-shared/app/open", {
				sessionToken,
			});
			storeGuestSession(sessionToken);
			return { status: "ready", share, sessionToken, app };
		})().catch((): PageState => {
			storeGuestSession(null);
			return { status: "unavailable" };
		});
		void opening.current.then((next) => {
			if (alive) setState(next);
		});
		return () => {
			alive = false;
		};
	}, []);

	const organization =
		state.status === "ready" ? state.share.organization : null;
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
	return <GuestApp state={state} t={t} />;
}

function GuestApp({
	state,
	t,
}: {
	state: Extract<PageState, { status: "ready" }>;
	t: Translate;
}) {
	const { app, sessionToken, share } = state;
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
							{ sessionToken },
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
		[app, sessionToken],
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
		<main
			className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-3 px-4 py-3 sm:px-6 sm:py-4"
			data-guest-app
		>
			{/* One row, the organization's mark and name only. Viewer tools such
			    as Translate join the trailing group. */}
			<header className="flex min-w-0 items-center gap-2">
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
				<div className="flex shrink-0 items-center gap-1" data-guest-bar-tools>
					<Badge variant="success" title={t("share_no_sign_in")}>
						<ShieldCheck size={13} aria-hidden /> {t("share_can_use")}
					</Badge>
				</div>
			</header>
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
			<AppRuntimeFrame
				key={app.revisionId}
				html={html}
				title={app.app.name}
				onCall={onCall}
				layout="fill"
			/>
		</main>
	);
}
