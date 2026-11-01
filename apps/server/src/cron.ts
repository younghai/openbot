/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week).
 * Supports wildcards, step values, ranges, range-with-step, and comma lists.
 * Day-of-month and day-of-week combine with OR when both are restricted
 * (Vixie cron semantics).
 */

interface FieldMatcher {
  min: number;
  max: number;
  allowed: Set<number>;
  wildcard: boolean;
}

export function parseCron(expr: string): FieldMatcher[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields (minute hour dom month dow), got ${fields.length}`);
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  return fields.map((raw, i) => parseField(raw, ranges[i][0], ranges[i][1], i));
}

function parseField(raw: string, min: number, max: number, index: number): FieldMatcher {
  const allowed = new Set<number>();
  let wildcard = false;
  for (const part of raw.split(",")) {
    if (part === "*") {
      wildcard = true;
      for (let v = min; v <= max; v++) allowed.add(v);
      continue;
    }
    const rangeStep = part.split("/");
    const step = rangeStep.length === 2 ? Number(rangeStep[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in cron field ${index + 1}: '${part}'`);
    let lo = min;
    let hi = max;
    if (rangeStep[0] !== "*" && rangeStep[0] !== "") {
      const bounds = rangeStep[0].split("-");
      lo = Number(bounds[0]);
      hi = bounds.length === 2 ? Number(bounds[1]) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`cron field ${index + 1} value out of range: '${part}' (${min}-${max})`);
      }
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  if (allowed.size === 0) throw new Error(`cron field ${index + 1} is empty`);
  return { min, max, allowed, wildcard };
}

export function cronMatches(expr: string, date: Date): boolean {
  const [minute, hour, dom, mon, dow] = parseCron(expr);
  if (!minute.allowed.has(date.getMinutes())) return false;
  if (!hour.allowed.has(date.getHours())) return false;
  if (!mon.allowed.has(date.getMonth() + 1)) return false;
  const domOk = dom.allowed.has(date.getDate());
  const dowOk = dow.allowed.has(date.getDay());
  const bothRestricted = !dom.wildcard && !dow.wildcard;
  if (bothRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** Human hint for common expressions (UI helper). */
export function describeCron(expr: string): string {
  try {
    cronMatches(expr, new Date());
  } catch (err) {
    throw err;
  }
  if (expr.trim() === "* * * * *") return "매분";
  const [m, h] = expr.trim().split(/\s+/);
  if (m.startsWith("*/") && h === "*") return `${m.slice(2)}분마다`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) return `매일 ${h}:${m.padStart(2, "0")}`;
  return expr.trim();
}
