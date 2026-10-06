/** Accept GA4 web-stream IDs, excluding the example placeholder. */
export function getGaMeasurementId(
	value: string | undefined,
): string | undefined {
	if (!value || !/^G-[A-Z0-9]{10}$/.test(value) || /^G-X{10}$/.test(value)) {
		return undefined;
	}
	return value;
}
