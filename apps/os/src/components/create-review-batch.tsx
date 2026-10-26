import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { useEffect, useId, useState } from "react";
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
/**
 * The owner's form for one review round. Human owner approval is enforced by
 * the API; no implicit sharing of workbook rows. The share popover explains
 * the feature and holds this form behind its own disclosure.
 */
export function CreateReviewBatch({
	shareId,
	gadgetId,
}: {
	shareId: string;
	gadgetId: string;
}) {
	const sourceSelectId = useId();
	const [sources, setSources] = useState<Array<{ id: string; title: string }>>(
		[],
	);
	const [sourceId, setSourceId] = useState("");
	const [title, setTitle] = useState("Items to review");
	const [cards, setCards] = useState<OsReviewCard[]>(() => [blank()]);
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
					throw new Error("Open the app in its workspace to send a review.");
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
						setStatus("Could not load your documents. Check your access.");
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
				"Sent. People who open the link now see these items. Earlier answers are kept, and later edits to your document do not change what they see.",
			);
		} catch (error) {
			setStatus(
				error instanceof Error
					? error.message
					: "Could not send the items for review.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="grid gap-3">
			{!done && (
				<div className="grid gap-3">
					<label htmlFor={sourceSelectId} className="grid gap-1.5 text-sm">
						Items come from
						<Select
							value={sourceId || null}
							items={sources.map((source) => ({
								value: source.id,
								label: source.title,
							}))}
							onValueChange={(value) => setSourceId(value ?? "")}
						>
							<SelectTrigger id={sourceSelectId} className="w-full">
								<SelectValue placeholder="Choose a document" />
							</SelectTrigger>
							<SelectContent>
								{sources.map((source) => (
									<SelectItem key={source.id} value={source.id}>
										{source.title}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
					<label className="grid gap-1.5 text-sm">
						Name of this review
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
							<legend className="px-1 text-sm">Item {index + 1}</legend>
							<Input
								aria-label={`Item ${index + 1} title`}
								placeholder="What it is"
								value={card.title}
								onChange={(e) => change(index, { title: e.target.value })}
							/>
							<Input
								aria-label={`Item ${index + 1} link`}
								placeholder="Link to it (https://…)"
								value={card.url}
								onChange={(e) => change(index, { url: e.target.value })}
							/>
							<Textarea
								aria-label={`Item ${index + 1} why it matters`}
								placeholder="Why it matters"
								value={card.relevance}
								onChange={(e) => change(index, { relevance: e.target.value })}
							/>
							<Textarea
								aria-label={`Item ${index + 1} suggested reply`}
								placeholder="Suggested reply (optional)"
								value={card.draft}
								onChange={(e) => change(index, { draft: e.target.value })}
							/>
							<label className="grid gap-1.5 text-sm">
								How much work
								<Select
									value={card.effort}
									items={{ low: "Low", medium: "Medium", high: "High" }}
									onValueChange={(value) =>
										value &&
										change(index, { effort: value as OsReviewCard["effort"] })
									}
								>
									<SelectTrigger aria-label={`Item ${index + 1} how much work`}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="low">Low</SelectItem>
										<SelectItem value="medium">Medium</SelectItem>
										<SelectItem value="high">High</SelectItem>
									</SelectContent>
								</Select>
							</label>
							<Textarea
								aria-label={`Item ${index + 1} still to check`}
								placeholder="Still to check (optional, one per line)"
								value={rawChecks[card.id] ?? ""}
								onChange={(e) =>
									setRawChecks((current) => ({
										...current,
										[card.id]: e.target.value,
									}))
								}
							/>
							<Textarea
								aria-label={`Item ${index + 1} more sources`}
								placeholder="More sources (optional): name | https://…, one per line"
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
									Remove item
								</Button>
							)}
						</fieldset>
					))}
					<Button
						variant="secondary"
						disabled={cards.length >= 50}
						onClick={() => setCards((current) => [...current, blank()])}
					>
						Add another item
					</Button>
					<Button
						disabled={busy || !sourceId || !title.trim()}
						onClick={() => void approve()}
					>
						{busy ? "Sending…" : "Send for review"}
					</Button>
				</div>
			)}
			<p role="status" className="m-0 text-sm text-kumo-subtle empty:hidden">
				{status}
			</p>
		</div>
	);
}
