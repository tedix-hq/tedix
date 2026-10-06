import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { CodeBlock } from "@/components/kumo/code";
import { OutputContentView } from "@/components/output-content";
import type { CollabRecoveryResult } from "@/lib/use-collab-doc";
import { parseOutputDraft } from "@/lib/canvas-draft";

function RecoveryPreview({
	text,
	outputKind,
}: {
	text: string;
	outputKind?: OsOutputContent["kind"];
}) {
	const parsed = outputKind ? parseOutputDraft(text, outputKind) : null;
	return parsed?.ok ? (
		<OutputContentView content={parsed.content} />
	) : (
		<CodeBlock
			code={
				text.length > 20000
					? `${text.slice(0, 20000)}\n… Preview truncated. Download the full draft backup.`
					: text
			}
			lang="json"
			showCopyButton
		/>
	);
}

/** Comparison is read-only; replacing the shared draft remains an explicit second step. */
export function CanvasDocumentRecovery({
	draftText,
	savedText,
	revision,
	outputKind,
	isGadget,
	invalidDraft = false,
	disabled = false,
	onReplace,
}: {
	draftText: string;
	savedText: string;
	revision: number;
	outputKind?: OsOutputContent["kind"];
	isGadget: boolean;
	invalidDraft?: boolean;
	disabled?: boolean;
	onReplace: () => Promise<CollabRecoveryResult>;
}) {
	const [reviewing, setReviewing] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [recoveryError, setRecoveryError] = useState<string | null>(null);
	const restore = async () => {
		setRestoring(true);
		setRecoveryError(null);
		try {
			const result = await onReplace();
			if (result.ok) setReviewing(false);
			else setRecoveryError(result.message);
		} catch {
			setRecoveryError(
				"Recovery was not confirmed. Your draft remains available to download. Try again after reconnecting.",
			);
		} finally {
			setRestoring(false);
		}
	};
	const backup = () => {
		const url = URL.createObjectURL(
			new Blob([draftText], { type: "application/json" }),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "preserved-document-draft.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	return (
		<Alert variant="warning" data-canonical-recovery>
			<AlertTitle>
				{invalidDraft
					? "Recover this draft"
					: "An updated version needs review"}
			</AlertTitle>
			<AlertDescription className="grid gap-3">
				<p>
					{invalidDraft
						? "The saved version is unchanged. Download your draft to preserve its contents, then review the saved version before restoring it."
						: "Your shared draft is preserved. Another saved version changed this document. Compare both copies before deciding what to keep."}
				</p>
				{reviewing ? (
					<>
						<div className="grid min-w-0 gap-3 lg:grid-cols-2">
							{[
								{ title: "Your preserved draft", text: draftText },
								{ title: `Saved version ${revision}`, text: savedText },
							].map(({ title, text }) => (
								<Card key={title}>
									<CardHeader>
										<CardTitle>{title}</CardTitle>
									</CardHeader>
									<CardContent className="max-h-96 overflow-auto">
										<RecoveryPreview text={text} outputKind={outputKind} />
									</CardContent>
								</Card>
							))}
						</div>
						<p>
							Loading the saved version replaces the draft for every connected
							editor. Download a backup first if you want to keep these draft
							changes.
							{!invalidDraft &&
								!disabled &&
								!restoring &&
								" You can also keep editing your draft while you compare."}
						</p>
						{recoveryError && <p role="alert">{recoveryError}</p>}
						<div className="flex flex-wrap gap-2">
							<Button size="sm" variant="outline" onClick={backup}>
								Download draft backup
							</Button>
							<Button
								size="sm"
								variant="destructive"
								disabled={disabled || restoring}
								onClick={restore}
							>
								{restoring
									? "Restoring…"
									: isGadget
										? `Replace with revision ${revision}`
										: `Load saved version ${revision}`}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={restoring}
								onClick={() => setReviewing(false)}
							>
								Keep the shared draft
							</Button>
						</div>
					</>
				) : (
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="outline" onClick={backup}>
							Download draft backup
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setReviewing(true)}
						>
							Compare versions
						</Button>
					</div>
				)}
			</AlertDescription>
		</Alert>
	);
}
