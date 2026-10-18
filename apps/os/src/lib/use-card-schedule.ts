import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { userPreferencesQueryOptions } from "@/lib/os-query-options";

/** Re-evaluate open queues across midnight, including tabs kept open overnight. */
export function useCardSchedule() {
	const preferences = useQuery(userPreferencesQueryOptions());
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(timer);
	}, []);
	return { now, timeZone: preferences.data?.preferences.timezone ?? undefined };
}
