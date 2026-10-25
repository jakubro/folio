/** Figures typed into prose and tied to data: a typed figure matches its data at the precision typed. */

import type { Embedded } from "../server/data.ts";

export interface Verdict {
  state: "matching" | "contradicted";
  /** The data's value, written as the figure is: same unit, decimals and separators. */
  live: string;
}

interface Figure {
  /** Whether a sign typed before the prefix, as in -$5, is written there again. */
  signFirst: boolean;
  number: number;
  decimals: number;
  percent: boolean;
  scale: number;
  grouped: boolean;
  prefix: string;
  suffix: string;
}

const FIGURE =
  /^([+-]?)([^\d.+-]*?)([+-]?)((?:\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?)\s*(%|[kKMB]|bn)?$/;
const ISO =
  /^(\d{4})-(\d{2})(?:-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?)?)?$/;
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const RANGE = /\d[^\d\s]{0,3}\s*(?:[-\u2013\u2014]|\bto\b)\s*[^\d\s]{0,3}\d/;
const DAY_MONTH = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/;
const MONTH_DAY = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const MONTH_YEAR = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/;
const MONTHS = [
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
const SCALES: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, bn: 1e9 };

/**
 * Compare a typed figure with the value its data holds: numbers within half a unit of the last digit
 * typed. Text that reads as no single figure, such as a range, cannot be checked against a number.
 */
export function verdict(typed: string, value: unknown): Verdict {
  const day = dateOf(typed.trim());
  const stored = typeof value === "string" ? dateOf(value.trim()) : undefined;

  if (day && stored) {
    const held = inZone(
      stored.day !== undefined && stored.hour === undefined
        ? { ...stored, hour: 0, minute: 0, second: 0 }
        : stored,
      day,
    );
    const parts = (["year", "month", "day", "hour", "minute", "second"] as const).filter(
      (part) => day[part] !== undefined,
    );
    const live = writtenDate(held, day);
    return {
      state: parts.every((part) => day[part] === held[part]) ? "matching" : "contradicted",
      live,
    };
  }

  const figure = figureOf(typed);
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;

  if (!figure && !day && Number.isFinite(number) && RANGE.test(typed)) {
    throw new Error(`${typed.trim()} is a range, not one figure to check.`);
  }

  if (!figure || !Number.isFinite(number)) {
    const live = String(value ?? "");
    return { state: live.trim() === typed.trim() ? "matching" : "contradicted", live };
  }

  // A percentage is typed over a fraction, unless the value is past 1 and so already in percent.
  const scaled = (figure.percent && Math.abs(number) <= 1 ? number * 100 : number) / figure.scale;
  const tolerance = 0.5 * 10 ** -figure.decimals + 1e-9 * Math.max(1, Math.abs(figure.number));

  return {
    state: Math.abs(scaled - figure.number) <= tolerance ? "matching" : "contradicted",
    live: written(scaled, figure),
  };
}

/** The one value an embed reads: a scalar, or the cell of a one-row, one-column result. */
export function singleValue(embedded: Embedded): string | number | boolean | null {
  const grid = embedded.grid;
  const value =
    grid && grid.rows.length === 1 && grid.columns.length === 1 ? grid.rows[0][0] : embedded.value;

  if (grid && value === embedded.value) {
    throw new Error("Not a single value: name a row and column, as in #0.total.");
  }

  if (value !== null && typeof value === "object") {
    throw new Error("Not a single value.");
  }

  return (value ?? null) as string | number | boolean | null;
}

function figureOf(typed: string): Figure | undefined {
  const match = FIGURE.exec(typed.trim().replace(/\u2212/g, "-"));

  if (!match || !/\d/.test(match[4])) {
    return undefined;
  }

  const [, lead, prefix, inner, digits, fraction = "", unit = ""] = match;
  const sign = lead || inner;

  if (lead && inner) {
    return undefined;
  }

  return {
    signFirst: lead !== "" && prefix !== "",
    number: Number(`${sign}${digits.replaceAll(",", "")}`),
    decimals: fraction.length,
    percent: unit === "%",
    scale: SCALES[unit] ?? 1,
    grouped: digits.includes(","),
    prefix,
    suffix: typed.trim().slice(typed.trim().length - unit.length),
  };
}

function written(number: number, figure: Figure): string {
  const fixed = Math.abs(number).toFixed(figure.decimals);
  const [whole, fraction] = fixed.split(".");
  const digits = figure.grouped ? whole.replace(/\B(?=(\d{3})+$)/g, ",") : whole;
  const sign = number < 0 && Number(fixed) !== 0 ? "-" : "";

  const lead = figure.signFirst ? `${sign}${figure.prefix}` : `${figure.prefix}${sign}`;
  return `${lead}${digits}${fraction === undefined ? "" : `.${fraction}`}${figure.suffix}`;
}

