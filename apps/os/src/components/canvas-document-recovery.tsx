import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import type { CollabRecoveryResult } from "@/lib/use-collab-doc";

/**
 * The choice a draft faces when a newer version was saved under it: load the
 * newer version, or keep the draft's changes and save them on top of it.
 *
 * Plain words and version numbers only. Loading discards the draft for every
 * connected editor, so it always asks first; keeping hands the decision to the
 * Save button, which then saves on top of the newer version.
 */
export function CanvasDocumentRecovery({
	draftText,
	revision,
	invalidDraft = false,
	keptChanges = false,
	disabled = false,
	onReplace,
	onKeepChanges,
}: {
	draftText: string;
	/** The newer saved version. */
	revision: number;
	invalidDraft?: boolean;
	/** The user chose to keep their changes; Save now writes on top of `revision`. */
	keptChanges?: boolean;
	disabled?: boolean;
	onReplace: () => Promise<CollabRecoveryResult>;
	onKeepChanges?: (keep: boolean) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [recoveryError, setRecoveryError] = useState<string | null>(null);
	const version = `v${revision}`;
	const restore = async () => {
		setRestoring(true);
		setRecoveryError(null);
		try {
			const result = await onReplace();
			if (result.ok) setConfirming(false);
			else setRecoveryError(result.message);
		} catch {
			setRecoveryError(
				`${version} did not load. Your changes are still here. Reconnect and try again.`,
			);
		} finally {
			setRestoring(false);
		}
	};
	const download = () => {
		const url = URL.createObjectURL(
			new Blob([draftText], { type: "application/json" }),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "my-changes.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	const title = invalidDraft
		? "This draft can't be opened"
		: keptChanges
			? `You're keeping your changes`
			: `A newer version (${version}) was saved while you were editing`;
	const body = invalidDraft
		? `${version} is saved and unchanged. Load it to keep working.`
		: keptChanges
			? `Save version will save your changes as v${revision + 1}, replacing what changed in ${version}.`
			: `Load ${version} to continue from it, or keep your changes and save them as v${revision + 1}.`;
	return (
		<Alert
			variant="warning"
			data-canonical-recovery
			tabIndex={-1}
			className="outline-none"
		>
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription className="grid gap-3">
				<p>{body}</p>
				{recoveryError && <p role="alert">{recoveryError}</p>}
				{confirming ? (
					<div className="grid gap-2">
						<p>
							{`Load ${version}? Your unsaved changes are discarded for everyone editing this document.`}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="destructive"
								disabled={disabled || restoring}
								onClick={restore}
							>
								{restoring
									? `Loading ${version}…`
									: `Discard my changes and load ${version}`}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={restoring}
								onClick={() => setConfirming(false)}
							>
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							variant={keptChanges ? "outline" : "default"}
							disabled={disabled}
							onClick={() => setConfirming(true)}
						>
							{keptChanges ? `Load ${version} instead` : `Load ${version}`}
						</Button>
						{!invalidDraft && !keptChanges && onKeepChanges && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => onKeepChanges(true)}
							>
								Keep my changes
							</Button>
						)}
					</div>
				)}
				<div>
					<Button size="sm" variant="ghost" onClick={download}>
						Download a copy of my changes
					</Button>
				</div>
			</AlertDescription>
		</Alert>
	);
}
