import { useEffect, useState } from "react";
import * as z from "zod";

const BatchSchema = z.object({
	key: z.string(),
	ids: z.array(z.string()).max(100),
	dismissed: z.array(z.string()).max(100),
});
type Batch = z.infer<typeof BatchSchema>;

/** Storage remembers the visit's finite list, never permission to perform an action. */
export function useDeckBatch(
	key: string,
	candidates: string[],
	capacity: number,
	ready: boolean,
) {
	const [batch, setBatch] = useState<Batch | null>(null);
	const candidateKey = JSON.stringify(candidates);
	useEffect(() => {
		if (!ready) return;
		setBatch((current) => {
			if (current?.key === key) return current;
			try {
				const saved = BatchSchema.safeParse(
					JSON.parse(sessionStorage.getItem(`decision-deck:${key}`) ?? "null"),
				);
				if (saved.success && saved.data.key === key) return saved.data;
			} catch {}
			return {
				key,
				ids: (JSON.parse(candidateKey) as string[]).slice(0, capacity),
				dismissed: [],
			};
		});
	}, [key, candidateKey, capacity, ready]);
	useEffect(() => {
		if (batch?.key !== key) return;
		try {
			sessionStorage.setItem(`decision-deck:${key}`, JSON.stringify(batch));
		} catch {}
	}, [batch, key]);
	return {
		batch: batch?.key === key ? batch : null,
		dismiss: (id: string) =>
			setBatch((value) =>
				value?.key === key
					? { ...value, dismissed: [...new Set([...value.dismissed, id])] }
					: value,
			),
	};
}
