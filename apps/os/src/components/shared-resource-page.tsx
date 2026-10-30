import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { OrganizationMark } from "@/shared/organization-mark";
import { ArrowRight, ShieldCheck } from "@phosphor-icons/react";
import type {
	OsShareAccess,
	OsShareRole,
} from "@tedix/api-contract/contracts/os-shares";
import type {
	OsGadgetManifest,
	OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
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
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { SharedReviewBatch } from "./shared-review-batch";
import {
	SharedWorkspaceContents,
	type SharedWorkspaceFile,
} from "@/components/shared-workspace-contents";
import { ShareControls } from "@/components/share-controls";
import { WidgetFrame } from "@/components/widget-frame";
import { OutputContentView } from "@/components/output-content";
import { gadgetWidgetTargetFromManifest } from "@/lib/gadget-widget-target";
import { absoluteTime } from "@/lib/time";
import { adoptShareLinkAddress } from "@/lib/share-link-session";

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

export type SharePayload = {
	organization?: { name: string; logoUrl: string | null } | null;
	share: {
		id: string;
		/** The link's permanent id; an old `#token=` link moves to `/s/<id>`. */
		publicId?: string;
		access?: OsShareAccess;
		resourceType: "gadget" | "workspace" | "output";
		role: OsShareRole;
		effectiveRole: OsShareRole;
		revisionMode: "living" | "pinned";
		note: string | null;
		expiresAt: string | null;
		createdAt?: string;
		/** Who made the link, for the "Shared by <name> · <date>" line. */
		sharedByName?: string | null;
		/** The readable suffix of the link's address. */
		slug?: string;
		policyReason: string | null;
	};
	/** True when the visitor may manage this link, so the page offers Share. */
	canManage?: boolean;
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
				gadgets: Array<SharedGadget & { opensWithoutSignIn?: boolean }>;
				/** Documents, sheets and slides without data from connected accounts. */
				files?: SharedWorkspaceFile[];
				/** How many files were left out because they hold connected data. */
				hiddenFileCount?: number;
				openPath: string | null;
		  }
		| {
				type: "output";
				output: { id: string; title: string };
				revision: { id: string; revision: number; content: OsOutputContent };
		  };
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
					{gadget.description ?? "Shared App"}
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
							This revision has no standard widget resource.
						</AlertDescription>
					</Alert>
				)}
				{role === "build" && manifest && (
					<Collapsible>
						<CollapsibleDefaultTrigger className="group/disclosure">
							Shared source manifest
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent keepMounted>
							<CodeBlock
								className="max-h-72 overflow-auto"
								code={JSON.stringify(manifest, null, 2)}
								lang="json"
								showCopyButton
							/>
						</CollapsibleDefaultContent>
					</Collapsible>
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

/**
 * Before permanent addresses, one tab kept one share session here. A link's
 * session now lives under its own id (`tedix.os.share.<id>`, see
 * share-link-session.ts); the original share secret never enters storage.
 */
const LEGACY_SHARE_SESSION_KEY = "tedix.os.share.session.v1";
/** Read and drop a session an older page kept for this tab, if any. */
function takeLegacyShareSession(): string | null {
	try {
		const token = window.sessionStorage.getItem(LEGACY_SHARE_SESSION_KEY);
		window.sessionStorage.removeItem(LEGACY_SHARE_SESSION_KEY);
		return token;
	} catch {
		return null;
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
			const legacyToken = takeLegacyShareSession();
			const resumeToken = token ? null : (pending?.resumeToken ?? legacyToken);
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
					// An old link, or a session an older page kept, moves to the
					// link's permanent address and its own session key; the router
					// then shows that page, which resumes this session.
					if (payload.share.publicId) {
						adoptShareLinkAddress(
							payload.share.publicId,
							sessionToken,
							payload.share.slug,
						);
						return;
					}
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
				<p className="text-kumo-subtle">Opening share…</p>
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
	return (
		<SharedResourceView
			payload={state.payload}
			sessionToken={state.sessionToken}
		/>
	);
}

/** What an open share shows: an app, a workspace's contents, or a file. */
export function SharedResourceView({
	payload,
	sessionToken,
	subtitle = "Shared with you · opened with your own Tedix sign-in",
	onOpenApp,
}: {
	payload: SharePayload;
	sessionToken: string;
	subtitle?: string;
	/** Opens one of a shared workspace's apps in the guest sandbox. */
	onOpenApp?: (appId: string) => void;
}) {
	const resource = payload.resource;
	const role = payload.share.effectiveRole;
	const title =
		resource.type === "output"
			? resource.output.title
			: resource.type === "gadget"
				? resource.gadget.name
				: resource.workspace.name;
	const gadgets: SharedGadget[] =
		resource.type === "gadget"
			? [{ ...resource.gadget, revision: resource.revision }]
			: resource.type === "workspace"
				? resource.gadgets
				: [];
	const gadgetCards = (
		<section className="grid gap-4">
			{gadgets.map((gadget) => (
				<SharedGadgetCard key={gadget.id} gadget={gadget} role={role} />
			))}
		</section>
	);
	const sharedBy = payload.share.sharedByName ?? "someone";
	const shareResource =
		resource.type === "output"
			? {
					outputId: resource.output.id,
					currentRevisionId: resource.revision.id,
				}
			: resource.type === "gadget"
				? {
						resourceType: "gadget" as const,
						resourceId: resource.gadget.id,
						currentRevisionId: resource.revision.id,
					}
				: {
						resourceType: "workspace" as const,
						resourceId: resource.workspace.id,
					};
	return (
		// Desktop is a full-height app whose panes scroll on their own; on small
		// screens the page scrolls normally. The content is full width below the
		// header, like a shared artifact.
		<main className="flex min-h-dvh w-full flex-col gap-3 px-3 py-3 sm:px-6 sm:py-4 lg:h-dvh lg:overflow-hidden">
			<header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-kumo-line border-b pb-3">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<OrganizationMark
						name={payload.organization?.name ?? "Tedix"}
						logoUrl={payload.organization?.logoUrl}
						size="sm"
					/>
					<Text
						as="span"
						role="label"
						tone="strong"
						className="m-0 truncate"
						data-share-owner
					>
						{resource.type === "workspace"
							? resource.workspace.name
							: (payload.organization?.name ?? "Tedix")}
					</Text>
				</div>
				<Text
					as="p"
					role="label"
					tone="secondary"
					className="m-0 shrink-0"
					data-shared-by
				>
					Shared by {sharedBy}
					{payload.share.createdAt
						? ` · ${absoluteTime(payload.share.createdAt)}`
						: ""}
				</Text>
				{payload.canManage ? <ShareControls {...shareResource} /> : null}
			</header>
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
				<section className="min-w-[12rem] flex-1">
					<Text as="h1" role="title" className="m-0 truncate">
						{title}
					</Text>
					<Text as="p" role="label" tone="secondary" className="m-0">
						{subtitle}
					</Text>
				</section>
				<Badge variant="success">
					<ShieldCheck size={13} /> {ROLE_LABEL[role]}
				</Badge>
				<Badge variant="secondary">
					{payload.share.revisionMode === "pinned"
						? "Fixed version"
						: "Latest version"}
				</Badge>
				<Popover>
					<PopoverTrigger render={<Button variant="ghost" size="sm" />}>
						About access
					</PopoverTrigger>
					<PopoverContent align="end" className="w-72">
						<PopoverTitle className="sr-only">About access</PopoverTitle>
						<PopoverDescription>
							This share does not pass on the owner's connections, credentials
							or private memory. Tedix checks access when you open it and while
							it stays open.
						</PopoverDescription>
					</PopoverContent>
				</Popover>
			</div>
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
			{role === "build" && resource.type !== "output" && resource.openPath && (
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
			{resource.type === "workspace" &&
			resource.files &&
			payload.share.access === "anyone_with_link" &&
			role !== "build" ? (
				<SharedWorkspaceContents
					files={resource.files}
					apps={resource.gadgets}
					hiddenFileCount={resource.hiddenFileCount ?? 0}
					sessionToken={sessionToken}
					onOpenApp={onOpenApp}
				/>
			) : resource.type === "output" ? (
				<div
					className="flex-1 lg:min-h-0 lg:overflow-y-auto"
					data-shared-output
				>
					<OutputContentView content={sharedOutputContent(resource)} />
				</div>
			) : resource.type === "gadget" && role === "use" ? (
				<div className="flex flex-1 flex-col lg:min-h-0 lg:overflow-hidden">
					<SharedReviewBatch
						shareId={payload.share.id}
						sessionToken={sessionToken}
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

type SharedOutput = Extract<SharePayload["resource"], { type: "output" }>;

/**
 * A shared file's content. An uploaded file's preview reads through the
 * owner's workspace, which a link never opens, so only its text shows.
 */
function sharedOutputContent(resource: SharedOutput): OsOutputContent {
	const content = resource.revision.content;
	if (content.kind !== "document" || !content.file) return content;
	const { file: _file, ...text } = content;
	return text;
}
