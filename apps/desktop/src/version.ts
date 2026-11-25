/**
 * Comparing versions of the app and the command-line tool. The command-line
 * tool prints its version with the commit it was built from
 * ("0.37.14+912a3423c"); only the release before the "+" counts here.
 */
const release = (version: string) =>
	(/^\d+\.\d+\.\d+/.exec(version)?.[0] ?? "0.0.0").split(".").map(Number);

export function isNewer(candidate: string, current: string): boolean {
	const [a, b] = [release(candidate), release(current)];
	for (let part = 0; part < 3; part++)
		if (a[part] !== b[part]) return (a[part] ?? 0) > (b[part] ?? 0);
	return false;
}

/** Both are the same release, whichever commit each was built from. */
export const sameRelease = (a: string, b: string) =>
	!isNewer(a, b) && !isNewer(b, a);

/**
 * The command-line tool to move to: the newer of the copy inside the app and
 * the published one, when it is newer than the copy in use (`have`). The copy
 * inside the app wins a tie, because it needs no download.
 */
export function newerTool(
	have: string,
	inside: string,
	published: string,
): string | undefined {
	const best =
		inside && !(published && isNewer(published, inside)) ? inside : published;
	return have && best && isNewer(best, have) ? best : undefined;
}
