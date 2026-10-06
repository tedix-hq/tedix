import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";

export function LocalCapabilityNotice({
	capability,
}: {
	capability: "billing" | "catalog";
}) {
	return (
		<Alert>
			<AlertTitle>
				{capability === "billing"
					? "Billing is off locally"
					: "App browsing is off locally"}
			</AlertTitle>
			<AlertDescription>
				{capability === "billing"
					? "Subscriptions and managed usage are not available in this local session. Paid Home replies use your configured inference provider; they are not runs by your saved worker. Check your provider account for charges."
					: "The shared app catalog is not available in this local session. Your local workspaces and saved content still work."}
			</AlertDescription>
		</Alert>
	);
}
