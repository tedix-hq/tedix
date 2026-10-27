import type { OsShareAccess } from "@tedix/api-contract/contracts/os-shares";
import { isAppRuntimeManifest } from "@tedix/api-contract/utils/app-runtime";
import { useEffect, useRef, useState } from "react";
import {
	GuestAppScreen,
	type GuestPageState,
	type GuestShare,
	openGuestApp,
} from "@/components/guest-app-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Text } from "@/components/kumo/text";
import { followDeviceTheme } from "@/lib/theme";
import {
	type SharePayload,
	SharedResourceView,
} from "@/components/shared-resource-page";
import {
	isShareLinkId,
	readShareLinkSession,
	shareLinkPath,
	storeShareLinkSession,
} from "@/lib/share-link-session";

type OpenedShare = SharePayload &
	GuestShare & {
		access?: OsShareAccess;
		/** The link is for signed-in people and this visitor is not signed in. */
		needsSignIn?: boolean;
	};

type Opened = { payload: OpenedShare; sessionToken: string };

type PageState =
	| { status: "loading" }
	| { status: "unavailable"; signedIn: boolean }
	| { status: "guest"; guest: GuestPageState }
	| ({ status: "ready" } & Opened);

/** Back from sign-in: the page must not send the visitor round again. */
const SIGN_IN_PARAM = "sign-in";

async function shareRequest(path: string, body: unknown): Promise<OpenedShare> {
	const response = await fetch(path, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error("Share unavailable");
	return (await response.json()) as OpenedShare;
}

/** A runtime app shared to use runs in the guest sandbox, with or without an account. */
function opensAsGuestApp(payload: SharePayload): boolean {
	const resource = payload.resource;
	return (
		resource.type === "gadget" &&
		payload.share.effectiveRole === "use" &&
		isAppRuntimeManifest(
			resource.revision.manifest.entry
				? { entry: resource.revision.manifest.entry }
				: null,
		)
	);
}

function subtitle(access: OsShareAccess | undefined): string {
	if (access === "anyone_with_link")
		return "Shared with you · no sign-in needed";
	if (access) return "Shared with you · opened with your Tedix sign-in";
	return "Shared with you";
}

/**
 * Resume this tab's session for the link, or open the link afresh. A stored
 * session the server refuses is dropped and the link is opened again, so a
 * bookmark keeps working after the session ends.
 */
async function openShareLink(id: string): Promise<Opened | "sign-in"> {
	const stored = readShareLinkSession(id);
	if (stored) {
		try {
			const payload = await shareRequest("/api/os-shared/session", {
				sessionToken: stored,
			});
			return { payload, sessionToken: stored };
		} catch {
			storeShareLinkSession(id, null);
		}
	}
	const payload = await shareRequest("/api/os-shared/open", { id });
	if (payload.needsSignIn) return "sign-in";
	if (!payload.sessionToken) throw new Error("Share unavailable");
	storeShareLinkSession(id, payload.sessionToken);
	return { payload, sessionToken: payload.sessionToken };
}

/**
 * `/s/<id>` on the organization's own host: one permanent address for a
 * shared app, workspace or file. Links for anyone open without an account;
 * links for the organization or invited people send a signed-out visitor to
 * sign in and back here.
 */
export function ShareLinkPage({ id }: { id: string }) {
	const [state, setState] = useState<PageState>({ status: "loading" });
	// One opening survives StrictMode's effect replay.
	const opening = useRef<{
		id: string;
		promise: Promise<Opened | "sign-in">;
	} | null>(null);

	useEffect(() => followDeviceTheme(), []);

	useEffect(() => {
		if (!isShareLinkId(id)) {
			setState({ status: "unavailable", signedIn: false });
			return;
		}
		const url = new URL(window.location.href);
		const backFromSignIn = url.searchParams.has(SIGN_IN_PARAM);
		if (backFromSignIn || url.hash)
			window.history.replaceState(null, "", shareLinkPath(id));
		let alive = true;
		let timer: number | undefined;
		const fail = () => {
			if (!alive) return;
			storeShareLinkSession(id, null);
			setState({ status: "unavailable", signedIn: backFromSignIn });
			if (timer !== undefined) window.clearInterval(timer);
		};
		if (opening.current?.id !== id)
			opening.current = { id, promise: openShareLink(id) };
		opening.current.promise
			.then(async (opened) => {
				if (!alive) return;
				if (opened === "sign-in") {
					opening.current = null;
					// Signed in and still refused: this account is not on the link.
					if (backFromSignIn) fail();
					else window.location.assign(`${shareLinkPath(id)}?${SIGN_IN_PARAM}`);
					return;
				}
				if (opensAsGuestApp(opened.payload)) {
					const guest = await openGuestApp(opened.payload, opened.sessionToken);
					if (alive) setState({ status: "guest", guest });
					return;
				}
				setState({ status: "ready", ...opened });
				// The readable suffix makes the permanent address tell people what
				// it opens; only the id resolves it.
				if (opened.payload.share?.slug)
					window.history.replaceState(
						null,
						"",
						shareLinkPath(id, opened.payload.share.slug),
					);
				// Every read is rechecked, so turning the link off or narrowing
				// it reaches an open page within seconds.
				timer = window.setInterval(() => {
					shareRequest("/api/os-shared/session", {
						sessionToken: opened.sessionToken,
					}).then((payload) => {
						if (alive)
							setState({
								status: "ready",
								payload: { ...payload, access: opened.payload.access },
								sessionToken: opened.sessionToken,
							});
					}, fail);
				}, 3000);
			})
			.catch(fail);
		return () => {
			alive = false;
			if (timer !== undefined) window.clearInterval(timer);
		};
	}, [id]);

	if (state.status === "loading")
		return (
			<main
				className="mx-auto grid min-h-dvh w-full max-w-5xl place-items-center p-4"
				aria-busy
			>
				<Text as="p" role="body" tone="secondary" className="m-0">
					Opening link…
				</Text>
			</main>
		);
	if (state.status === "unavailable")
		return (
			<main className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center p-4">
				<Alert variant="destructive" data-share-unavailable>
					<AlertTitle>This link isn't available</AlertTitle>
					<AlertDescription>
						{state.signedIn
							? "Your account doesn't have access. Ask the person who sent it to invite you."
							: "It may have been turned off or expired, or it belongs to another organization."}
					</AlertDescription>
				</Alert>
			</main>
		);
	if (state.status === "guest")
		return (
			<GuestAppScreen
				state={state.guest}
				setState={(guest) => setState({ status: "guest", guest })}
				forget={() => storeShareLinkSession(id, null)}
			/>
		);
	return (
		<SharedResourceView
			payload={state.payload}
			sessionToken={state.sessionToken}
			subtitle={subtitle(state.payload.access ?? state.payload.share.access)}
		/>
	);
}
