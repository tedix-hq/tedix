function editDistance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 0; i < a.length; i++) {
		const next = [i + 1];
		for (let j = 0; j < b.length; j++) {
			next.push(
				Math.min(
					next[j]! + 1,
					row[j + 1]! + 1,
					row[j]! + (a[i] === b[j] ? 0 : 1),
				),
			);
		}
		row = next;
	}
	return row[b.length]!;
}

export function unknownOptionError(
	command: string,
	flag: string,
	candidates: Iterable<string>,
): Error {
	const nearest = [...candidates]
		.map((candidate) => ({
			flag: candidate,
			distance: editDistance(flag, candidate),
		}))
		.sort((a, b) => a.distance - b.distance)[0];
	const hint =
		nearest && nearest.distance <= 3 ? `; did you mean ${nearest.flag}?` : ";";
	return new Error(
		`Unknown option ${flag} for "tedix ${command}"${hint} See tedix ${command} --help`,
	);
}
