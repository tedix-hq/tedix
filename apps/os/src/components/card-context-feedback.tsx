import { useState } from "react";
import policy from "@tedix/api-contract/assets/card-context.v1.json";
import type { ContextChip } from "@tedix/api-contract/utils/card-context";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { osApi } from "@/lib/api";

export function CardContextFeedback({ cardId }: { cardId: string }) {
	const [answer, setAnswer] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [failed, setFailed] = useState(false);
	const save = async (enough: boolean, chip?: ContextChip) => {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		try {
			await osApi.learningFeedback.cardContext({
				cardId,
				clientEventId: crypto.randomUUID(),
				enough,
				chip,
			});
			setAnswer(enough);
			if (enough || chip) setDone(true);
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="flex flex-wrap items-center gap-2 text-kumo-secondary"
			aria-label={policy.question}
		>
			{done ? (
				<>
					<span>Noted. Repeated feedback shapes this kind of card.</span>
					<Link href="/brain">Your learned rules</Link>
				</>
			) : (
				<>
					<span>{policy.question}</span>
					<Button
						variant="ghost"
						size="sm"
						aria-label="Enough context"
						disabled={busy}
						onClick={() => void save(true)}
					>
						👍
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label="Not enough context"
						disabled={busy}
						onClick={() => void save(false)}
					>
						👎
					</Button>
					{answer === false &&
						Object.entries(policy.chips).map(([chip, value]) => (
							<Button
								key={chip}
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => void save(false, chip as ContextChip)}
							>
								{value.label}
							</Button>
						))}
				</>
			)}
			{failed && <span role="status">Could not save. Try again.</span>}
		</div>
	);
}