interface Day {
  year: number;
  month: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  style: "iso" | "day-month" | "month-day" | "month-year" | "slashed";
  /** How the month is named in a written date, and what joins date and time in an ISO one. */
  name?: "short" | "long";
  joint?: string;
  /** An ISO time's offset from UTC as typed, and in minutes. */
  zone?: string;
  offset?: number;
  /** Whether a slashed date names its month first, and pads day and month to two digits. */
  monthFirst?: boolean;
  padded?: boolean;
}

/** Read as written, never through the local time zone: the engine hands dates over as UTC. */
function dateOf(text: string): Day | undefined {
  const iso = ISO.exec(text);

  if (iso) {
    const [, year, month, day, joint, hour, minute, second, zone] = iso;
    return {
      year: Number(year),
      month: Number(month),
      ...(day && { day: Number(day) }),
      ...(hour && { hour: Number(hour), minute: Number(minute), joint }),
      ...(second && { second: Number(second) }),
      ...(zone && { zone, offset: offsetOf(zone) }),
      style: "iso",
    };
  }

  const slashed = SLASHED.exec(text);

  // Day first, as most of the world writes it, unless the second number can only be a day.
  if (slashed) {
    const [first, second] = [Number(slashed[1]), Number(slashed[2])];
    const monthFirst = second > 12;
    return {
      year: Number(slashed[3]),
      month: monthFirst ? first : second,
      day: monthFirst ? second : first,
      style: "slashed",
      monthFirst,
      padded: slashed[1].length === 2 && slashed[2].length === 2,
    };
  }

  const written = DAY_MONTH.exec(text) ?? MONTH_DAY.exec(text) ?? MONTH_YEAR.exec(text);
  const name = written?.slice(1).find((part) => /[A-Za-z]/.test(part)) ?? "";
  const month = MONTHS.findIndex((full) => full.toLowerCase().startsWith(name.toLowerCase()));

  if (!written || name.length < 3 || month < 0) {
    return undefined;
  }

  const numbers = written
    .slice(1)
    .filter((part) => /^\d+$/.test(part))
    .map(Number);
  const style = DAY_MONTH.test(text)
    ? "day-month"
    : MONTH_DAY.test(text)
      ? "month-day"
      : "month-year";
  return {
    year: numbers.at(-1) as number,
    month: month + 1,
    ...(numbers.length > 1 && { day: numbers[0] }),
    style,
    name: name.length > 3 ? "long" : "short",
  };
}

function writtenDate(value: Day, typed: Day): string {
  const two = (n: number | undefined) => String(n ?? 0).padStart(2, "0");
  const month = MONTHS[value.month - 1] ?? "";
  const named = typed.name === "long" ? month : month.slice(0, 3);

  if (typed.style === "slashed") {
    const [day, number] = typed.padded
      ? [two(value.day), two(value.month)]
      : [String(value.day ?? ""), String(value.month)];
    return typed.monthFirst ? `${number}/${day}/${value.year}` : `${day}/${number}/${value.year}`;
  }

  if (typed.style === "day-month") {
    return `${value.day ?? ""} ${named} ${value.year}`;
  }

  if (typed.style === "month-day") {
    return `${named} ${value.day ?? ""}, ${value.year}`;
  }

  if (typed.style === "month-year") {
    return `${named} ${value.year}`;
  }

  const date =
    typed.day === undefined
      ? `${value.year}-${two(value.month)}`
      : `${value.year}-${two(value.month)}-${two(value.day)}`;
  const time =
    typed.hour === undefined
      ? ""
      : `${typed.joint}${two(value.hour)}:${two(value.minute)}${typed.second === undefined ? "" : `:${two(value.second)}`}${typed.zone ?? ""}`;
  return `${date}${time}`;
}

/**
 * A time typed with an offset is compared in that offset: the data's time, read as UTC unless it
 * names its own offset, is moved there first. A time typed without one is compared as the data writes it.
 */
function inZone(held: Day, typed: Day): Day {
  if (typed.offset === undefined || held.hour === undefined || held.day === undefined) {
    return held;
  }

  const at = new Date(
    Date.UTC(held.year, held.month - 1, held.day, held.hour, held.minute ?? 0, held.second ?? 0) +
      (typed.offset - (held.offset ?? 0)) * 60_000,
  );
  return {
    ...held,
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    hour: at.getUTCHours(),
    minute: at.getUTCMinutes(),
    second: at.getUTCSeconds(),
  };
}

function offsetOf(zone: string): number {
  if (zone === "Z") {
    return 0;
  }

  const [, sign, hours, minutes = "0"] = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone) ?? [];
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
}
