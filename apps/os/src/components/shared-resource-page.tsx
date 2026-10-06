import { ArrowRight, ShieldCheck } from "@phosphor-icons/react";
import type { OsShareRole } from "@tedix/api-contract/contracts/os-shares";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { CodeBlock } from "@/components/kumo/code";
import { Text } from "@/components/kumo/text";
import { SharedReviewBatch } from "./shared-review-batch";
import { WidgetFrame } from "@/components/widget-frame";
import { gadgetWidgetTargetFromManifest } from "@/lib/gadget-widget-target";

type SharedGadget = {
	id: string;
	name: string;
	description: string | null;
	revision: null | {
		id: string;
		revision: number;
		manifest: Partial<OsGadgetManifest>;
	};
};

type SharePayload = {
	share: {
		id: string;
		resourceType: "gadget" | "workspace" | "output";
		role: OsShareRole;
		effectiveRole: OsShareRole;
		revisionMode: "living" | "pinned";
		note: string | null;
		expiresAt: string | null;
		policyReason: string | null;
	};
	resource:
		| {
				type: "gadget";
				gadget: Omit<SharedGadget, "revision"> & { workspaceId: string };
				revision: NonNullable<SharedGadget["revision"]>;
				openPath: string | null;
		  }
		| {
				type: "workspace";
				workspace: { id: string; name: string; description: string | null };
				gadgets: SharedGadget[];
				openPath: string | null;
		  }
		| { type: "output" };
	sessionToken?: string;
};

type PageState =
	| { status: "loading" }
	| { status: "ready"; payload: SharePayload; sessionToken: string }
	| { status: "unavailable" };

