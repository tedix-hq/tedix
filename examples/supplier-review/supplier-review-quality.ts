export type Source = { name: string; text: string };

export function supplierFacts(sources: Source[], today: string) {
	const quote =
		sources.find((source) => source.name === "quote-2026-q3.md")?.text ?? "";
	const delivery =
		sources.find((source) => source.name === "delivery-log.md")?.text ?? "";
	const prices = quote.match(/Unit price: ([\d.]+) EUR \(was ([\d.]+) EUR/);
	const quantity = quote.match(/Part: .*?, ([\d,]+) units/);
	const expiry = quote.match(/Price valid until (\d{1,2} [A-Za-z]+ \d{4})/);
	const deliveries = [
		...delivery.matchAll(/promised ([^,]+), delivered ([^,.]+)/g),
	];
	if (!prices || !quantity || !expiry || !deliveries.length)
		throw new Error(
			"Cannot check this folder: expected quote prices, quantity, dated expiry and delivery log. Update the example's fact check when replacing its fixtures.",
		);
	const oldPrice = Number(prices[2]);
	const difference = Number(prices[1]) - oldPrice;
	const expiryTime = Date.parse(`${expiry[1]} 23:59:59 GMT`);
	const todayTime = Date.parse(`${today}T00:00:00Z`);
	if (!oldPrice || !Number.isFinite(expiryTime) || !Number.isFinite(todayTime))
		throw new Error("Invalid date or price in supplier fact check");
	return {
		unitPrice: Number(prices[1]),
		previousUnitPrice: oldPrice,
		quantity: Number(quantity[1]!.replaceAll(",", "")),
		deliveryDates: deliveries.map((row) => ({
			promised: row[1]!,
			delivered: row[2]!,
			onTime: row[1] === row[2],
		})),
		priceIncreasePercent: Math.round((difference / oldPrice) * 1000) / 10,
		additionalCost: Math.round(
			difference * Number(quantity[1]!.replaceAll(",", "")),
		),
		onTime: deliveries.filter((row) => row[1] === row[2]).length,
		deliveries: deliveries.length,
		expiryDate: new Date(expiryTime).toISOString().slice(0, 10),
		expired: todayTime > expiryTime,
	};
}

export function supplierCalculationGrounding(
	facts: ReturnType<typeof supplierFacts>,
	today: string,
): string {
	return [
		"Deterministic calculations from the files (use these facts, not an approximate delivery rate):",
		`quote-2026-q3.md: (${facts.unitPrice.toFixed(2)} - ${facts.previousUnitPrice.toFixed(2)}) / ${facts.previousUnitPrice.toFixed(2)} × 100 = ${facts.priceIncreasePercent.toFixed(1)}% (rounded to one decimal). Additional cost: (${facts.unitPrice.toFixed(2)} - ${facts.previousUnitPrice.toFixed(2)}) × ${facts.quantity} = ${facts.additionalCost} EUR.`,
		...facts.deliveryDates.map(
			(row) =>
				`delivery-log.md: promised ${row.promised}; delivered ${row.delivered}; ${row.onTime ? "on time" : "late"}.`,
		),
		`delivery-log.md: ${facts.onTime}/${facts.deliveries} on time (${(facts.onTime / facts.deliveries) * 100}%). A one-day delay is still late.`,
		`quote-2026-q3.md: expiry ${facts.expiryDate}; as of ${today} UTC, quote expired: ${facts.expired ? "yes" : "no"}.`,
	].join("\n");
}

export function checkedSupplierReply(
	reply: string,
	issues: string[],
	today: string,
): string {
	const report = [
		"## Calculation check",
		issues.length
			? "Needs review: the model's calculation summary has incorrect or missing facts."
			: "The four calculation-summary checks matched the source files.",
		...issues.map((issue) => `- ${issue}`),
		`Checked as of ${today}. This checks the calculation summary only, not every claim or recommendation. The model's original answer is preserved ${issues.length ? "below" : "above"}; review the note and draft before using either.`,
	].join("\n\n");
	return issues.length
		? `${report}\n\n---\n\n${reply}`
		: `${reply}\n\n---\n\n${report}`;
}

/** Checks only the requested calculation summary, not the whole model answer. */
export function checkSupplierReply(
	reply: string,
	facts: ReturnType<typeof supplierFacts>,
): string[] {
	const plain = reply.replace(/\*\*|__/g, "");
	const increase = plain.match(/^\s*[-*]?\s*Price increase:\s*([\d.]+)\s*%/im);
	const cost = plain.match(
		/^\s*[-*]?\s*Additional cost:[ \t]*(?:EUR[ \t]*)?([\d,]+(?:\.\d+)?)[ \t]*(?:EUR)?[ \t]*$/im,
	);
	const deliveries = plain.match(
		/^\s*[-*]?\s*On-time deliveries:\s*(\d+)\s*(?:\/|of)\s*(\d+)/im,
	);
	const expired = plain.match(/^\s*[-*]?\s*Quote expired:\s*(yes|no)\b/im);
	return [
		!increase || Number(increase[1]) !== facts.priceIncreasePercent
			? `Price increase must be ${facts.priceIncreasePercent.toFixed(1)}% in the calculation summary.`
			: null,
		!cost || Number(cost[1]!.replaceAll(",", "")) !== facts.additionalCost
			? `Additional cost must be ${facts.additionalCost} EUR in the calculation summary.`
			: null,
		!deliveries ||
		Number(deliveries[1]) !== facts.onTime ||
		Number(deliveries[2]) !== facts.deliveries
			? `On-time deliveries must be ${facts.onTime}/${facts.deliveries} in the calculation summary.`
			: null,
		!expired || (expired[1]!.toLowerCase() === "yes") !== facts.expired
			? `Quote expired must be ${facts.expired ? "yes" : "no"} (expiry ${facts.expiryDate}).`
			: null,
	].filter((issue): issue is string => issue !== null);
}
