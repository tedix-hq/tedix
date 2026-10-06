import { ArrowRight, LockKey, ShieldCheck } from "@phosphor-icons/react";
import type { OsShareRole } from "@tedix/api-contract/contracts/os-shares";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useState } from "react";
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

export function SharedResourcePage() {
	const [state, setState] = useState<PageState>({ status: "loading" });

	useEffect(() => {
		const params = new URLSearchParams(window.location.hash.slice(1));
		const token = params.get("token");
		window.history.replaceState(
			null,
			"",
			window.location.pathname + window.location.search,
		);
		if (!token) {
			setState({ status: "unavailable" });
			return;
		}
		let alive = true;
		let timer: number | undefined;
		shareRequest("/api/os-shared/redeem", { token })
			.then((payload) => {
				if (!alive || !payload.sessionToken) return;
				const sessionToken = payload.sessionToken;
				setState({ status: "ready", payload, sessionToken });
				timer = window.setInterval(() => {
					shareRequest("/api/os-shared/session", { sessionToken }).then(
						(next) => {
							if (alive)
								setState({ status: "ready", payload: next, sessionToken });
						},
						() => {
							if (alive) setState({ status: "unavailable" });
						},
					);
				}, 3000);
			})
			.catch(() => {
				if (alive) setState({ status: "unavailable" });
			});
		return () => {
			alive = false;
			if (timer !== undefined) window.clearInterval(timer);
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
	return (
		<main className="mx-auto grid min-h-screen w-full max-w-6xl content-start gap-5 p-4 sm:p-8">
			<header className="flex flex-wrap items-center gap-3 border-kumo-line border-b pb-4">
				<span className="grid size-9 place-items-center rounded-lg bg-kumo-brand text-white">
					T
				</span>
				<section className="min-w-0 flex-1">
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0 uppercase tracking-wider"
					>
						Tedix OS governed share
					</Text>
					<Text as="h1" role="title" className="m-0 truncate">
						{title}
					</Text>
				</section>
				<Badge variant="success">
					<ShieldCheck size={13} /> {payload.share.effectiveRole}
				</Badge>
				<Badge variant="secondary">{payload.share.revisionMode}</Badge>
			</header>
			{payload.share.note && (
				<p className="m-0 text-kumo-subtle">{payload.share.note}</p>
			)}
			{payload.share.policyReason && (
				<Alert variant="warning">
					<AlertTitle>Access narrowed by policy</AlertTitle>
					<AlertDescription>{payload.share.policyReason}</AlertDescription>
				</Alert>
			)}
			<Alert variant="info">
				<LockKey size={16} />
				<AlertTitle>
					Your identity, connections, and billing remain yours
				</AlertTitle>
				<AlertDescription>
					Widgets run through your own authenticated Tedix session. The owner's
					provider credentials and private memory are never shared.
				</AlertDescription>
			</Alert>
			{payload.share.effectiveRole === "build" && resource.openPath && (
				<div>
					<Button onClick={() => window.location.assign(resource.openPath!)}>
						Open authenticated Canvas <ArrowRight size={14} />
					</Button>
					<Text as="p" role="label" tone="secondary" className="mt-1">
						Tedix rechecks your tenant membership and authoring permission
						before every write.
					</Text>
				</div>
			)}
			<section className="grid gap-4">
				{gadgets.map((gadget) => (
					<SharedGadgetCard
						key={gadget.id}
						gadget={gadget}
						role={payload.share.effectiveRole}
					/>
				))}
			</section>
		</main>
	);
}
