function padDatePart(value) {
	return String(value).padStart(2, "0");
}

export function formatLocalTimestampFromUnix(value) {
	const timestamp = Number(value);

	if (!Number.isInteger(timestamp) || timestamp <= 0) {
		throw new Error(`Invalid data update timestamp: ${value}`);
	}

	const date = new Date(timestamp * 1000);

	return [
		date.getFullYear(),
		padDatePart(date.getMonth() + 1),
		padDatePart(date.getDate()),
	].join("-")
		+ " "
		+ [
			padDatePart(date.getHours()),
			padDatePart(date.getMinutes()),
			padDatePart(date.getSeconds()),
		].join(":");
}
