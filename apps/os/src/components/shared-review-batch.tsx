import { useEffect, useState, type ReactNode } from "react";
import type {
	OsReviewBatch,
	OsReviewFeedback,
} from "@tedix/api-contract/contracts/os-shares";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Textarea } from "@/components/kumo/textarea";
import { Input } from "@/components/kumo/input";

export function SharedReviewBatch({
	shareId,
	sessionToken,
	fallback,
}: {
	shareId: string;
	sessionToken: string;
	fallback: ReactNode;
}) {
	const [data, setData] = useState<{
		batch: OsReviewBatch | null;
		feedback: OsReviewFeedback[];
	} | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		setData(null);
		setError("");
		let alive = true;
		import("@/lib/api")
			.then(({ osApi }) =>
				osApi.osShares.reviews.get({ shareId, sessionToken }),
			)
			.then(
				(value) => {
					if (alive) setData(value);
				},
				() => {
					if (alive)
						setError(
							"This review cannot be opened. Check your access or ask for a new link.",
						);
				},
			);
		return () => {
			alive = false;
		};
	}, [shareId, sessionToken]);
	if (error)
		return (
			<Alert variant="warning">
				<AlertTitle>Review unavailable</AlertTitle>
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		);
	if (!data) return <p role="status">Opening review…</p>;
	if (!data.batch) return fallback;
	return (
		<section className="grid gap-4">
			<header>
				<h2 className="m-0 text-xl font-semibold">{data.batch.title}</h2>
				<p className="text-kumo-subtle">
					A saved batch for your review. Your feedback is saved separately; it
					does not publish a reply or change the research.
				</p>
				<Badge variant="secondary">{data.batch.cards.length} cards</Badge>
				<p className="text-sm text-kumo-subtle">
					Batch saved {new Date(data.batch.createdAt).toLocaleString()}. This is
					when the batch was saved, not when its sources were last checked.
				</p>
			</header>
			{data.batch.cards.map((card) => (
				<ReviewCard
					key={`${data.batch!.id}:${card.id}`}
					card={card}
					initial={data.feedback.find((f) => f.cardId === card.id)}
					batch={data.batch!}
					shareId={shareId}
					sessionToken={sessionToken}
				/>
			))}
		</section>
	);
}
function ReviewCard({
	card,
	initial,
	batch,
	shareId,
	sessionToken,
}: {
	card: OsReviewBatch["cards"][number];
	initial: OsReviewFeedback | undefined;
	batch: OsReviewBatch;
	shareId: string;
	sessionToken: string;
}) {
	const [decision, setDecision] = useState<OsReviewFeedback["decision"]>(
		initial?.decision ?? "needs_checking",
	);
	const [reply, setReply] = useState(initial?.editedReply ?? card.draft);
	const [reason, setReason] = useState(initial?.reason ?? "");
	const [revision, setRevision] = useState(initial?.revision ?? 0);
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	async function save() {
		setBusy(true);
		setStatus("");
		try {
			const { osApi } = await import("@/lib/api");
			const result = await osApi.osShares.reviews.saveFeedback({
				shareId,
				sessionToken,
				batchId: batch.id,
				cardId: card.id,
				expectedRevision: revision,
				decision,
				editedReply: reply,
				reason,
			});
			setRevision(result.feedback.revision);
			setStatus("Feedback saved. Nothing was posted.");
		} catch {
			setStatus(
				"Could not save. Feedback may have changed or sharing ended. Copy your edits and reload before trying again.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle>{card.title}</CardTitle>
					<Badge
						variant={
							card.effort === "low"
								? "success"
								: card.effort === "medium"
									? "warning"
									: "destructive"
						}
					>
						{card.effort} effort
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="grid gap-4">
				<a
					className="text-kumo-brand underline"
					href={card.url}
					target="_blank"
					rel="noopener noreferrer"
				>
					Open original conversation ↗
				</a>
				<p className="m-0 whitespace-pre-wrap">{card.relevance}</p>
				{card.evidence.length > 0 && (
					<details>
						<summary>Evidence and sources</summary>
						<ul>
							{card.evidence.map((source, index) => (
								<li key={index}>
									<a
										className="text-kumo-brand underline"
										href={source.url}
										target="_blank"
										rel="noopener noreferrer"
									>
										{source.label} ↗
									</a>
								</li>
							))}
						</ul>
					</details>
				)}
				{card.checks.length > 0 && (
					<details>
						<summary>What still needs checking</summary>
						<ul>
							{card.checks.map((check, index) => (
								<li key={index}>{check}</li>
							))}
						</ul>
					</details>
				)}
				<details>
					<summary>Original draft</summary>
					<p className="whitespace-pre-wrap">{card.draft}</p>
				</details>
				<fieldset className="flex flex-wrap gap-2">
					<legend className="mb-2 font-medium">Your decision</legend>
					{(
						[
							["needs_checking", "Needs checking"],
							["edit", "Edit"],
							["skip", "Skip"],
							["ready", "Ready"],
						] as const
					).map(([value, label]) => (
						<Button
							key={value}
							variant={decision === value ? "default" : "secondary"}
							size="sm"
							aria-pressed={decision === value}
							disabled={busy}
							onClick={() => {
								setDecision(value);
								setStatus("Unsaved changes");
							}}
						>
							{label}
						</Button>
					))}
				</fieldset>
				<label className="grid gap-2">
					Reply to review
					<Textarea
						aria-label={`Reply for ${card.title}`}
						rows={5}
						value={reply}
						maxLength={8000}
						disabled={busy}
						onChange={(e) => {
							setReply(e.target.value);
							setStatus("Unsaved changes");
						}}
					/>
				</label>
				<label className="grid gap-2">
					Reason or feedback
					<Input
						aria-label={`Feedback for ${card.title}`}
						value={reason}
						maxLength={4000}
						disabled={busy}
						onChange={(e) => {
							setReason(e.target.value);
							setStatus("Unsaved changes");
						}}
					/>
				</label>
				<div className="flex flex-wrap items-center gap-3">
					<Button disabled={busy} onClick={() => void save()}>
						{busy ? "Saving…" : "Save feedback"}
					</Button>
					<span role="status" className="text-kumo-subtle text-sm">
						{status ||
							(initial
								? "Your previous feedback is loaded."
								: "Not reviewed yet.")}
					</span>
				</div>
			</CardContent>
		</Card>
	);
}
