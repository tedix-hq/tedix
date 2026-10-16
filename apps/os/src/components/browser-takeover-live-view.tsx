import { useMutation } from "@tanstack/react-query";
import { BrowserTakeoverStatusSchema } from "@tedix/api-contract/schemas/tedi";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";

export function BrowserTakeoverLiveView({
	approvalId,
}: {
	approvalId: string;
}) {
	const open = useMutation({
		mutationFn: async (view: Window | null) => {
			try {
				if (!view) throw new Error("Allow pop-ups to open the live view.");
				const status = BrowserTakeoverStatusSchema.parse(
					await osApi.tediApprovals.getBrowserTakeoverStatus({
						id: approvalId,
					}),
				);
				const target = status.targets[0];
				if (!status.sameSession || !target)
					throw new Error(
						"This browser session is no longer available. Ask the tedi to request a new takeover.",
					);
				view.location.replace(target.url);
			} catch (error) {
				view?.close();
				throw error;
			}
		},
	});
	return (
		<div className="grid gap-2">
			<Button
				variant="outline"
				disabled={open.isPending}
				onClick={() => {
					const view = window.open("about:blank", "_blank");
					if (view) view.opener = null;
					open.mutate(view);
				}}
			>
				Open live view
			</Button>
			{open.isError ? (
				<Text role="body" tone="secondary">
					{errorMessage(open.error)}
				</Text>
			) : null}
		</div>
	);
}
