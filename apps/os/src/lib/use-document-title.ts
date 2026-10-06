import { useEffect } from "react";

/** Set the tab title for one screen; restores the previous title on unmount. */
export function useDocumentTitle(title: string) {
	useEffect(() => {
		const previous = document.title;
		document.title = title;
		return () => {
			document.title = previous;
		};
	}, [title]);
}
