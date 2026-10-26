import { useState } from "react";
import { osApi } from "@/lib/api";
import { Button } from "./kumo/button";
import { Input } from "./kumo/input";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "./kumo/popover";

export function tomorrowMorning(now = new Date()) {
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(9, 0, 0, 0);
	return tomorrow.toISOString();
}

export function CardSnooze({
	request,
	onSnoozed,
}: {
	request: { id: string; version: number };
	onSnoozed: () => Promise<unknown>;
}) {
	const [until, setUntil] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	async function snooze(at: string) {
		if (pending) return;
		setPending(true);
		setError("");
		try {
			await osApi.workInteractions.snooze({
				requestId: request.id,
				expectedVersion: request.version,
				until: at,
			});
			await onSnoozed();
		} catch {
			setError("Could not snooze this card. Refresh and try again.");
		} finally {
			setPending(false);
		}
	}
	return (
		<PopoverRoot>
			<PopoverTrigger render={<Button variant="outline" disabled={pending} />}>
				Snooze…
			</PopoverTrigger>
			<PopoverContent className="grid gap-3 p-3">
				<Button
					disabled={pending}
					onClick={() => void snooze(tomorrowMorning())}
				>
					Until tomorrow
				</Button>
				<Input
					type="datetime-local"
					aria-label="Snooze until"
					value={until}
					onChange={(event) => setUntil(event.target.value)}
				/>
				<Button
					disabled={pending || !until || Date.parse(until) <= Date.now()}
					onClick={() => void snooze(new Date(until).toISOString())}
				>
					Until chosen time
				</Button>
				{error && <p role="alert">{error}</p>}
			</PopoverContent>
		</PopoverRoot>
	);
}
