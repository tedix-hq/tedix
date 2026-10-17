import { Text } from "@/components/kumo/text";
import { errorMessage } from "@/lib/orpc-error";

export function OfficeReadError({
	resource,
	error,
}: {
	resource: string;
	error: unknown;
}) {
	return (
		<div role="alert">
			<Text as="p" role="body" tone="error">
				Couldn't load {resource} —{" "}
				{errorMessage(error, "The service is unavailable. Try again shortly.")}
			</Text>
		</div>
	);
}
