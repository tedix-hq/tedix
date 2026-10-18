let locale = "en-US";
const listeners = new Set<() => void>();

export function readOsLocale() {
	return locale;
}

export function setOsLocale(value: string) {
	if (locale === value) return;
	locale = value;
	listeners.forEach((listener) => listener());
}

export function subscribeOsLocale(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
