import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import type {
	AppRuntimeError,
	AppRuntimeErrorLog,
} from "@/lib/app-runtime-protocol";

const KIND_LABEL: Record<AppRuntimeError["kind"], string> = {
	error: "Error",
	rejection: "Unhandled promise rejection",
	console: "console.error",
};

function countLabel(total: number): string {
	return total === 1 ? "1 error" : `${total} errors`;
}

/**
 * The message the person gets in the chat's message box: what the app
 * reported, as a quoted block the agent reads as data. The person can change
 * it before sending.
 */
export function appErrorsMessage(
	appName: string,
	log: AppRuntimeErrorLog,
): string {
	const name = appName.replace(/["\n\r]/g, " ").trim() || "This app";
	const lines = log.recent.map((error, index) => {
		const where = error.line ? ` (client.js line ${error.line})` : "";
		// The app wrote these words; they must not end the quoted block.
		const message = error.message.replace(/```/g, "'''");
		return `${index + 1}. ${KIND_LABEL[error.kind]}${where}: ${message}`;
	});
	const shown =
		log.total > log.recent.length
			? ` These are the last ${log.recent.length}.`
			: "";
	return [
		`The app "${name}" reported ${countLabel(log.total)} while it was running.${shown} Please find the cause and fix it.`,
		"```",
		...lines,
		"```",
	].join("\n");
}

/**
 * A small bar above a running app that reported errors. "Send to the agent"
 * puts them into the chat's message box; it is offered only where a chat is
 * there to take them.
 */
export function AppRuntimeErrorBar({
	log,
	onSend,
	onDismiss,
}: {
	log: AppRuntimeErrorLog;
	onSend?: () => void;
	onDismiss: () => void;
}) {
	if (log.total === 0) return null;
	return (
		<div
			className="flex flex-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2"
			data-app-runtime-errors
			role="status"
			style={{
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-lg)",
				background: "var(--background-lighter)",
			}}
		>
			<Text as="span" role="label">
				This app reported {countLabel(log.total)}.
			</Text>
			<span className="flex flex-wrap items-center gap-2">
				{onSend ? (
					<Button size="sm" variant="secondary" onClick={onSend}>
						Send to the agent
					</Button>
				) : null}
				<Button
					aria-label="Dismiss the app's errors"
					size="sm"
					variant="ghost"
					onClick={onDismiss}
				>
					Dismiss
				</Button>
			</span>
		</div>
	);
}
