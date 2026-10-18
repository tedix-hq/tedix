import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { Text } from "@/components/kumo/text";

export function DecisionClassCalibration({ classId }: { classId: string }) {
	const calibration = useQuery({
		...osQuery.learningFeedback.getCalibration.queryOptions({
			input: { classId },
		}),
		staleTime: 30000,
		refetchInterval: 60000,
	});
	if (!calibration.data) return null;
	return <Text>{calibration.data.statement}</Text>;
}
