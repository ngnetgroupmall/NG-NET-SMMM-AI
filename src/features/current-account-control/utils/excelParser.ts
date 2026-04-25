import * as XLSX from 'xlsx';
import { parseTurkishNumber } from '../../../utils/parsers';
import type { AccountDetail, CurrentAccountParseSummary, Transaction } from '../../common/types';

const TARGET_PREFIXES = new Set(['120', '320', '159', '329', '340', '336']);

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10000) / 10000;

const parseIndex = (value: string | undefined): number | null => {
    if (value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    return parsed;
};

const parseOptionalNumber = (value: unknown): number | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;

    const parsed = parseTurkishNumber(value);
    if (!Number.isFinite(parsed)) return undefined;
    return parsed;
};

const resolveSingleFxColumnSides = (
    rawFxValue: number | undefined,
    debit: number,
    credit: number
): { fxDebitRaw: number | undefined; fxCreditRaw: number | undefined } => {
    if (rawFxValue === undefined || rawFxValue === 0) {
        return { fxDebitRaw: undefined, fxCreditRaw: undefined };
    }

    const magnitude = Math.abs(rawFxValue);
    const hasDebit = debit > 0;
    const hasCredit = credit > 0;

    if (hasDebit && !hasCredit) {
        return { fxDebitRaw: magnitude, fxCreditRaw: undefined };
    }

    if (hasCredit && !hasDebit) {
        return { fxDebitRaw: undefined, fxCreditRaw: magnitude };
    }

    const netTlMovement = debit - credit;
    if (netTlMovement > 0) {
        return { fxDebitRaw: magnitude, fxCreditRaw: undefined };
    }
    if (netTlMovement < 0) {
        return { fxDebitRaw: undefined, fxCreditRaw: magnitude };
    }

    if (rawFxValue > 0) {
        return { fxDebitRaw: magnitude, fxCreditRaw: undefined };
    }
    if (rawFxValue < 0) {
        return { fxDebitRaw: undefined, fxCreditRaw: magnitude };
    }

    return { fxDebitRaw: undefined, fxCreditRaw: undefined };
};

const normalizeAccountCode = (value: any): string => String(value ?? '').trim().replace(/\s+/g, '');

const getAccountPrefix = (accountCode: string): string => accountCode.replace(/\D/g, '').slice(0, 3);

const isTargetAccount = (accountCode: string): boolean => TARGET_PREFIXES.has(getAccountPrefix(accountCode));

const toValidCalendarDate = (year: number, month: number, day: number): Date | null => {
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
};

const parseDate = (value: any): Date | null => {
    if (value === null || value === undefined || value === '') return null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    if (typeof value === 'number') {
        /* Excel serial number: any positive number is a candidate.
         * Valid range for practical dates: 1 (1900-01-01) to ~80000 (2118).
         * Previously only 20000-80000 was accepted, which could reject
         * legitimate serial numbers for older dates.
         *
         * TIMEZONE FIX: Excel serials represent a calendar day (no time component).
         * Converting to UTC midnight then reading with getDate() causes a 1-day shift
         * in UTC+ timezones (e.g. TR/UTC+3). We extract UTC year/month/day from the
         * epoch-based Date and rebuild a local-time date at noon to stay timezone-safe. */
        if (Number.isFinite(value) && value >= 1 && value < 80000) {
            const excelEpochUtc = Date.UTC(1899, 11, 30);
            const utcDate = new Date(excelEpochUtc + Math.round(value * 86400 * 1000));
            if (!Number.isNaN(utcDate.getTime())) {
                return toValidCalendarDate(utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate());
            }
        }
        return null;
    }

    const raw = String(value).trim();
    if (!raw) return null;

    /* dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy  (day and month can be 1 or 2 digits) */
    const ddMmYyyy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\D.*)?$/);
    if (ddMmYyyy) {
        const year = ddMmYyyy[3].length === 2 ? Number(`20${ddMmYyyy[3]}`) : Number(ddMmYyyy[3]);
        const month = Number(ddMmYyyy[2]);
        const day = Number(ddMmYyyy[1]);
        const date = toValidCalendarDate(year, month, day);
        if (date) return date;
    }

    /* yyyy-mm-dd (ISO-like) */
    const yyyyMmDd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (yyyyMmDd) {
        const year = Number(yyyyMmDd[1]);
        const month = Number(yyyyMmDd[2]);
        const day = Number(yyyyMmDd[3]);
        const date = toValidCalendarDate(year, month, day);
        if (date) return date;
    }

    /* String that looks like a pure numeric serial, e.g. "45658" */
    const serialLike = raw.replace(',', '.');
    if (/^\d{4,6}(?:\.\d+)?$/.test(serialLike)) {
        const serial = Number(serialLike);
        if (Number.isFinite(serial) && serial >= 1 && serial < 80000) {
            const excelEpochUtc = Date.UTC(1899, 11, 30);
            const utcDate = new Date(excelEpochUtc + Math.round(serial * 86400 * 1000));
            if (!Number.isNaN(utcDate.getTime())) {
                return toValidCalendarDate(utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate());
            }
        }
    }

    /* TIMEZONE FIX: new Date(raw) parses ISO strings as UTC, which causes a 1-day
     * shift in UTC+ timezones. Extract UTC components and build a local-time date. */
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    // If the string contains a time component or explicit offset, trust the result as-is.
    // Otherwise (plain date string like "2025-11-24") rebuild from UTC components.
    if (/[T\s]\d{2}:|[+-]\d{2}:/.test(raw)) return parsed;
    return toValidCalendarDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
};

