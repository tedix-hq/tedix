/** Matches Work navigation, including the legacy board flag. */
export function osGadgetHasWorkNavigation(manifest: string): boolean {
	const navigation = JSON.parse(manifest)?.navigation;
	return (
		navigation?.work === "deck" ||
		navigation?.work === "feed" ||
		navigation?.board === true ||
		navigation?.board === 1
	);
}
