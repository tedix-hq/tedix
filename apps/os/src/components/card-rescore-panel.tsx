import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import { isOpen, type ReviewCard } from "@tedix/api-contract/utils/card-review";
import { Button } from "./kumo/button";
import { Checkbox } from "./kumo/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./kumo/select";
import { osApi } from "@/lib/api";
import { cardReplayParams } from "@/lib/card-replay";
import { osQuery } from "@/lib/os-query-options";
import { useCanManageTedis } from "@/lib/tedi-permissions";

export function CardRescorePanel({
	cards,
	sources,
	onBack,
}: {
	cards: readonly ReviewCard[];
	sources: readonly CardReviewSource[];
	onBack: () => void;
}) {
	const client = useQueryClient();
	const canRun = useCanManageTedis();
	const available = cards.filter((card) => sources[card.sourceIndex]?.replay);
	const sheets = [
		...new Map(available.map((card) => [card.outputId, card.sheetTitle])),
	];
	const [sheetId, setSheetId] = useState(sheets[0]?.[0] ?? "");
	const [selected, setSelected] = useState<string[]>([]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [runId, setRunId] = useState<string | null>(null);
	const inFlight = useRef(false);
	const requestKey = useRef<string | null>(null);
	const rows = available.filter((card) => card.outputId === sheetId);
	const picked = rows.filter((card) => selected.includes(card.key));
	const replay = sources[rows[0]?.sourceIndex ?? -1]?.replay;
	const changeSelection = (keys: string[]) => {
		setSelected(keys);
		requestKey.current = null;
		setError(null);
	};
	const run = async () => {
		if (!canRun || !replay || picked.length === 0 || inFlight.current) return;
		inFlight.current = true;
		setPending(true);
		setError(null);
		try {
			const detail = await osApi.osWorkspaces.outputs.get({
				outputId: sheetId,
			});
			const body = detail.currentRevision.content;
			if (body.kind !== "sheet")
				throw new Error("This output is no longer a sheet.");
			const params = cardReplayParams(replay, picked, body);
			requestKey.current ??= crypto.randomUUID();
			const result = await osApi.skills.runWorkflow({
				skillId: replay.skillId,
				tediId: replay.tediId,
				params,
				idempotencyKey: requestKey.current,
				confirmDestructive: true,
				reason: "Re-score selected cards from the Card Review app",
			});
			setRunId(result.runId);
			changeSelection([]);
			void client.invalidateQueries({ queryKey: osQuery.skills.key() });
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not start re-scoring.",
			);
		} finally {
			inFlight.current = false;
			setPending(false);
		}
	};
	return (
		<section aria-label="Re-score cards" className="grid min-w-0 gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3>Re-score cards</h3>
				<Button variant="ghost" disabled={pending} onClick={onBack}>
					Back to all cards
				</Button>
			</div>
			<p>
				Choose cards to run through the current scorecard again, including cards
				already decided.
			</p>
			<Select
				value={sheetId}
				disabled={pending}
				onValueChange={(value) => {
					setSheetId(value ?? "");
					changeSelection([]);
				}}
				items={Object.fromEntries(sheets)}
			>
				<SelectTrigger aria-label="Card sheet">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{sheets.map(([id, title]) => (
						<SelectItem key={id} value={id}>
							{title}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Checkbox
				label="Select all cards in this sheet"
				checked={rows.length > 0 && picked.length === rows.length}
				disabled={pending || !canRun}
				onCheckedChange={(checked) =>
					changeSelection(checked ? rows.map((card) => card.key) : [])
				}
			/>
			{rows.map((card) => (
				<Checkbox
					key={card.key}
					label={`#${card.number} · ${isOpen(card) ? "Open" : "Decided"} · ${card.action || card.sourceText}`}
					checked={selected.includes(card.key)}
					disabled={pending || !canRun}
					onCheckedChange={(checked) =>
						changeSelection(
							checked
								? [...selected, card.key]
								: selected.filter((key) => key !== card.key),
						)
					}
				/>
			))}
			{!canRun && (
				<p>You need permission to run workflows to re-score cards.</p>
			)}
			<Button
				disabled={
					pending || !canRun || picked.length === 0 || picked.length > 200
				}
				onClick={() => void run()}
			>
				{pending ? "Starting re-score…" : "Re-score these cards"}
			</Button>
			<p role="status">
				{picked.length} selected
				{picked.length > 200 ? " · select at most 200 cards per run" : ""}
			</p>
			{error && <p role="alert">{error}</p>}
			{runId && (
				<p role="status">
					Re-scoring started.{" "}
					<a
						className="text-kumo-link"
						href={`/work/runs/${encodeURIComponent(runId)}`}
					>
						View run
					</a>{" "}
					to check progress and results.
				</p>
			)}
		</section>
	);
}
