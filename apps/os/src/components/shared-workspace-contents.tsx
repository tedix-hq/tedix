import {
	AppWindow,
	ArrowLeft,
	FileText,
	Lock,
	PresentationChart,
	Table,
	VideoCamera,
} from "@phosphor-icons/react";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { OutputContentView } from "@/components/output-content";

export type SharedWorkspaceFile = {
	id: string;
	title: string;
	kind: "document" | "sheet" | "presentation" | "video";
};

export type SharedWorkspaceApp = {
	id: string;
	name: string;
	description: string | null;
	/** It runs in the guest sandbox, so a visitor without an account may use it. */
	opensWithoutSignIn?: boolean;
};

const KIND: Record<
	SharedWorkspaceFile["kind"],
	{ label: string; Icon: typeof FileText }
> = {
	document: { label: "Document", Icon: FileText },
	sheet: { label: "Sheet", Icon: Table },
	presentation: { label: "Slides", Icon: PresentationChart },
	video: { label: "Video", Icon: VideoCamera },
};

type OpenedFile =
	| { status: "loading"; file: SharedWorkspaceFile }
	| { status: "ready"; file: SharedWorkspaceFile; content: OsOutputContent }
	| { status: "unavailable"; file: SharedWorkspaceFile };

/** A file's text only: an uploaded file's preview reads through the owner's workspace. */
function readableContent(content: OsOutputContent): OsOutputContent {
	if (content.kind !== "document" || !content.file) return content;
	const { file: _file, ...text } = content;
	return text;
}

/** What a workspace link leaves out, in plain words, or null when nothing is. */
export function workspaceLeftOutText(
	hiddenFiles: number,
	appsNeedingSignIn: number,
): string | null {
	const parts = [
		hiddenFiles > 0
			? `${hiddenFiles === 1 ? "1 file isn't" : `${hiddenFiles} files aren't`} shown because ${hiddenFiles === 1 ? "it holds" : "they hold"} data from connected accounts`
			: null,
		appsNeedingSignIn > 0
			? `${appsNeedingSignIn === 1 ? "1 app needs" : `${appsNeedingSignIn} apps need`} a Tedix sign-in to open`
			: null,
	].filter(Boolean);
	return parts.length ? `${parts.join(", and ")}.` : null;
}

/**
 * A workspace shared with "Anyone with the link": its documents, sheets and
 * slides to read, and its apps, read-only. Apps that run in the guest
 * sandbox open for use; the others are listed but need a sign-in. Files
 * holding data from connected accounts never reach this page; it only says
 * how many were left out.
 */
