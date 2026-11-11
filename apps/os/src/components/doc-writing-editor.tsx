import { useCallback, useEffect, useRef, useState } from "react";
import {
	OsOutputSchema,
	OsOutputRevisionSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { AppRuntimeRole } from "@tedix/api-contract/schemas/os-app-runtime";
import type { AppRuntimeHostResult } from "@/lib/app-runtime-host";
import type { DocumentContent } from "@/lib/output-models";
import { FileOutputView } from "@/components/output-content";
import { DocumentEditor } from "@/components/doc-v2-editor";
import { useDocWritingDrafts } from "@/components/doc-writing-drafts";
import { Button } from "@/components/kumo/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Skeleton } from "@/components/kumo/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import "./doc-writing-editor.css";

type SavedDocument = {
	title: string;
	revision: number;
	content: DocumentContent;
};

export function DocWritingEditor({
	workspaceId,
	outputId,
	appVersion,
	role,
	onCall,
	savedRevision = 0,
	sourceUnavailable = false,
	draftKey = `${workspaceId}:${outputId}:${appVersion}`,
}: {
	workspaceId: string;
	outputId: string;
	appVersion: number;
	role: AppRuntimeRole;
	onCall: (method: unknown, args: unknown) => Promise<AppRuntimeHostResult>;
	savedRevision?: number;
	sourceUnavailable?: boolean;
	draftKey?: string;
}) {
	const drafts = useDocWritingDrafts();
	const [saved, setSaved] = useState<SavedDocument | null>(null);
	const [draft, setDraft] = useState<DocumentContent | null>(null);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [exportMessage, setExportMessage] = useState<string | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const [writeError, setWriteError] = useState<string | null>(null);
	const [confirmReload, setConfirmReload] = useState(false);
	const dirtyRef = useRef(false);
	const operation = useRef(0);
	const requestedRevision = useRef(0);
	const callRef = useRef(onCall);
	callRef.current = onCall;
	const canWrite = role === "owner" || role === "build";
	const authorized = useRef(false);
	authorized.current = canWrite && !sourceUnavailable;

	const parse = useCallback(
		(value: unknown): SavedDocument => {
			if (
				!value ||
				typeof value !== "object" ||
				!("output" in value) ||
				!("revision" in value)
			)
				throw new Error("The app returned an invalid document");
			const output = OsOutputSchema.parse(value.output);
			const revision = OsOutputRevisionSchema.pick({
				outputId: true,
				revision: true,
				content: true,
			}).parse(value.revision);
			if (
				output.id !== outputId ||
				output.workspaceId !== workspaceId ||
				output.status !== "active" ||
				output.kind !== "document" ||
				revision.outputId !== output.id ||
				revision.content.kind !== "document"
			)
				throw new Error("The app returned a different document");
			return {
				title: output.title,
				revision: revision.revision,
				content: revision.content,
			};
		},
		[outputId, workspaceId],
	);

	const read = useCallback(
		async (discard = false) => {
			const current = ++operation.current;
			setBusy(true);
			try {
				const result = await callRef.current("app.call", {
					method: "readDocument",
					args: [{}],
				});
				if (!result.ok) throw new Error(result.detail || result.error);
				const next = parse(result.value);
				if (current !== operation.current) return;
				const retained =
					!discard && authorized.current ? drafts?.get(draftKey) : undefined;
				setSaved(retained ? { ...next, revision: retained.revision } : next);
				setDraft(structuredClone(retained?.content ?? next.content));
				if (!retained) drafts?.delete(draftKey);
				dirtyRef.current = !!retained;
				setDirty(!!retained);
				setReadError(null);
				setWriteError(null);
			} catch (error) {
				drafts?.delete(draftKey);
				if (current === operation.current)
					setReadError(
						error instanceof Error
							? error.message
							: "Document access is unavailable",
					);
			} finally {
				if (current === operation.current) setBusy(false);
			}
		},
		[parse, drafts, draftKey],
	);
	useEffect(() => {
		if (!canWrite || sourceUnavailable) drafts?.delete(draftKey);
	}, [canWrite, sourceUnavailable, drafts, draftKey]);

	useEffect(() => {
		void read();
		return () => {
			operation.current++;
		};
	}, [read]);
	useEffect(() => {
		if (
			saved &&
			savedRevision > saved.revision &&
			savedRevision > requestedRevision.current &&
			!dirtyRef.current &&
			!busy &&
			!readError &&
			!sourceUnavailable
		) {
			requestedRevision.current = savedRevision;
			void read();
		}
	}, [savedRevision, saved, busy, readError, sourceUnavailable, read]);
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!dirtyRef.current) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, []);

	const save = async () => {
		if (
			!saved ||
			!draft ||
			!canWrite ||
			busy ||
			!dirty ||
			readError ||
			sourceUnavailable
		)
			return;
		const current = ++operation.current;
		setBusy(true);
		setWriteError(null);
		try {
			const result = await callRef.current("app.call", {
				method: "replaceDocument",
				args: [{ content: draft, expectedRevision: saved.revision }],
			});
			if (!result.ok) throw new Error(result.detail || result.error);
			const next = parse(result.value);
			if (current !== operation.current) return;
			setSaved(next);
			setDraft(structuredClone(next.content));
			drafts?.delete(draftKey);
			dirtyRef.current = false;
			setDirty(false);
		} catch (error) {
			if (current === operation.current)
				setWriteError(
					(error instanceof Error
						? error.message
						: "The document could not be saved") +
						". Your draft is preserved. Reload only when you are ready to discard it.",
				);
		} finally {
			if (current === operation.current) setBusy(false);
		}
	};

	const exportMarkdown = async () => {
		setBusy(true);
		try {
			const result = await callRef.current("app.call", {
				method: "exportMarkdown",
				args: [{}],
			});
			if (!result.ok) throw new Error(result.detail || result.error);
			const value = result.value;
			if (
				!value ||
				typeof value !== "object" ||
				!("text" in value) ||
				typeof value.text !== "string" ||
				!("revision" in value) ||
				typeof value.revision !== "number"
			)
				throw new Error("The app returned an invalid export");
			const downloaded = await callRef.current("app.download", {
				filename:
					(saved?.title ?? "Document").replace(/[\\/:*?"<>|]/g, "_") + ".md",
				mimeType: "text/markdown",
				text: value.text,
			});
			if (!downloaded.ok)
				throw new Error(downloaded.detail || downloaded.error);
			setExportMessage(
				`Exported saved document revision ${value.revision} as semantic Markdown. Rich formatting${dirty ? " and unsaved edits are" : " is"} not included.`,
			);
		} catch (error) {
			setExportMessage(
				error instanceof Error ? error.message : "Export failed",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="doc-writing-editor" aria-label="Doc writing editor">
			<header className="doc-writing-header">
				<div>
					<h1>{saved?.title ?? "Doc"}</h1>
					<p>
						{saved ? `Document revision ${saved.revision}` : "Loading document"}{" "}
						· Doc app version {appVersion}
					</p>
				</div>
				<Button
					size="sm"
					variant="default"
					disabled={
						!canWrite || busy || !dirty || !!readError || sourceUnavailable
					}
					onClick={() => void save()}
				>
					{busy ? "Working…" : "Save document"}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={busy}
					onClick={() => (dirty ? setConfirmReload(true) : void read())}
				>
					Reload saved document
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={busy || !saved || !!readError || sourceUnavailable}
					onClick={() => void exportMarkdown()}
				>
					Export Markdown
				</Button>
			</header>
			<div className="doc-writing-status" role="status">
				{dirty
					? `Unsaved changes · based on document revision ${saved?.revision}`
					: saved
						? `Saved · document revision ${saved.revision}`
						: "Loading…"}
				{!canWrite && " · Read-only access"}
			</div>
			{exportMessage && (
				<p className="doc-writing-status" role="status">
					{exportMessage}
				</p>
			)}
			{draft?.file && !readError && !sourceUnavailable && (
				<FileOutputView {...draft.file} />
			)}
			{saved && savedRevision > saved.revision && dirty && (
				<Alert variant="warning">
					<AlertTitle>A newer document revision is available</AlertTitle>
					<AlertDescription>
						Your unsaved draft is preserved. Saving still checks the revision
						you started with.
					</AlertDescription>
				</Alert>
			)}
			{writeError && (
				<Alert variant="warning">
					<AlertTitle>Document not saved</AlertTitle>
					<AlertDescription>{writeError}</AlertDescription>
				</Alert>
			)}
			{readError || sourceUnavailable ? (
				<Alert variant="warning">
					<AlertTitle>Document unavailable</AlertTitle>
					<AlertDescription>
						{readError ?? "Document source access is unavailable."}
					</AlertDescription>
				</Alert>
			) : draft ? (
				<DocumentEditor
					value={draft}
					disabled={!canWrite || busy}
					onChange={(next) => {
						if (!canWrite || busy) return;
						const content = {
							...next,
							...(draft.file ? { file: draft.file } : {}),
						};
						setDraft(content);
						if (saved)
							drafts?.set(draftKey, { revision: saved.revision, content });
						dirtyRef.current = true;
						setDirty(true);
						setWriteError(null);
					}}
				/>
			) : (
				<Skeleton className="h-80" />
			)}
			<ConfirmDialog
				open={confirmReload}
				onOpenChange={setConfirmReload}
				title="Discard unsaved edits?"
				description="Reloading replaces your draft with the current saved document."
				confirmLabel="Discard draft and reload"
				pendingLabel="Reloading…"
				isPending={busy}
				onConfirm={() => {
					setConfirmReload(false);
					void read(true);
				}}
			/>
		</section>
	);
}
