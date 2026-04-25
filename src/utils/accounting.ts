/**
 * Common accounting utility functions.
 * Shared across Mizan, TemporaryTax, VoucherList, and other modules.
 */

/** Round to 2 decimal places with epsilon correction */
export const round2 = (value: number): number =>
    Math.round((value + Number.EPSILON) * 100) / 100;

/** Normalize a voucher number for comparison (trim, collapse whitespace, uppercase) */
export const normalizeVoucherNo = (value: string | undefined): string =>
    String(value || '').trim().replace(/\s+/g, '').toLocaleUpperCase('tr-TR');

/** Parse a YYYY-MM-DD date input string. If endOfDay is true, set time to 23:59:59.999 */
export const parseDateInput = (value: string, endOfDay = false): Date | null => {
    if (!value) return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const parsed = new Date(
        year, month, day,
        endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0
    );
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
};

/** Create a valid calendar date or return null if the date components don't form a valid date */
export const toValidCalendarDate = (year: number, month: number, day: number): Date | null => {
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
};

/** Parse a transaction date from various formats (Date object, Excel serial, DD.MM.YYYY, ISO, etc.) */
export const parseTransactionDate = (value: Date | string | number | null | undefined): Date | null => {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
        // TIMEZONE FIX: If the Date came from XLSX cellDates:true it is UTC midnight.
        // Rebuild as local noon date using UTC components to avoid 1-day shift in UTC+ zones.
        if (Number.isNaN(value.getTime())) return null;
        return toValidCalendarDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    }

    if (typeof value === 'number') {
        // TIMEZONE FIX: Excel serials denote a calendar day, not a UTC instant.
        // Extract UTC components from the epoch-shifted date to avoid DST/timezone drift.
        const excelEpochUtc = Date.UTC(1899, 11, 30);
        const utcDate = new Date(excelEpochUtc + Math.round(value * 86400 * 1000));
        if (Number.isNaN(utcDate.getTime())) return null;
        return toValidCalendarDate(utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate());
    }

    const raw = String(value).trim();
    if (!raw) return null;

    // Try DD.MM.YYYY or DD/MM/YYYY or DD-MM-YYYY
    const ddMmYyyy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\D.*)?$/);
    if (ddMmYyyy) {
        const year = ddMmYyyy[3].length === 2 ? Number(`20${ddMmYyyy[3]}`) : Number(ddMmYyyy[3]);
        const month = Number(ddMmYyyy[2]);
        const day = Number(ddMmYyyy[1]);
        const date = toValidCalendarDate(year, month, day);
        if (date) return date;
    }

    // Try YYYY-MM-DD or ISO
    const yyyyMmDd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (yyyyMmDd) {
        const year = Number(yyyyMmDd[1]);
        const month = Number(yyyyMmDd[2]);
        const day = Number(yyyyMmDd[3]);
        const date = toValidCalendarDate(year, month, day);
        if (date) return date;
    }

    // Try YYYYMMDD compact
    const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:\D.*)?$/);
    if (compact) {
        const date = toValidCalendarDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
        if (date) return date;
    }

    // Try Excel serial number as string
    const serialLike = raw.replace(',', '.');
    if (/^\d{4,6}(?:\.\d+)?$/.test(serialLike)) {
        const serial = Number(serialLike);
        if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
            const excelEpochUtc = Date.UTC(1899, 11, 30);
            const utcDate = new Date(excelEpochUtc + Math.round(serial * 86400 * 1000));
            if (!Number.isNaN(utcDate.getTime())) {
                return toValidCalendarDate(utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate());
            }
        }
    }

    // TIMEZONE FIX: new Date(raw) parses bare date strings ("2025-11-24") as UTC midnight,
    // causing a 1-day shift in UTC+ timezones. Extract UTC components instead.
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    if (/[T\s]\d{2}:|[+-]\d{2}:/.test(raw)) return parsed; // has explicit time/offset → trust as-is
    return toValidCalendarDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
};

/** Check whether a date falls within a given range */
export const isDateWithinRange = (
    year: number, month: number, day: number,
    from: Date | null, to: Date | null
): boolean => {
    const date = toValidCalendarDate(year, month, day);
    if (!date) return false;
    const ts = date.getTime();
    if (from && ts < from.getTime()) return false;
    if (to && ts > to.getTime()) return false;
    return true;
};

/** Check whether a transaction date (potentially in various formats) falls within a range */
export const isTransactionInDateRange = (
    dateValue: Date | string | number | null | undefined,
    from: Date | null, to: Date | null
): boolean => {
    if (!from && !to) return true;

    const date = parseTransactionDate(dateValue);
    if (!date) return false;

    if (isDateWithinRange(date.getFullYear(), date.getMonth() + 1, date.getDate(), from, to)) {
        return true;
    }

    // Check with UTC coordinates (handles timezone edge cases)
    const utcYear = date.getUTCFullYear();
    const utcMonth = date.getUTCMonth() + 1;
    const utcDay = date.getUTCDate();
    if (utcYear !== date.getFullYear() || utcMonth !== date.getMonth() + 1 || utcDay !== date.getDate()) {
        return isDateWithinRange(utcYear, utcMonth, utcDay, from, to);
    }

    return false;
};

/** Safely extract a numeric amount from unknown value */
export const getTransactionAmount = (value: unknown): number => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
        const normalized = value.trim()
            .replace(/\s+/g, '')
            .replace(/\./g, '')
            .replace(/,/g, '.');
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
};

/** Parse a flexible number string (handles Turkish formatting with dots and commas) */
export const parseFlexibleNumber = (value: string): number | null => {
    const raw = String(value || '').trim();
    if (!raw) return null;

    let normalized = raw.replace(/\s+/g, '');
    if (normalized.includes(',') && normalized.includes('.')) {
        if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
            normalized = normalized.replace(/\./g, '').replace(/,/g, '.');
        } else {
            normalized = normalized.replace(/,/g, '');
        }
    } else if (normalized.includes(',')) {
        normalized = normalized.replace(/,/g, '.');
    }

    normalized = normalized.replace(/[^0-9.-]/g, '');
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
};

/** Format a number as percentage string using Turkish locale */
export const formatPercent = (value: number): string => {
    return new Intl.NumberFormat('tr-TR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

/** Balance tolerance threshold for zero-balance checks */
export const BALANCE_TOLERANCE = 0.01;
