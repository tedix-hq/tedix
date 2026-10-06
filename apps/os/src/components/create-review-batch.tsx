import { useEffect, useState } from "react";
import {
	OsReviewCardSchema,
	type OsReviewCard,
} from "@tedix/api-contract/contracts/os-shares";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Textarea } from "@/components/kumo/textarea";
const blank = (): OsReviewCard => ({
	id: crypto.randomUUID(),
	title: "",
	url: "",
	relevance: "",
	draft: "",
	effort: "medium",
	checks: [],
	evidence: [],
});
/** Human owner approval is enforced by the API; no implicit sharing of workbook rows. */
export function CreateReviewBatch({
	shareId,
	gadgetId,
}: {
	shareId: string;
	gadgetId: string;
}) {
	const [sources, setSources] = useState<Array<{ id: string; title: string }>>(
		[],
	);
	const [sourceId, setSourceId] = useState("");
	const [title, setTitle] = useState("Review batch");
	const [cards, setCards] = useState<OsReviewCard[]>([blank()]);
	const [rawChecks, setRawChecks] = useState<Record<string, string>>({});
	const [rawEvidence, setRawEvidence] = useState<Record<string, string>>({});
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	useEffect(() => {
		let alive = true;
		import("@/lib/api")
			.then(async ({ osApi }) => {
				const workspaceId = window.location.pathname.match(
					/\/workspace\/([0-9a-f-]{36})/i,
				)?.[1];
				if (!workspaceId)
					throw new Error(
						"Open the gadget in its workspace to prepare a review.",
					);
				const detail = await osApi.osWorkspaces.gadgets.get({
					workspaceId,
					gadgetId,
				});
				return osApi.osWorkspaces.outputs.list({
					workspaceId: detail.gadget.workspaceId,
					status: "active",
					limit: 100,
				});
			})
			.then(
				(result) => {
					if (alive) setSources(result.items);
				},
				() => {
					if (alive)
						setStatus("Could not load source documents. Check your access.");
				},
			);
		return () => {
			alive = false;
		};
	}, [gadgetId]);
	function change(index: number, patch: Partial<OsReviewCard>) {
		setCards((current) =>
			current.map((card, i) => (i === index ? { ...card, ...patch } : card)),
		);
	}
	async function approve() {
		setBusy(true);
		setStatus("");
		try {
			const parsed = cards.map((card) =>
				OsReviewCardSchema.parse({
					...card,
					checks: (rawChecks[card.id] ?? "")
						.split("\n")
						.map((value) => value.trim())
						.filter(Boolean),
					evidence: (rawEvidence[card.id] ?? "")
						.split("\n")
						.filter((value) => value.trim())
						.map((line) => {
							const [label, ...parts] = line.split("|");
							return {
								label: (label ?? "").trim(),
								url: parts.join("|").trim(),
							};
						}),
				}),
			);
			const { osApi } = await import("@/lib/api");
			const source = await osApi.osWorkspaces.outputs.get({
				outputId: sourceId,
			});
			await osApi.osShares.reviews.create({
				shareId,
				sourceOutputId: sourceId,
				sourceRevisionId: source.currentRevision.id,
				title,
				cards: parsed,
			});
			setDone(true);
			setStatus(
				"Review batch saved. This link now opens these cards. Later research changes do not change this batch.",
			);
		} catch (error) {
			setStatus(
				error instanceof Error
					? error.message
					: "Could not create review batch.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<details className="grid gap-3">
			<summary className="cursor-pointer font-medium">
				Prepare a feedback review
			</summary>
			<p className="text-sm text-kumo-subtle">
				The organization owner chooses exactly what is shared. Feedback stays
				separate from your research. Recipients must already have access to this
				organization.
			</p>
			{!done && (
				<div className="grid gap-3">
					<label>
						Source document
						<select
							aria-label="Review source"
							className="block w-full"
							value={sourceId}
							onChange={(e) => setSourceId(e.target.value)}
						>
							<option value="">Choose a source</option>
							{sources.map((source) => (
								<option key={source.id} value={source.id}>
									{source.title}
								</option>
							))}
						</select>
					</label>
					<label>
						Batch title
						<Input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={240}
						/>
					</label>
					{cards.map((card, index) => (
						<fieldset
							key={card.id}
							className="grid gap-2 rounded border border-kumo-line p-3"
						>
							<legend>Card {index + 1}</legend>
							<Input
								aria-label={`Card ${index + 1} title`}
								placeholder="Title"
								value={card.title}
								onChange={(e) => change(index, { title: e.target.value })}
							/>
							<Input
								aria-label={`Card ${index + 1} evidence link`}
								placeholder="HTTPS evidence link"
								value={card.url}
								onChange={(e) => change(index, { url: e.target.value })}
							/>
							<Textarea
								aria-label={`Card ${index + 1} relevance`}
								placeholder="Why it matters"
								value={card.relevance}
								onChange={(e) => change(index, { relevance: e.target.value })}
							/>
							<Textarea
								aria-label={`Card ${index + 1} draft`}
								placeholder="Proposed reply"
								value={card.draft}
								onChange={(e) => change(index, { draft: e.target.value })}
							/>
							<label>
								Effort
								<select
									value={card.effort}
									onChange={(e) =>
										change(index, {
											effort: e.target.value as OsReviewCard["effort"],
										})
									}
								>
									<option value="low">Low</option>
									<option value="medium">Medium</option>
									<option value="high">High</option>
								</select>
							</label>
							<Textarea
								aria-label={`Card ${index + 1} checks`}
								placeholder="Remaining checks, one per line"
								value={rawChecks[card.id] ?? ""}
								onChange={(e) =>
									setRawChecks((current) => ({
										...current,
										[card.id]: e.target.value,
									}))
								}
							/>
							<Textarea
								aria-label={`Card ${index + 1} sources`}
								placeholder="Evidence sources: label | HTTPS link, one per line"
								value={rawEvidence[card.id] ?? ""}
								onChange={(e) =>
									setRawEvidence((current) => ({
										...current,
										[card.id]: e.target.value,
									}))
								}
							/>
							{cards.length > 1 && (
								<Button
									variant="ghost"
									onClick={() =>
										setCards((current) => current.filter((_, i) => i !== index))
									}
								>
									Remove card
								</Button>
							)}
						</fieldset>
					))}
					<Button
						variant="secondary"
						disabled={cards.length >= 50}
						onClick={() => setCards((current) => [...current, blank()])}
					>
						Add card
					</Button>
					<Button
						disabled={busy || !sourceId || !title.trim()}
						onClick={() => void approve()}
					>
						{busy ? "Saving…" : "Approve and save review batch"}
					</Button>
				</div>
			)}
			<p role="status" className="text-sm text-kumo-subtle">
				{status}
			</p>
		</details>
	);
}
