/** Birthday checks use the office clock in Yerevan, not the server's UTC clock. */

export type YerevanDate = { year: number; month: number; day: number };

export function yerevanDate(now = new Date()): YerevanDate {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Yerevan",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || "0");
    return { year: pick("year"), month: pick("month"), day: pick("day") };
}

export function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True when birthDate (YYYY-MM-DD) falls on this Yerevan day. Feb 29 is celebrated on Feb 28 in other years. */
export function isBirthdayOn(birthDate: string | null | undefined, today: YerevanDate): boolean {
    const raw = String(birthDate || "").trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return false;
    let month = Number(match[2]);
    let day = Number(match[3]);
    if (month === 2 && day === 29 && !isLeapYear(today.year)) {
        day = 28;
    }
    return today.month === month && today.day === day;
}

export function birthdayNoticeKey(personUserId: string, year: number): string {
    return `${personUserId}:${year}`;
}

export function parseBirthDate(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
    const text = String(raw ?? "").trim();
    if (!text) return { ok: true, value: null };
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return { ok: false, message: "Birthday must be a date" };
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const stamp = new Date(Date.UTC(year, month - 1, day));
    if (
        stamp.getUTCFullYear() !== year ||
        stamp.getUTCMonth() !== month - 1 ||
        stamp.getUTCDate() !== day
    ) {
        return { ok: false, message: "Birthday is not a real date" };
    }
    const thisYear = yerevanDate().year;
    if (year < 1940 || year > thisYear) {
        return { ok: false, message: "Birthday year looks wrong" };
    }
    return { ok: true, value: text };
}