async function shareRequest(
	path: string,
	body: unknown,
): Promise<SharePayload> {
	const response = await fetch(path, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error("Share unavailable");
	return (await response.json()) as SharePayload;
}

function SharedGadgetCard({
	gadget,
	role,
}: {
	gadget: SharedGadget;
	role: OsShareRole;
}) {
	const manifest = gadget.revision?.manifest;
	const widgetTarget = gadgetWidgetTargetFromManifest(
		manifest?.entry
			? ({
					entry: manifest.entry,
					capabilities: manifest.capabilities ?? [],
					...(manifest.skillSlug ? { skillSlug: manifest.skillSlug } : {}),
					...(manifest.notes ? { notes: manifest.notes } : {}),
				} satisfies OsGadgetManifest)
			: null,
	);
	return (
		<Card>
			<CardHeader>
				<CardTitle>{gadget.name}</CardTitle>
				<Text as="p" role="body" tone="secondary" className="m-0">
					{gadget.description ?? "Shared Gadget"}
				</Text>
			</CardHeader>
			<CardContent className="grid gap-3">
				{gadget.revision && (
					<Badge variant="secondary">Revision {gadget.revision.revision}</Badge>
				)}
				{widgetTarget ? (
					<WidgetFrame
						appSlug={widgetTarget.appSlug}
						resourceUri={widgetTarget.resourceUri}
						title={gadget.name}
					/>
				) : (
					<Alert variant="warning">
						<AlertTitle>No runnable MCP Apps view</AlertTitle>
						<AlertDescription>
							This revision has no standard governed widget resource.
						</AlertDescription>
					</Alert>
				)}
				{role === "build" && manifest && (
					<details>
						<summary className="cursor-pointer text-kumo-subtle text-xs">
							Shared source manifest
						</summary>
						<CodeBlock
							className="max-h-72 overflow-auto"
							code={JSON.stringify(manifest, null, 2)}
							lang="json"
							showCopyButton
						/>
					</details>
				)}
			</CardContent>
		</Card>
	);
}

const ROLE_LABEL: Record<OsShareRole, string> = {
	viewer: "Can view",
	use: "Can use",
	build: "Can edit",
};

// Per-tab resume capability only. The original share secret never enters storage.
const SHARE_SESSION_KEY = "tedix.os.share.session.v1";
function storedShareSession(): string | null {
	try {
		return window.sessionStorage.getItem(SHARE_SESSION_KEY);
	} catch {
		return null;
	}
}
function storeShareSession(token: string | null): void {
	try {
		if (token) window.sessionStorage.setItem(SHARE_SESSION_KEY, token);
		else window.sessionStorage.removeItem(SHARE_SESSION_KEY);
	} catch {
		/* Blocked storage still permits this in-memory session. */
	}
}

export function SharedResourcePage() {
	const [state, setState] = useState<PageState>({ status: "loading" });
	// Reuse an in-flight redemption across StrictMode effect replay. No original
	// link secret is retained here; only the request promise and resume capability.
	const pendingOpening = useRef<{
		promise: Promise<SharePayload>;
		redeeming: boolean;
		resumeToken: string | null;
	} | null>(null);

	useEffect(() => {
		let stopCurrent = () => {};
		const open = () => {
			stopCurrent();
			setState({ status: "loading" });
			const token = new URLSearchParams(window.location.hash.slice(1)).get(
				"token",
			);
			window.history.replaceState(
				null,
				"",
				window.location.pathname + window.location.search,
			);
			// A new link replaces any previous tab session; it never falls back on failure.
			const pending = token ? null : pendingOpening.current;
			const resumeToken = token
				? null
				: (pending?.resumeToken ?? storedShareSession());
			if (token) storeShareSession(null);
			if (!token && !resumeToken && !pending) {
				setState({ status: "unavailable" });
				return;
			}
			let alive = true;
			let timer: number | undefined;
			stopCurrent = () => {
				alive = false;
				if (timer !== undefined) window.clearInterval(timer);
			};
			const fail = () => {
				if (!alive) return;
				pendingOpening.current = null;
				storeShareSession(null);
				setState({ status: "unavailable" });
				stopCurrent();
			};
			const opening = pending ?? {
				promise: token
					? shareRequest("/api/os-shared/redeem", { token })
					: shareRequest("/api/os-shared/session", {
							sessionToken: resumeToken,
						}),
				redeeming: Boolean(token),
				resumeToken,
			};
			pendingOpening.current = opening;
			opening.promise
				.then((payload) => {
					if (!alive) return;
					const sessionToken = opening.redeeming
						? payload.sessionToken
						: opening.resumeToken;
					pendingOpening.current = null;
					if (!sessionToken) {
						fail();
						return;
					}
					// Storage is never authority: redemption/resume must succeed on the server.
					storeShareSession(sessionToken);
					setState({ status: "ready", payload, sessionToken });
					timer = window.setInterval(() => {
						shareRequest("/api/os-shared/session", { sessionToken }).then(
							(next) => {
								if (alive)
									setState({ status: "ready", payload: next, sessionToken });
							},
							fail,
						);
					}, 3000);
				})
				.catch(fail);
		};
		const onHashChange = () => {
			// Removing a redeemed fragment is not a request to reopen the previous share.
			if (new URLSearchParams(window.location.hash.slice(1)).has("token"))
				open();
		};
		window.addEventListener("hashchange", onHashChange);
		open();
		return () => {
			stopCurrent();
			window.removeEventListener("hashchange", onHashChange);
		};
	}, []);

	if (state.status === "loading") {
		return (
			<main
				className="mx-auto grid min-h-screen w-full max-w-5xl place-items-center p-6"
				aria-busy
			>
				<p className="text-kumo-subtle">Opening governed share…</p>
			</main>
		);
	}
	if (state.status === "unavailable") {
		return (
			<main className="mx-auto grid min-h-screen w-full max-w-xl place-items-center p-6">
				<Alert variant="destructive">
					<AlertTitle>This share is no longer available</AlertTitle>
					<AlertDescription>
						It may have expired, been revoked, or been narrowed by policy.
					</AlertDescription>
				</Alert>
			</main>
		);
	}
	const { payload } = state;
	const resource = payload.resource;
	if (resource.type === "output") {
		return null;
	}
	const title =
		resource.type === "gadget" ? resource.gadget.name : resource.workspace.name;
	const gadgets: SharedGadget[] =
		resource.type === "gadget"
			? [
					{
						...resource.gadget,
						revision: resource.revision,
					},
				]
			: resource.gadgets;
	const gadgetCards = (
		<section className="grid gap-4">
			{gadgets.map((gadget) => (
				<SharedGadgetCard
					key={gadget.id}
					gadget={gadget}
					role={payload.share.effectiveRole}
				/>
			))}
		</section>
	);
	return (
		// Desktop is a full-height app whose panes scroll on their own; on small
		// screens the page scrolls normally.
		<main className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-3 px-3 py-3 sm:px-6 sm:py-4 lg:h-dvh lg:overflow-hidden">
			<header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
				<span
					aria-hidden
					className="grid size-8 shrink-0 place-items-center rounded-lg bg-kumo-brand font-semibold text-white"
				>
					T
				</span>
				<section className="min-w-[12rem] flex-1">
					<Text as="h1" role="title" className="m-0 truncate">
						{title}
					</Text>
					<Text as="p" role="label" tone="secondary" className="m-0">
						Shared with you · opened with your own Tedix sign-in
					</Text>
				</section>
				<Badge variant="success">
					<ShieldCheck size={13} /> {ROLE_LABEL[payload.share.effectiveRole]}
				</Badge>
				<Badge variant="secondary">
					{payload.share.revisionMode === "pinned"
						? "Fixed version"
						: "Latest version"}
				</Badge>
				<details className="relative text-sm text-kumo-subtle">
					<summary className="cursor-pointer select-none">About access</summary>
					<p className="absolute right-0 z-10 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-kumo-line bg-kumo-elevated p-3 text-kumo-default shadow-lg">
						This share uses your own signed-in Tedix account. It does not
						transfer the owner's connections, credentials or private memory.
						Tedix checks access when you open it and while it remains open.
					</p>
				</details>
			</header>
			{payload.share.note && (
				<p className="m-0 shrink-0 text-sm text-kumo-subtle">
					{payload.share.note}
				</p>
			)}
			{payload.share.policyReason && (
				<Alert variant="warning" className="shrink-0">
					<AlertTitle>Access narrowed by policy</AlertTitle>
					<AlertDescription>{payload.share.policyReason}</AlertDescription>
				</Alert>
			)}
			{payload.share.effectiveRole === "build" && resource.openPath && (
				<div className="shrink-0">
					<Button onClick={() => window.location.assign(resource.openPath!)}>
						Open authenticated Canvas <ArrowRight size={14} />
					</Button>
					<Text as="p" role="label" tone="secondary" className="mt-1">
						Tedix rechecks your tenant membership and authoring permission
						before every write.
					</Text>
				</div>
			)}
			{resource.type === "gadget" && payload.share.effectiveRole === "use" ? (
				<div className="flex flex-1 flex-col lg:min-h-0 lg:overflow-hidden">
					<SharedReviewBatch
						shareId={payload.share.id}
						sessionToken={state.sessionToken}
						fallback={gadgetCards}
					/>
				</div>
			) : (
				<div className="flex-1 lg:min-h-0 lg:overflow-y-auto">
					{gadgetCards}
				</div>
			)}
		</main>
	);
}