const shouldSkipByName = (name: string): boolean => {
    const normalized = name.toLocaleUpperCase('tr-TR');
    return (
        normalized.includes('TOPLAM') ||
        normalized.includes('YEKUN') ||
        normalized.includes('NAKLI') ||
        normalized.includes('DEVIR')
    );
};

const getCell = (row: any[], index: number | null): any => {
    if (index === null || index < 0 || index >= row.length) return null;
    return row[index];
};

export const parseExcelData = async (
    file: File,
    mapping: Record<string, string>,
    options?: ParseExcelOptions
): Promise<AccountDetail[]> => {
    const result = await parseExcelDataDetailed(file, mapping, options);
    return result.accounts;
};

export interface ParseExcelDataResult {
    accounts: AccountDetail[];
    summary: CurrentAccountParseSummary;
}

export interface ParseExcelOptions {
    includeAllAccounts?: boolean;
    includeForexOnlyMovement?: boolean;
}

export const parseExcelDataDetailed = async (
    file: File,
    mapping: Record<string, string>,
    options?: ParseExcelOptions
): Promise<ParseExcelDataResult> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target?.result as ArrayBuffer);
                const workbook = XLSX.read(data, { type: 'array', cellDates: true });
                const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(worksheet, {
                    header: 1,
                    raw: true,
                    defval: null,
                }) as any[][];

                const headerRowIndex = parseIndex(mapping.__headerRow) ?? 0;
                const dataRows = rows.slice(headerRowIndex + 1);

                const codeIndex = parseIndex(mapping.code);
                const nameIndex = parseIndex(mapping.name);
                const dateIndex = parseIndex(mapping.date);
                const descIndex = parseIndex(mapping.desc);
                const debitIndex = parseIndex(mapping.debit);
                const creditIndex = parseIndex(mapping.credit);
                const voucherIndex = parseIndex(mapping.voucher);
                const documentIndex = parseIndex(mapping.document);
                const currencyIndex = parseIndex(mapping.currency);
                const exchangeRateIndex = parseIndex(mapping.exchangeRate);
                const fxDebitIndex = parseIndex(mapping.fxDebit);
                const fxCreditIndex = parseIndex(mapping.fxCredit);
                const fxBalanceIndex = parseIndex(mapping.fxBalance);
                const includeAllAccounts = options?.includeAllAccounts ?? false;
                const includeForexOnlyMovement = options?.includeForexOnlyMovement ?? false;
                const summary: CurrentAccountParseSummary = {
                    totalRows: dataRows.length,
                    transactionRows: 0,
                    accountCount: 0,
                    filteredByPrefixRows: 0,
                    skippedNoCodeRows: 0,
                    skippedNoNameRows: 0,
                    skippedSummaryRows: 0,
                    zeroMovementRows: 0,
                    invalidDateRows: 0,
                    voucherNoRows: 0,
                };

                if (codeIndex === null || nameIndex === null || dateIndex === null || debitIndex === null || creditIndex === null) {
                    reject(new Error('Zorunlu alanlar eksik. Lutfen sutun eslestirmesini kontrol edin.'));
                    return;
                }

                const accountMap = new Map<string, AccountDetail>();

                dataRows.forEach((row) => {
                    if (!row || !Array.isArray(row)) return;

                    const code = normalizeAccountCode(getCell(row, codeIndex));
                    if (!code) {
                        summary.skippedNoCodeRows += 1;
                        return;
                    }
                    if (!includeAllAccounts && !isTargetAccount(code)) {
                        summary.filteredByPrefixRows += 1;
                        return;
                    }

                    const name = String(getCell(row, nameIndex) ?? '').trim();
                    if (!name) {
                        summary.skippedNoNameRows += 1;
                        return;
                    }
                    if (shouldSkipByName(name)) {
                        summary.skippedSummaryRows += 1;
                        return;
                    }

                    const debit = round2(parseTurkishNumber(getCell(row, debitIndex)));
                    const credit = round2(parseTurkishNumber(getCell(row, creditIndex)));
                    const currencyCode = currencyIndex === null ? undefined : String(getCell(row, currencyIndex) ?? '').trim() || undefined;
                    const exchangeRateRaw = exchangeRateIndex === null ? undefined : parseOptionalNumber(getCell(row, exchangeRateIndex));
                    const singleFxColumnSelected = (
                        fxDebitIndex !== null &&
                        fxCreditIndex !== null &&
                        fxDebitIndex === fxCreditIndex
                    );
                    let fxDebitRaw = fxDebitIndex === null ? undefined : parseOptionalNumber(getCell(row, fxDebitIndex));
                    let fxCreditRaw = fxCreditIndex === null ? undefined : parseOptionalNumber(getCell(row, fxCreditIndex));
                    if (singleFxColumnSelected) {
                        const resolved = resolveSingleFxColumnSides(fxDebitRaw, debit, credit);
                        fxDebitRaw = resolved.fxDebitRaw;
                        fxCreditRaw = resolved.fxCreditRaw;
                    }
                    const fxBalanceRaw = fxBalanceIndex === null ? undefined : parseOptionalNumber(getCell(row, fxBalanceIndex));

                    const fxDebit = fxDebitRaw === undefined ? undefined : round4(fxDebitRaw);
                    const fxCredit = fxCreditRaw === undefined ? undefined : round4(fxCreditRaw);
                    const fxBalance = fxBalanceRaw === undefined ? undefined : round4(fxBalanceRaw);
                    const exchangeRate = exchangeRateRaw === undefined ? undefined : round4(exchangeRateRaw);
                    const hasForexMovement = (
                        fxBalance !== undefined ||
                        (typeof fxDebit === 'number' && fxDebit !== 0) ||
                        (typeof fxCredit === 'number' && fxCredit !== 0)
                    );
                    const hasMovement = debit !== 0 || credit !== 0 || (includeForexOnlyMovement && hasForexMovement);
                    if (!hasMovement) {
                        summary.zeroMovementRows += 1;
                    }

                    const key = code;
                    if (!accountMap.has(key)) {
                        accountMap.set(key, {
                            code,
                            name,
                            totalDebit: 0,
                            totalCredit: 0,
                            balance: 0,
                            transactionCount: 0,
                            transactions: [],
                        });
                    }

                    const account = accountMap.get(key)!;
                    if (!account.name && name) {
                        account.name = name;
                    }

                    if (hasMovement) {
                        account.totalDebit = round2(account.totalDebit + debit);
                        account.totalCredit = round2(account.totalCredit + credit);
                        account.transactionCount += 1;

                        const rawDateCell = getCell(row, dateIndex);
                        const parsedDate = parseDate(rawDateCell);
                        if (
                            rawDateCell !== null &&
                            rawDateCell !== undefined &&
                            String(rawDateCell).trim() !== '' &&
                            !parsedDate
                        ) {
                            summary.invalidDateRows += 1;
                        }

                        const voucherNo = voucherIndex === null ? undefined : String(getCell(row, voucherIndex) ?? '').trim() || undefined;
                        const documentNo = documentIndex === null ? undefined : String(getCell(row, documentIndex) ?? '').trim() || undefined;
                        if (voucherNo) {
                            summary.voucherNoRows += 1;
                        }

                        const transaction: Transaction = {
                            date: parsedDate,
                            description: String(getCell(row, descIndex) ?? '').trim(),
                            debit,
                            credit,
                            voucherNo,
                            documentNo: documentNo || voucherNo,
                            currencyCode,
                            exchangeRate,
                            fxDebit,
                            fxCredit,
                            fxBalance,
                        };
                        account.transactions.push(transaction);
                        summary.transactionRows += 1;
                    }
                });

                const accounts = Array.from(accountMap.values()).map((account) => {
                    account.transactions.sort((a, b) => {
                        const at = a.date ? a.date.getTime() : Number.MAX_SAFE_INTEGER;
                        const bt = b.date ? b.date.getTime() : Number.MAX_SAFE_INTEGER;
                        return at - bt;
                    });

                    let runningBalance = 0;
                    const runningFxByCurrency = new Map<string, number>();
                    account.transactions.forEach((transaction) => {
                        runningBalance = round2(runningBalance + transaction.debit - transaction.credit);
                        transaction.balance = runningBalance;

                        const currencyKey = String(transaction.currencyCode || '').toLocaleUpperCase('tr-TR');
                        if (typeof transaction.fxBalance === 'number') {
                            runningFxByCurrency.set(currencyKey, round4(transaction.fxBalance));
                            return;
                        }

                        const fxDebit = typeof transaction.fxDebit === 'number' ? transaction.fxDebit : 0;
                        const fxCredit = typeof transaction.fxCredit === 'number' ? transaction.fxCredit : 0;
                        if (fxDebit !== 0 || fxCredit !== 0) {
                            const previous = runningFxByCurrency.get(currencyKey) || 0;
                            const next = round4(previous + fxDebit - fxCredit);
                            runningFxByCurrency.set(currencyKey, next);
                            transaction.fxBalance = next;
                        }
                    });

                    account.totalDebit = round2(account.totalDebit);
                    account.totalCredit = round2(account.totalCredit);
                    account.balance = round2(account.totalDebit - account.totalCredit);
                    return account;
                });

                accounts.sort((a, b) => {
                    const codeCompare = a.code.localeCompare(b.code, 'tr-TR');
                    if (codeCompare !== 0) return codeCompare;
                    return a.name.localeCompare(b.name, 'tr-TR');
                });

                summary.accountCount = accounts.length;
                resolve({
                    accounts,
                    summary,
                });
            } catch (error) {
                reject(error);
            }
        };

        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });
};