export function SharedWorkspaceContents(props: {
	files: SharedWorkspaceFile[];
	apps: SharedWorkspaceApp[];
	hiddenFileCount: number;
	sessionToken: string;
	onOpenApp?: (appId: string) => void;
}) {
	const [opened, setOpened] = useState<OpenedFile | null>(null);
	const openedId = opened?.file.id ?? null;
	useEffect(() => {
		if (!opened || opened.status !== "loading") return;
		let alive = true;
		fetch("/api/os-shared/output", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionToken: props.sessionToken,
				outputId: opened.file.id,
			}),
		})
			.then((response) =>
				response.ok
					? (response.json() as Promise<{
							revision: { content: OsOutputContent };
						}>)
					: Promise.reject(new Error("unavailable")),
			)
			.then(
				(body) => {
					if (alive)
						setOpened({
							status: "ready",
							file: opened.file,
							content: readableContent(body.revision.content),
						});
				},
				() => {
					if (alive) setOpened({ status: "unavailable", file: opened.file });
				},
			);
		return () => {
			alive = false;
		};
	}, [opened, props.sessionToken]);

	const appsNeedingSignIn = props.apps.filter(
		(app) => !app.opensWithoutSignIn,
	).length;
	const leftOut = workspaceLeftOutText(
		props.hiddenFileCount,
		appsNeedingSignIn,
	);
	const empty = props.files.length === 0 && props.apps.length === 0;

	return (
		<div
			className="flex flex-1 flex-col gap-4 lg:min-h-0 lg:flex-row"
			data-shared-workspace
		>
			<nav
				aria-label="In this workspace"
				className={`grid content-start gap-4 lg:w-80 lg:shrink-0 lg:overflow-y-auto${opened ? " max-lg:hidden" : ""}`}
			>
				{leftOut ? (
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0 flex gap-2"
						data-shared-left-out
					>
						<Lock size={14} aria-hidden className="mt-0.5 shrink-0" />
						<span>{leftOut}</span>
					</Text>
				) : null}
				{empty ? (
					<Text as="p" role="body" tone="secondary" className="m-0">
						Nothing in this workspace can be shown without signing in yet.
					</Text>
				) : null}
				{props.files.length > 0 ? (
					<section className="grid gap-1" aria-label="Files">
						<Text as="h2" role="label" tone="strong" className="m-0">
							Files
						</Text>
						<ul className="m-0 grid list-none gap-0.5 p-0">
							{props.files.map((file) => {
								const { label, Icon } = KIND[file.kind] ?? KIND.document;
								const selected = file.id === openedId;
								return (
									<li key={file.id}>
										<Button
											variant={selected ? "secondary" : "ghost"}
											className="h-auto min-h-11 w-full justify-start py-2 text-left"
											aria-current={selected ? "true" : undefined}
											onClick={() => setOpened({ status: "loading", file })}
											data-shared-file={file.id}
										>
											<Icon size={16} aria-hidden className="shrink-0" />
											<span className="grid min-w-0 flex-1">
												<span className="truncate">{file.title}</span>
												<Text as="span" role="label" tone="secondary">
													{label}
												</Text>
											</span>
										</Button>
									</li>
								);
							})}
						</ul>
					</section>
				) : null}
				{props.apps.length > 0 ? (
					<section className="grid gap-1" aria-label="Apps">
						<Text as="h2" role="label" tone="strong" className="m-0">
							Apps
						</Text>
						<ul className="m-0 grid list-none gap-0.5 p-0">
							{props.apps.map((app) => (
								<li
									key={app.id}
									className="flex min-h-11 items-center gap-2 px-3 py-1.5"
									data-shared-app={app.id}
								>
									<AppWindow
										size={16}
										aria-hidden
										className="shrink-0 text-kumo-subtle"
									/>
									<span className="grid min-w-0 flex-1">
										<Text as="span" role="body" className="m-0 truncate">
											{app.name}
										</Text>
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="m-0 truncate"
										>
											{app.opensWithoutSignIn
												? (app.description ?? "App")
												: "Needs a Tedix sign-in to open"}
										</Text>
									</span>
									{app.opensWithoutSignIn && props.onOpenApp ? (
										<Button
											size="sm"
											variant="secondary"
											onClick={() => props.onOpenApp?.(app.id)}
											aria-label={`Open ${app.name}`}
										>
											Open
										</Button>
									) : null}
								</li>
							))}
						</ul>
					</section>
				) : null}
			</nav>
			<section
				aria-label={opened ? opened.file.title : "Reader"}
				className={`flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto${opened ? "" : " max-lg:hidden"}`}
				data-shared-reader
			>
				{opened ? (
					<>
						<div className="flex items-center gap-2 lg:hidden">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setOpened(null)}
								data-shared-back
							>
								<ArrowLeft size={14} aria-hidden /> All files and apps
							</Button>
						</div>
						<Text as="h2" role="section" className="m-0">
							{opened.file.title}
						</Text>
						{opened.status === "loading" ? (
							<Text as="p" role="body" tone="secondary" className="m-0">
								Opening…
							</Text>
						) : opened.status === "unavailable" ? (
							<Alert variant="warning">
								<AlertTitle>This file can't be shown</AlertTitle>
								<AlertDescription>
									It may have been removed, or it now holds data from connected
									accounts.
								</AlertDescription>
							</Alert>
						) : (
							<div data-shared-output>
								<OutputContentView content={opened.content} />
							</div>
						)}
					</>
				) : (
					<Text
						as="p"
						role="body"
						tone="secondary"
						className="m-0 grid flex-1 place-items-center"
					>
						{props.files.length > 0
							? "Choose a document, sheet or slide deck to read it here."
							: ""}
					</Text>
				)}
			</section>
		</div>
	);
}
