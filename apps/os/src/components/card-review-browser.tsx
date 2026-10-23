import { useState } from "react";
import { isOpen, type ReviewCard } from "@tedix/api-contract/utils/card-review";
import { Button } from "./kumo/button";

/** Only receives already authorized cards and local navigation; no write callbacks. */
export function CardReviewBrowser({
	cards,
	onBack,
}: {
	cards: readonly ReviewCard[];
	onBack: () => void;
}) {
	const [selected, setSelected] = useState<string | null>(null);
	const card = cards.find((item) => item.key === selected);
	return (
		<section
			aria-label="Inspect all cards"
			className="flex min-w-0 flex-col gap-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3>{card ? `Card #${card.number}` : "All cards · read only"}</h3>
				<Button
					size="sm"
					variant="ghost"
					onClick={card ? () => setSelected(null) : onBack}
				>
					{card ? "Back to all cards" : "Back to waiting"}
				</Button>
			</div>
			{card ? (
				<dl className="grid min-w-0 gap-2 whitespace-pre-wrap break-words">
					{Object.entries({
						Status: isOpen(card) ? "Open" : "Decided",
						Source: card.sourceText,
						Who: card.who,
						Why: card.why,
						Draft: card.draft,
						Useful: card.useful,
						Reason: card.reason,
						Done: card.done,
						Result: card.result,
					}).map(([label, value]) => (
						<div key={label}>
							<dt className="font-medium">{label}</dt>
							<dd>{value || "—"}</dd>
						</div>
					))}
				</dl>
			) : (
				cards.map((item) => (
					<button
						key={item.key}
						type="button"
						onClick={() => setSelected(item.key)}
						className="min-w-0 rounded-2xl border border-kumo-line p-4 text-left break-words"
					>
						#{item.number} · {isOpen(item) ? "Open" : "Decided"} ·{" "}
						{item.sourceLabel} · {item.sheetTitle}
						<div>{item.action || item.why || item.sourceText}</div>
					</button>
				))
			)}
		</section>
	);
}
