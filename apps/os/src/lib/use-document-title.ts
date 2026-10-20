import { useEffect } from "react";

const TITLE_SUFFIX = " · Tedix OS";
const TRAILING_PRODUCT_SUFFIX = / · Tedix(?: OS)?$/;

/**
 * Set the tab title for one screen; restores the previous title on unmount.
 * Every tab title ends with " · Tedix OS" exactly once: a trailing " · Tedix"
 * or " · Tedix OS" in the argument is normalised first, and an empty argument
 * yields "Tedix OS". Callers pass only the page name.
 */
export function useDocumentTitle(title: string) {
	useEffect(() => {
		const previous = document.title;
		const page = title.replace(TRAILING_PRODUCT_SUFFIX, "");
		document.title = page ? `${page}${TITLE_SUFFIX}` : "Tedix OS";
		return () => {
			document.title = previous;
		};
	}, [title]);
}
