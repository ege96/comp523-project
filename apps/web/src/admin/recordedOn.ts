export type DateParts = { year: string; month: string; day: string };

export const NO_DATE: DateParts = { year: "", month: "", day: "" };

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2019-05" -> { year: "2019", month: "5", day: "" }. */
export function partsFromText(text: string): DateParts {
  const [year = "", month = "", day = ""] = text ? text.split("-") : [];
  return { year, month: month && String(Number(month)), day: day && String(Number(day)) };
}

// Serialize the known date parts. An empty string represents an unset form field.
export function partsToText({ year, month, day }: DateParts): string {
  const y = year.trim();
  if (!y) return "";
  if (!month) return y;
  const m = `${y}-${month.padStart(2, "0")}`;
  return day ? `${m}-${day.padStart(2, "0")}` : m;
}

export function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function datePartsError({ year, month, day }: DateParts): string | undefined {
  const y = year.trim();
  if (!y) return month || day ? "Add the year too, or leave the month empty" : undefined;
  if (!/^\d{4}$/.test(y)) return "Write the year with four digits, like 1998";
  if (Number(y) > new Date().getFullYear()) return "That year hasn't happened yet";
  if (day && Number(day) > daysIn(Number(y), Number(month)))
    return `${MONTHS[Number(month) - 1] ?? "That month"} ${y} has no day ${day}`;
  return undefined;
}
