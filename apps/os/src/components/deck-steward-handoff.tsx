import { useState } from "react";
import { osApi } from "@/lib/api";
import { Button } from "./kumo/button";

/**
 * Hands an open question to the organization's designated steward tedi with
 * the card's priority reason. The tedi decides in its own name; nothing is
 * answered for the person.
 */
export function DeckStewardHandoff({
	request,
	reason,
	onRouted,
}: {
	request: { id: string; version: number };
	reason: string;
	onRouted: () => Promise<unknown>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	async function route() {
		if (pending) return;
		setPending(true);
		setError("");
		try {
			await osApi.workInteractions.delegateToSteward({
				requestId: request.id,
				expectedRequestVersion: request.version,
				reason,
			});
			await onRouted();
		} catch (failure) {
			setError(
				failure instanceof Error && /steward|only you/i.test(failure.message)
					? failure.message
					: "Could not hand this to the CTO tedi. Refresh and try again.",
			);
		} finally {
			setPending(false);
		}
	}
	return (
		<>
			<Button
				variant="outline"
				disabled={pending}
				data-deck-steward
				onClick={() => void route()}
			>
				Let the CTO tedi decide
			</Button>
			{error && <p role="alert">{error}</p>}
		</>
	);
}
