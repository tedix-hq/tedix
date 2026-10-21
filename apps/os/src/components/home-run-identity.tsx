import { ClipboardText } from "@/components/kumo/clipboard-text";
import { Text } from "@/components/kumo/text";

export function HomeRunIdentity({ runId }: { runId: string }) {
	return (
		<div className="grid min-w-0 gap-1">
			<Text as="p" role="label" tone="secondary">
				Home run
			</Text>
			<ClipboardText
				size="sm"
				text={runId}
				textToCopy={runId}
				className="max-w-full"
			/>
		</div>
	);
}
