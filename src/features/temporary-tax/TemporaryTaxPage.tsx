import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, Download, Layers, UserRound } from 'lucide-react';
import { Card } from '../../components/common/Card';
import { useCompany } from '../../context/CompanyContext';
import type { AccountDetail, Company, MappingConfig } from '../common/types';
import {
    applyVoucherEditsToAccounts,
    appendVoucherRowToAccounts,
    filterCurrentAccountScopeData,
    type VoucherAddRowRequest,
    type VoucherEditRequest,
} from '../common/voucherEditService';
import { resolveForexAccountType } from '../mizan/forexAccountRules';
import AccountStatementModal, { type AccountStatementRowIssue } from '../mizan/components/AccountStatementModal';
import VoucherDetailModal, {
    type VoucherAccountOption,
    type VoucherDetailRow,
    type VoucherMutationResponse,
} from '../mizan/components/VoucherDetailModal';
import { buildTemporaryTaxControls, type TemporaryTaxControlResult } from './controlChecks';
import { formatCurrency } from '../../utils/formatters';
import { resolveMainAccountStandardName } from '../mizan/accountNameResolver';
import {
    round2,
    normalizeVoucherNo,
    toValidCalendarDate,
    parseFlexibleNumber,
    formatPercent,
    BALANCE_TOLERANCE,
} from '../../utils/accounting';

type TemporaryTaxSource = 'FIRMA' | 'SMMM';
type AccountTypeMode = 'TL' | 'FOREX' | 'AUTO';
type TemporaryTaxSubModule = 'CONTROL' | 'PROFIT_LOSS';
type ProfitLossStatus = 'KAR' | 'ZARAR' | 'NOKTA';
type ProfitLossPeriod = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'YEARLY';
type QuarterPeriod = Exclude<ProfitLossPeriod, 'YEARLY'>;

const EMPTY_ACCOUNTS: AccountDetail[] = [];
const EMPTY_FOREX_OVERRIDES: Record<string, boolean> = {};
const STOCK_MAIN_CODES = new Set(['150', '151', '152', '153', '157']);
const SMM_COST_MAIN_CODES = new Set(['620', '621']);
const SMM_SALES_MAIN_CODES = new Set(['600', '601', '602']);
const SMM_CURRENT_COST_MAIN_CODES = new Set(['620', '621', '622']);
const INCOME_STATEMENT_ROLLUP_CODES: Record<string, string> = {
    '740': '622',
    '741': '622',
    '760': '631',
    '761': '631',
    '770': '632',
    '771': '632',
    '780': '660',
    '781': '660',
    '730': '620',
    '731': '620',
    '720': '620',
    '721': '620',
    '710': '620',
    '711': '620',
};
const PROFIT_LOSS_PERIOD_OPTIONS: ProfitLossPeriod[] = ['Q1', 'Q2', 'Q3', 'Q4', 'YEARLY'];

const PROFIT_LOSS_PERIOD_LABELS: Record<ProfitLossPeriod, string> = {
    Q1: '1. Çeyrek',
    Q2: '2. Çeyrek',
    Q3: '3. Çeyrek',
    Q4: '4. Çeyrek',
    YEARLY: 'Yıllık',
};

const PROFIT_LOSS_PERIOD_FILE_KEYS: Record<ProfitLossPeriod, string> = {
    Q1: 'q1',
    Q2: 'q2',
    Q3: 'q3',
    Q4: 'q4',
    YEARLY: 'yillik',
};

const getMain3Code = (accountCode: string): string => {
    return String(accountCode || '').replace(/\D/g, '').slice(0, 3);
};

const resolveIncomeStatementMainCode = (mainCode: string): string => {
    return INCOME_STATEMENT_ROLLUP_CODES[mainCode] || mainCode;
};

const resolveBalanceStatus = (balance: number): ProfitLossStatus => {
    if (Math.abs(balance) <= BALANCE_TOLERANCE) return 'NOKTA';
    return balance < 0 ? 'KAR' : 'ZARAR';
};

const formatStatusText = (status: ProfitLossStatus): string => {
    if (status === 'KAR') return 'KAR';
    if (status === 'ZARAR') return 'ZARAR';
    return 'NOKTA';
};

const getStatusTextClass = (status: ProfitLossStatus): string => {
    if (status === 'KAR') return 'text-emerald-300';
    if (status === 'ZARAR') return 'text-rose-300';
    return 'text-slate-300';
};

const getValidDate = (value: Date | string | number | null | undefined): Date | null => {
    if (!value) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    const raw = String(value).trim();
    if (!raw) return null;

    const yyyymmddMatch = raw.match(/^(\d{4})(\d{2})(\d{2})(?:\D.*)?$/);
    if (yyyymmddMatch) {
        const year = Number(yyyymmddMatch[1]);
        const month = Number(yyyymmddMatch[2]);
        const day = Number(yyyymmddMatch[3]);
        const date = toValidCalendarDate(year, month, day);
        if (date) {
            return date;
        }
    }

    const trDateMatch = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\D.*)?$/);
    if (trDateMatch) {
        const day = Number(trDateMatch[1]);
        const month = Number(trDateMatch[2]);
        const rawYear = trDateMatch[3];
        const year = rawYear.length === 2 ? Number(`20${rawYear}`) : Number(rawYear);
        const date = toValidCalendarDate(year, month, day);
        if (date) {
            return date;
        }
    }

    const isoDateMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (isoDateMatch) {
        const year = Number(isoDateMatch[1]);
        const month = Number(isoDateMatch[2]);
        const day = Number(isoDateMatch[3]);
        const date = toValidCalendarDate(year, month, day);
        if (date) {
            return date;
        }
    }

    const serialLike = raw.replace(',', '.');
    if (/^\d{4,6}(?:\.\d+)?$/.test(serialLike)) {
        const serial = Number(serialLike);
        if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
            const excelEpochUtc = Date.UTC(1899, 11, 30);
            const date = new Date(excelEpochUtc + Math.round(serial * 86400 * 1000));
            if (!Number.isNaN(date.getTime())) {
                return date;
            }
        }
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
};

const getDateFromTextHint = (value: string | null | undefined): Date | null => {
    const text = String(value || '').trim();
    if (!text) return null;

    const compact = text.match(/(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?:[^0-9]|$)/);
    if (compact) {
        const date = toValidCalendarDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
        if (date) return date;
    }

    const iso = text.match(/(?:^|[^0-9])(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[^0-9]|$)/);
    if (iso) {
        const date = toValidCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
        if (date) return date;
    }

    const tr = text.match(/(?:^|[^0-9])(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[^0-9]|$)/);
    if (tr) {
        const rawYear = tr[3];
        const year = rawYear.length === 2 ? Number(`20${rawYear}`) : Number(rawYear);
        const date = toValidCalendarDate(year, Number(tr[2]), Number(tr[1]));
        if (date) return date;
    }

    return null;
};

const getTransactionEffectiveDate = (transaction: {
    date: Date | string | number | null | undefined;
    description?: string;
    documentNo?: string;
    voucherNo?: string;
}): Date | null => {
    const direct = getValidDate(transaction.date);
    if (direct) return direct;

    const fromDescription = getDateFromTextHint(transaction.description);
    if (fromDescription) return fromDescription;

    const fromDocumentNo = getDateFromTextHint(transaction.documentNo);
    if (fromDocumentNo) return fromDocumentNo;

    return getDateFromTextHint(transaction.voucherNo);
};

const getAmount = (value: unknown): number => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
        const parsed = parseFlexibleNumber(value);
        return parsed === null ? 0 : parsed;
    }
    return 0;
};

const isMonthInProfitLossPeriod = (
    month: number,
    period: ProfitLossPeriod,
    isCumulative: boolean
): boolean => {
    if (period === 'YEARLY') return month >= 1 && month <= 12;
    if (isCumulative) {
        if (period === 'Q1') return month >= 1 && month <= 3;
        if (period === 'Q2') return month >= 1 && month <= 6;
        if (period === 'Q3') return month >= 1 && month <= 9;
        return month >= 1 && month <= 12;
    }
    if (period === 'Q1') return month >= 1 && month <= 3;
    if (period === 'Q2') return month >= 4 && month <= 6;
    if (period === 'Q3') return month >= 7 && month <= 9;
    return month >= 10 && month <= 12;
};

const isDateInProfitLossPeriod = (
    date: Date | null,
    year: number,
    period: ProfitLossPeriod,
    isCumulative: boolean
): boolean => {
    if (!date) return period === 'YEARLY';
    const localYear = date.getFullYear();
    const localMonth = date.getMonth() + 1;
    if (localYear === year && isMonthInProfitLossPeriod(localMonth, period, isCumulative)) {
        return true;
    }

    const utcYear = date.getUTCFullYear();
    const utcMonth = date.getUTCMonth() + 1;
    if ((utcYear !== localYear || utcMonth !== localMonth) && utcYear === year) {
        return isMonthInProfitLossPeriod(utcMonth, period, isCumulative);
    }

    return false;
};

const getProfitLossPeriodDateRangeLabel = (
    year: number,
    period: ProfitLossPeriod,
    isCumulative: boolean
): string => {
    const quarterEndMonth = period === 'Q1' ? 3 : period === 'Q2' ? 6 : period === 'Q3' ? 9 : 12;
    const bounds =
        period === 'YEARLY'
            ? { startMonth: 1, endMonth: 12 }
            : {
                startMonth: isCumulative ? 1 : quarterEndMonth - 2,
                endMonth: quarterEndMonth,
            };

    const start = new Date(year, bounds.startMonth - 1, 1);
    const end = new Date(year, bounds.endMonth, 0);
    return `${start.toLocaleDateString('tr-TR')} - ${end.toLocaleDateString('tr-TR')}`;
};

const getPreviousCumulativeQuarter = (
    year: number,
    period: ProfitLossPeriod
): { year: number; period: QuarterPeriod } => {
    if (period === 'Q1') {
        return { year: year - 1, period: 'Q4' };
    }
    if (period === 'Q2') {
        return { year, period: 'Q1' };
    }
    if (period === 'Q3') {
        return { year, period: 'Q2' };
    }
    if (period === 'Q4') {
        return { year, period: 'Q3' };
    }
    return { year, period: 'Q3' };
};

const calculateMainCodePeriodBalance = (
    accounts: AccountDetail[],
    mainCodes: Set<string>,
    year: number,
    period: ProfitLossPeriod,
    isCumulative: boolean
): number => {
    let total = 0;
    accounts.forEach((account) => {
        const mainCode = getMain3Code(account.code);
        if (!mainCodes.has(mainCode)) return;

        let totalDebit = 0;
        let totalCredit = 0;
        account.transactions.forEach((transaction) => {
            if (
                !isDateInProfitLossPeriod(
                    getTransactionEffectiveDate(transaction),
                    year,
                    period,
                    isCumulative
                )
            ) {
                return;
            }
            totalDebit = round2(totalDebit + getAmount(transaction.debit));
            totalCredit = round2(totalCredit + getAmount(transaction.credit));
        });

        total = round2(total + round2(totalDebit - totalCredit));
    });
    return total;
};


function TemporaryTaxContent({ activeCompany }: { activeCompany: Company }) {
    const { patchActiveCompany } = useCompany();
    const [selectedSource, setSelectedSource] = useState<TemporaryTaxSource>('FIRMA');
    const [activeSubModule, setActiveSubModule] = useState<TemporaryTaxSubModule>('CONTROL');
    const [selectedControlId, setSelectedControlId] = useState<string>('reverse-balance');
    const [selectedAccountCode, setSelectedAccountCode] = useState<string | null>(null);
    const [selectedVoucherNo, setSelectedVoucherNo] = useState<string | null>(null);
    const [taxRateBySource, setTaxRateBySource] = useState<Record<TemporaryTaxSource, 15 | 25>>({
        FIRMA: 25,
        SMMM: 25,
    });
    const [selectedProfitLossPeriod, setSelectedProfitLossPeriod] = useState<ProfitLossPeriod>('YEARLY');
    const [isProfitLossCumulative, setIsProfitLossCumulative] = useState(false);
    const [selectedProfitLossYear, setSelectedProfitLossYear] = useState<number | null>(null);
    const [previousPaidTaxOverrideByContext, setPreviousPaidTaxOverrideByContext] = useState<Record<string, number>>({});
    const [isEditingPreviousPaidTax, setIsEditingPreviousPaidTax] = useState(false);
    const [previousPaidTaxDraft, setPreviousPaidTaxDraft] = useState('');
    const [smmRatioOverrideByContext, setSmmRatioOverrideByContext] = useState<Record<string, number>>({});
    const [isEditingSmmRatio, setIsEditingSmmRatio] = useState(false);
    const [smmRatioDraft, setSmmRatioDraft] = useState('');
    const [smmApplyByContext, setSmmApplyByContext] = useState<Record<string, boolean>>({});
    const [isEditingPriorYearLoss, setIsEditingPriorYearLoss] = useState(false);
    const [priorYearLossDraft, setPriorYearLossDraft] = useState('');

    const firmaData = activeCompany.currentAccount?.firmaFullData ?? EMPTY_ACCOUNTS;
    const smmmData = activeCompany.currentAccount?.smmmFullData ?? EMPTY_ACCOUNTS;
    const forexOverrides = activeCompany.currentAccount?.forexAccountOverrides ?? EMPTY_FOREX_OVERRIDES;
    const priorYearLossValue = Math.abs(getAmount(activeCompany.currentAccount?.temporaryTaxPriorYearLoss));

    const source = useMemo<TemporaryTaxSource>(() => {
        if (selectedSource === 'FIRMA' && firmaData.length > 0) return 'FIRMA';
        if (selectedSource === 'SMMM' && smmmData.length > 0) return 'SMMM';
        if (firmaData.length > 0) return 'FIRMA';
        if (smmmData.length > 0) return 'SMMM';
        return selectedSource;
    }, [selectedSource, firmaData.length, smmmData.length]);

    const sourceData = useMemo(() => {
        return source === 'FIRMA' ? firmaData : smmmData;
    }, [source, firmaData, smmmData]);

    const profitLossYears = useMemo<number[]>(() => {
        const years = new Set<number>();
        sourceData.forEach((account) => {
            account.transactions.forEach((transaction) => {
                const txDate = getTransactionEffectiveDate(transaction);
                if (!txDate) return;
                years.add(txDate.getFullYear());
                years.add(txDate.getUTCFullYear());
            });
        });
        return Array.from(years).sort((left, right) => right - left);
    }, [sourceData]);

    useEffect(() => {
        if (!profitLossYears.length) {
            if (selectedProfitLossYear !== null) {
                setSelectedProfitLossYear(null);
            }
            return;
        }

        if (selectedProfitLossYear === null || !profitLossYears.includes(selectedProfitLossYear)) {
            setSelectedProfitLossYear(profitLossYears[0]);
        }
    }, [profitLossYears, selectedProfitLossYear]);

    const effectiveProfitLossYear = selectedProfitLossYear ?? profitLossYears[0] ?? new Date().getFullYear();
    const effectiveProfitLossCumulative = selectedProfitLossPeriod !== 'YEARLY' && isProfitLossCumulative;
    const selectedProfitLossPeriodLabel = `${PROFIT_LOSS_PERIOD_LABELS[selectedProfitLossPeriod]} ${effectiveProfitLossYear}${effectiveProfitLossCumulative ? ' (Kumulatif)' : ''}`;
    const selectedProfitLossDateRangeLabel = getProfitLossPeriodDateRangeLabel(
        effectiveProfitLossYear,
        selectedProfitLossPeriod,
        effectiveProfitLossCumulative
    );
    const selectedProfitLossContextKey = `${source}:${effectiveProfitLossYear}:${selectedProfitLossPeriod}:${effectiveProfitLossCumulative ? 'C' : 'P'}`;
    const selectedSmmRatioContextKey = `${source}:${effectiveProfitLossYear}:${selectedProfitLossPeriod}`;

    const profitLossSourceData = useMemo<AccountDetail[]>(() => {
        return sourceData.reduce<AccountDetail[]>((list, account) => {
            const filteredTransactions = account.transactions.filter((transaction) =>
                isDateInProfitLossPeriod(
                    getTransactionEffectiveDate(transaction),
                    effectiveProfitLossYear,
                    selectedProfitLossPeriod,
                    effectiveProfitLossCumulative
                )
            );
            if (!filteredTransactions.length) return list;

            let totalDebit = 0;
            let totalCredit = 0;
            filteredTransactions.forEach((transaction) => {
                totalDebit = round2(totalDebit + getAmount(transaction.debit));
                totalCredit = round2(totalCredit + getAmount(transaction.credit));
            });

            list.push({
                ...account,
                totalDebit,
                totalCredit,
                balance: round2(totalDebit - totalCredit),
                transactionCount: filteredTransactions.length,
                transactions: filteredTransactions,
            });
            return list;
        }, []);
    }, [sourceData, effectiveProfitLossYear, selectedProfitLossPeriod, effectiveProfitLossCumulative]);

    const controls = useMemo<TemporaryTaxControlResult[]>(() => {
        return buildTemporaryTaxControls(sourceData, forexOverrides);
    }, [sourceData, forexOverrides]);

    const baseProfitLoss = useMemo(() => {
        const mainMap = new Map<string, { code: string; name: string; balance: number; count: number }>();
        let total6 = 0;
        let total7 = 0;
        let account689Balance = 0;
        let account193Balance = 0;
        let stockBalance = 0;

        profitLossSourceData.forEach((account) => {
            const mainCode = getMain3Code(account.code);
            if (!mainCode) return;
            const groupedMainCode = resolveIncomeStatementMainCode(mainCode);

            if (groupedMainCode.startsWith('6') || groupedMainCode.startsWith('7')) {
                const current = mainMap.get(groupedMainCode);
                const accountName = resolveMainAccountStandardName(groupedMainCode, account.name || '');

                if (!current) {
                    mainMap.set(groupedMainCode, {
                        code: groupedMainCode,
                        name: accountName,
                        balance: account.balance,
                        count: 1,
                    });
                } else {
                    if (!current.name && accountName) {
                        current.name = accountName;
                    }
                    current.balance = round2(current.balance + account.balance);
                    current.count += 1;
                }
            }

            if (groupedMainCode.startsWith('6')) {
                total6 = round2(total6 + account.balance);
            }
            if (groupedMainCode.startsWith('7')) {
                total7 = round2(total7 + account.balance);
            }
            if (mainCode === '689') {
                account689Balance = round2(account689Balance + account.balance);
            }
            if (mainCode === '193') {
                account193Balance = round2(account193Balance + account.balance);
            }
            if (STOCK_MAIN_CODES.has(mainCode)) {
                stockBalance = round2(stockBalance + account.balance);
            }
        });

        const sortedMainRows = Array.from(mainMap.values()).sort((left, right) => {
            const codeCompare = left.code.localeCompare(right.code, 'tr-TR');
            if (codeCompare !== 0) return codeCompare;
            return left.balance - right.balance;
        });

        const sixSevenDiff = round2(round2(total6 + total7) - priorYearLossValue);
        const sixSevenStatus = resolveBalanceStatus(sixSevenDiff);

        let kkegIncludedValue = 0;
        let kkegIncludedStatus: ProfitLossStatus = 'NOKTA';
        if (sixSevenDiff < -BALANCE_TOLERANCE) {
            kkegIncludedValue = round2(Math.abs(sixSevenDiff) + Math.abs(account689Balance));
            kkegIncludedStatus = 'KAR';
        } else if (sixSevenDiff > BALANCE_TOLERANCE) {
            const kkegAdjusted = round2(sixSevenDiff - Math.abs(account689Balance));
            kkegIncludedValue = Math.abs(kkegAdjusted);
            kkegIncludedStatus = kkegAdjusted < -BALANCE_TOLERANCE ? 'KAR' : 'ZARAR';
        }

        const stockAbs = Math.abs(stockBalance);
        let temporaryTaxValue = 0;
        let temporaryTaxStatus: ProfitLossStatus = 'NOKTA';

        if (kkegIncludedStatus === 'KAR') {
            const netTemporaryTax = round2(kkegIncludedValue - stockAbs);
            temporaryTaxValue = Math.abs(netTemporaryTax);
            temporaryTaxStatus = netTemporaryTax < -BALANCE_TOLERANCE ? 'ZARAR' : 'KAR';
        } else if (kkegIncludedStatus === 'ZARAR') {
            temporaryTaxValue = round2(kkegIncludedValue + stockAbs);
            temporaryTaxStatus = 'ZARAR';
        }

        return {
            rows: sortedMainRows,
            total6,
            total7,
            sixSevenDiff,
            sixSevenStatus,
            account689Balance,
            account193Balance,
            kkegIncludedValue,
            kkegIncludedStatus,
            stockBalance: stockAbs,
            temporaryTaxValue,
            temporaryTaxStatus,
        };
    }, [profitLossSourceData, priorYearLossValue]);

    const smmPreviousCumulativeContext = useMemo(() => {
        return getPreviousCumulativeQuarter(effectiveProfitLossYear, selectedProfitLossPeriod);
    }, [effectiveProfitLossYear, selectedProfitLossPeriod]);

    const smmRatioAutoMetrics = useMemo(() => {
        const previousYear = smmPreviousCumulativeContext.year;
        const previousPeriod = smmPreviousCumulativeContext.period;

        const smmCostBalance = calculateMainCodePeriodBalance(
            sourceData,
            SMM_COST_MAIN_CODES,
            previousYear,
            previousPeriod,
            true
        );
        const smmSalesBalance = calculateMainCodePeriodBalance(
            sourceData,
            SMM_SALES_MAIN_CODES,
            previousYear,
            previousPeriod,
            true
        );

        const smmCostAbs = Math.abs(smmCostBalance);
        const smmSalesAbs = Math.abs(smmSalesBalance);
        const smmRatioAuto = smmSalesAbs > BALANCE_TOLERANCE
            ? round2((smmCostAbs / smmSalesAbs) * 100)
            : 0;

        return {
            previousYear,
            previousPeriod,
            smmCostBalance,
            smmSalesBalance,
            smmCostAbs,
            smmSalesAbs,
            smmRatioAuto,
            hasValidDenominator: smmSalesAbs > BALANCE_TOLERANCE,
        };
    }, [sourceData, smmPreviousCumulativeContext]);

    const smmRatioValue = smmRatioOverrideByContext[selectedSmmRatioContextKey] ?? smmRatioAutoMetrics.smmRatioAuto;
    const smmReferenceLabel = `${PROFIT_LOSS_PERIOD_LABELS[smmRatioAutoMetrics.previousPeriod]} ${smmRatioAutoMetrics.previousYear} (Kumulatif)`;

    const ciroMetrics = useMemo(() => {
        const ciroBalance = calculateMainCodePeriodBalance(
            sourceData,
            SMM_SALES_MAIN_CODES,
            effectiveProfitLossYear,
            selectedProfitLossPeriod,
            effectiveProfitLossCumulative
        );

        const currentCostBalance = calculateMainCodePeriodBalance(
            sourceData,
            SMM_CURRENT_COST_MAIN_CODES,
            effectiveProfitLossYear,
            selectedProfitLossPeriod,
            effectiveProfitLossCumulative
        );

        const ciroAbs = Math.abs(ciroBalance);
        const currentCostAbs = Math.abs(currentCostBalance);
        const projectedCost = round2(ciroAbs * (smmRatioValue / 100));
        const normalCurrentPeriodCostToPost = round2(projectedCost - currentCostAbs);
        const availableStockForCost = Math.max(0, round2(baseProfitLoss.stockBalance));
        const isCappedByStock =
            normalCurrentPeriodCostToPost > round2(availableStockForCost + BALANCE_TOLERANCE);
        const currentPeriodCostToPost = isCappedByStock
            ? availableStockForCost
            : normalCurrentPeriodCostToPost;

        return {
            ciroBalance,
            currentCostBalance,
            ciroAbs,
            currentCostAbs,
            projectedCost,
            normalCurrentPeriodCostToPost,
            availableStockForCost,
            isCappedByStock,
            currentPeriodCostToPost,
        };
    }, [
        sourceData,
        effectiveProfitLossYear,
        selectedProfitLossPeriod,
        effectiveProfitLossCumulative,
        smmRatioValue,
        baseProfitLoss.stockBalance,
    ]);

    const isSmmApplied = Boolean(smmApplyByContext[selectedProfitLossContextKey]);

    const profitLoss = useMemo(() => {
        if (!isSmmApplied) {
            return baseProfitLoss;
        }

        const sixSevenDiff = round2(baseProfitLoss.sixSevenDiff - ciroMetrics.currentPeriodCostToPost);
        const sixSevenStatus = resolveBalanceStatus(sixSevenDiff);
        const account689Balance = baseProfitLoss.account689Balance;

        let kkegIncludedValue = 0;
        let kkegIncludedStatus: ProfitLossStatus = 'NOKTA';
        if (sixSevenDiff < -BALANCE_TOLERANCE) {
            kkegIncludedValue = round2(Math.abs(sixSevenDiff) + Math.abs(account689Balance));
            kkegIncludedStatus = 'KAR';
        } else if (sixSevenDiff > BALANCE_TOLERANCE) {
            const kkegAdjusted = round2(sixSevenDiff - Math.abs(account689Balance));
            kkegIncludedValue = Math.abs(kkegAdjusted);
            kkegIncludedStatus = kkegAdjusted < -BALANCE_TOLERANCE ? 'KAR' : 'ZARAR';
        }

        const stockBalance = 0;
        let temporaryTaxValue = 0;
        let temporaryTaxStatus: ProfitLossStatus = 'NOKTA';

        if (kkegIncludedStatus === 'KAR') {
            const netTemporaryTax = round2(kkegIncludedValue - stockBalance);
            temporaryTaxValue = Math.abs(netTemporaryTax);
            temporaryTaxStatus = netTemporaryTax < -BALANCE_TOLERANCE ? 'ZARAR' : 'KAR';
        } else if (kkegIncludedStatus === 'ZARAR') {
            temporaryTaxValue = round2(kkegIncludedValue + stockBalance);
            temporaryTaxStatus = 'ZARAR';
        }

        return {
            ...baseProfitLoss,
            sixSevenDiff,
            sixSevenStatus,
            kkegIncludedValue,
            kkegIncludedStatus,
            stockBalance,
            temporaryTaxValue,
            temporaryTaxStatus,
        };
    }, [baseProfitLoss, ciroMetrics.currentPeriodCostToPost, isSmmApplied]);

    const selectedTaxRate = taxRateBySource[source] || 25;
    const previousPaidTaxAuto = Math.abs(profitLoss.account193Balance);
    const previousPaidTaxValue = previousPaidTaxOverrideByContext[selectedProfitLossContextKey] ?? previousPaidTaxAuto;
    const calculatedTemporaryTax = round2(
        (profitLoss.temporaryTaxStatus === 'KAR' ? profitLoss.temporaryTaxValue : 0) * (selectedTaxRate / 100)
    );
    const currentPeriodPayableTax = round2(calculatedTemporaryTax - previousPaidTaxValue);

    useEffect(() => {
        setPreviousPaidTaxDraft('');
        setIsEditingPreviousPaidTax(false);
    }, [selectedProfitLossContextKey]);

    useEffect(() => {
        setSmmRatioDraft('');
        setIsEditingSmmRatio(false);
    }, [selectedSmmRatioContextKey]);

    const handleStartEditPriorYearLoss = () => {
        setPriorYearLossDraft(String(priorYearLossValue));
        setIsEditingPriorYearLoss(true);
    };

    const handleCancelEditPriorYearLoss = () => {
        setPriorYearLossDraft('');
        setIsEditingPriorYearLoss(false);
    };

    const handleSavePriorYearLoss = async () => {
        const parsed = parseFlexibleNumber(priorYearLossDraft);
        const nextValue = parsed === null ? 0 : Math.abs(round2(parsed));

        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount || {
                smmmData: [] as AccountDetail[],
                firmaData: [] as AccountDetail[],
                mappings: {} as MappingConfig,
            };

            return {
                currentAccount: {
                    ...currentAccount,
                    temporaryTaxPriorYearLoss: nextValue,
                },
            };
        });

        handleCancelEditPriorYearLoss();
    };

    const handleStartEditPreviousPaidTax = () => {
        setPreviousPaidTaxDraft(String(previousPaidTaxValue));
        setIsEditingPreviousPaidTax(true);
    };

    const handleCancelEditPreviousPaidTax = () => {
        setPreviousPaidTaxDraft('');
        setIsEditingPreviousPaidTax(false);
    };

    const handleSavePreviousPaidTax = () => {
        const parsed = parseFlexibleNumber(previousPaidTaxDraft);
        if (parsed === null) {
            setPreviousPaidTaxOverrideByContext((current) => {
                const next = { ...current };
                delete next[selectedProfitLossContextKey];
                return next;
            });
            handleCancelEditPreviousPaidTax();
            return;
        }

        setPreviousPaidTaxOverrideByContext((current) => ({
            ...current,
            [selectedProfitLossContextKey]: round2(parsed),
        }));
        handleCancelEditPreviousPaidTax();
    };

    const handleStartEditSmmRatio = () => {
        setSmmRatioDraft(String(smmRatioValue));
        setIsEditingSmmRatio(true);
    };

    const handleCancelEditSmmRatio = () => {
        setSmmRatioDraft('');
        setIsEditingSmmRatio(false);
    };

    const handleSaveSmmRatio = () => {
        const parsed = parseFlexibleNumber(smmRatioDraft);
        if (parsed === null) {
            setSmmRatioOverrideByContext((current) => {
                const next = { ...current };
                delete next[selectedSmmRatioContextKey];
                return next;
            });
            handleCancelEditSmmRatio();
            return;
        }

        setSmmRatioOverrideByContext((current) => ({
            ...current,
            [selectedSmmRatioContextKey]: round2(parsed),
        }));
        handleCancelEditSmmRatio();
    };

    const handleToggleSmmApply = () => {
        setSmmApplyByContext((current) => {
            const next = { ...current };
            if (next[selectedProfitLossContextKey]) {
                delete next[selectedProfitLossContextKey];
            } else {
                next[selectedProfitLossContextKey] = true;
            }
            return next;
        });
    };

    const selectedControl = useMemo(() => {
        if (!controls.length) return null;
        return controls.find((control) => control.id === selectedControlId) || controls[0];
    }, [controls, selectedControlId]);

    const handleDownloadTemporaryTaxExcel = async () => {
        const XLSX = await import('xlsx');
        const { applyStyledSheet } = await import('../../utils/excelStyle');

        const workbook = XLSX.utils.book_new();
        const datePart = new Date().toISOString().slice(0, 10);
        const sourceKey = source.toLocaleLowerCase('tr-TR');

        if (activeSubModule === 'CONTROL') {
            const controlSummaryRows = controls.map((control) => ({
                Kontrol: control.title,
                Aciklama: control.description,
                'Problemli Hesap': control.accounts.length,
            }));
            const controlSummarySheet = XLSX.utils.json_to_sheet(controlSummaryRows);
            applyStyledSheet(controlSummarySheet, { headerRowIndex: 0, numericColumns: [2] });
            XLSX.utils.book_append_sheet(workbook, controlSummarySheet, 'Kontrol_Ozet');

            const selectedRows = (selectedControl?.accounts || []).map((item) => ({
                'Hesap Kodu': item.account.code,
                'Hesap Adi': item.account.name || '-',
                'Kontrol Sonucu': item.reason,
                Detay: item.detail || '-',
                Bakiye: item.account.balance,
                Hareket: item.account.transactionCount,
            }));
            const selectedSheet = XLSX.utils.json_to_sheet(selectedRows);
            applyStyledSheet(selectedSheet, { headerRowIndex: 0, numericColumns: [4, 5] });
            XLSX.utils.book_append_sheet(workbook, selectedSheet, 'Kontrol_Detay');

            XLSX.writeFile(workbook, `gecici_vergi_kontrol_${sourceKey}_${datePart}.xlsx`);
            return;
        }

        const mainRows = profitLoss.rows.map((row) => {
            const status = resolveBalanceStatus(row.balance);
            return {
                'Ana Hesap': row.code,
                'Hesap Adi': row.name || '-',
                Bakiye: row.balance,
                Durum: formatStatusText(status),
            };
        });
        const mainRowsSheet = XLSX.utils.json_to_sheet(mainRows);
        applyStyledSheet(mainRowsSheet, { headerRowIndex: 0, numericColumns: [2] });
        XLSX.utils.book_append_sheet(workbook, mainRowsSheet, 'Ana_Hesaplar_6_7');

        const summaryRows = [
            { Baslik: 'Donem', Tutar: '-', Durum: `${selectedProfitLossPeriodLabel} | ${selectedProfitLossDateRangeLabel}` },
            { Baslik: 'Gecmis Yil Zarari (Firma Bazli)', Tutar: priorYearLossValue, Durum: priorYearLossValue > BALANCE_TOLERANCE ? '6-7 Net Farktan Dusuldu' : '-' },
            { Baslik: '6-7 Net Fark', Tutar: Math.abs(profitLoss.sixSevenDiff), Durum: formatStatusText(profitLoss.sixSevenStatus) },
            { Baslik: '689 KKEG Bakiyesi', Tutar: Math.abs(profitLoss.account689Balance), Durum: formatStatusText(resolveBalanceStatus(profitLoss.account689Balance)) },
            { Baslik: 'KKEG Dahil Kar/Zarar', Tutar: Math.abs(profitLoss.kkegIncludedValue), Durum: formatStatusText(profitLoss.kkegIncludedStatus) },
            { Baslik: 'Kullanilabilir Stok', Tutar: profitLoss.stockBalance, Durum: '-' },
            { Baslik: 'Gecici Vergi Kari', Tutar: Math.abs(profitLoss.temporaryTaxValue), Durum: formatStatusText(profitLoss.temporaryTaxStatus) },
            { Baslik: `Hesaplanan Gecici Vergi (%${selectedTaxRate})`, Tutar: Math.abs(calculatedTemporaryTax), Durum: '-' },
            { Baslik: 'Onceki Donem Odenen Gecici Vergi (193)', Tutar: Math.abs(previousPaidTaxValue), Durum: previousPaidTaxOverrideByContext[selectedProfitLossContextKey] !== undefined ? 'Manuel' : '193 Otomatik' },
            { Baslik: 'Bu Donem Odenecek Gecici Vergi', Tutar: Math.abs(currentPeriodPayableTax), Durum: currentPeriodPayableTax >= -BALANCE_TOLERANCE ? 'ODENECEK' : 'DEVREDEN' },
            { Baslik: `SMM A (620+621) [${smmReferenceLabel}]`, Tutar: smmRatioAutoMetrics.smmCostAbs, Durum: '-' },
            { Baslik: `SMM B (600+601+602) [${smmReferenceLabel}]`, Tutar: smmRatioAutoMetrics.smmSalesAbs, Durum: '-' },
            { Baslik: 'SMM Orani (%)', Tutar: smmRatioValue, Durum: smmRatioOverrideByContext[selectedSmmRatioContextKey] !== undefined ? 'Manuel' : 'Otomatik' },
            { Baslik: `Ciro (600+601+602) [${selectedProfitLossPeriodLabel}]`, Tutar: ciroMetrics.ciroAbs, Durum: '-' },
            {
                Baslik: `Bu Donem Maliyet Atilacak [(${formatPercent(smmRatioValue)}% x Ciro) - (620+621+622)]`,
                Tutar: ciroMetrics.currentPeriodCostToPost,
                Durum: ciroMetrics.isCappedByStock
                    ? 'STOK YETERSIZ - SINIRLANDI'
                    : ciroMetrics.currentPeriodCostToPost >= -BALANCE_TOLERANCE
                        ? 'POZITIF'
                        : 'NEGATIF',
            },
        ];
        const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
        applyStyledSheet(summarySheet, { headerRowIndex: 0, numericColumns: [1] });
        XLSX.utils.book_append_sheet(workbook, summarySheet, 'Kar_Zarar_Ozet');

        const periodKey = PROFIT_LOSS_PERIOD_FILE_KEYS[selectedProfitLossPeriod];
        const cumulativeKey = effectiveProfitLossCumulative ? '_kumulatif' : '';
        XLSX.writeFile(workbook, `gecici_vergi_kar_zarar_${sourceKey}_${effectiveProfitLossYear}_${periodKey}${cumulativeKey}_${datePart}.xlsx`);
    };

    const selectedAccount = useMemo(() => {
        if (!selectedAccountCode) return null;
        return sourceData.find((account) => account.code === selectedAccountCode) || null;
    }, [sourceData, selectedAccountCode]);

    const selectedControlAccountItem = useMemo(() => {
        if (!selectedControl || !selectedAccountCode) return null;
        return selectedControl.accounts.find((item) => item.account.code === selectedAccountCode) || null;
    }, [selectedControl, selectedAccountCode]);

    const selectedAccountRowIssues = useMemo<Record<number, AccountStatementRowIssue>>(() => {
        const map: Record<number, AccountStatementRowIssue> = {};
        if (!selectedControlAccountItem?.rowIssues) return map;
        selectedControlAccountItem.rowIssues.forEach((issue) => {
            if (!map[issue.rowIndex]) {
                map[issue.rowIndex] = {
                    code: issue.code,
                    message: issue.message,
                };
                return;
            }

            const mergedCodes = new Set(
                `${map[issue.rowIndex].code},${issue.code}`
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean)
            );
            map[issue.rowIndex] = {
                code: Array.from(mergedCodes).join(', '),
                message: `${map[issue.rowIndex].message} | ${issue.message}`,
            };
        });
        return map;
    }, [selectedControlAccountItem]);

    const selectedAccountForexType = useMemo(() => {
        if (!selectedAccount) return null;
        return resolveForexAccountType(selectedAccount.code, selectedAccount.name || '', forexOverrides);
    }, [selectedAccount, forexOverrides]);

    const voucherAccountOptions = useMemo<VoucherAccountOption[]>(() => {
        return sourceData
            .map((account) => ({
                code: account.code,
                name: account.name || '',
            }))
            .sort((left, right) => {
                const codeCompare = left.code.localeCompare(right.code, 'tr-TR');
                if (codeCompare !== 0) return codeCompare;
                return left.name.localeCompare(right.name, 'tr-TR');
            });
    }, [sourceData]);

    const handleAccountTypeChange = async (mode: AccountTypeMode) => {
        if (!selectedAccount) return;

        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount || {
                smmmData: [] as AccountDetail[],
                firmaData: [] as AccountDetail[],
                mappings: {} as MappingConfig,
            };

            const nextOverrides = {
                ...(currentAccount.forexAccountOverrides || {}),
            };

            if (mode === 'AUTO') {
                delete nextOverrides[selectedAccount.code];
            } else {
                nextOverrides[selectedAccount.code] = mode === 'FOREX';
            }

            return {
                currentAccount: {
                    ...currentAccount,
                    forexAccountOverrides: nextOverrides,
                },
            };
        });
    };

    const handleVoucherRowEditBatch = async (requests: VoucherEditRequest[]): Promise<VoucherMutationResponse> => {
        const queue = (requests || []).filter(Boolean);
        if (!queue.length) return { ok: true };

        const sourceRequests = queue.filter((item) => item.locator.source === source);
        if (sourceRequests.length !== queue.length) {
            return { ok: false, error: 'Kaynaklar karisik oldugu icin toplu kayit yapilamadi.' };
        }

        let response: VoucherMutationResponse = { ok: true };

        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount || {
                smmmData: [] as AccountDetail[],
                firmaData: [] as AccountDetail[],
                smmmFullData: [] as AccountDetail[],
                firmaFullData: [] as AccountDetail[],
                mappings: {} as MappingConfig,
            };

            if (source === 'FIRMA') {
                const result = applyVoucherEditsToAccounts(currentAccount.firmaFullData || [], sourceRequests);
                if (result.error) {
                    response = { ok: false, error: result.error };
                    return {};
                }
                if (!result.changed) {
                    response = { ok: true };
                    return {};
                }

                response = { ok: true, focusVoucherNo: result.focusVoucherNo };
                return {
                    currentAccount: {
                        ...currentAccount,
                        firmaFullData: result.accounts,
                        firmaData: filterCurrentAccountScopeData(result.accounts),
                        voucherEditLogs: [
                            ...(currentAccount.voucherEditLogs || []),
                            ...result.logEntries,
                        ],
                    },
                };
            }

            const result = applyVoucherEditsToAccounts(currentAccount.smmmFullData || [], sourceRequests);
            if (result.error) {
                response = { ok: false, error: result.error };
                return {};
            }
            if (!result.changed) {
                response = { ok: true };
                return {};
            }

            response = { ok: true, focusVoucherNo: result.focusVoucherNo };
            return {
                currentAccount: {
                    ...currentAccount,
                    smmmFullData: result.accounts,
                    smmmData: filterCurrentAccountScopeData(result.accounts),
                    voucherEditLogs: [
                        ...(currentAccount.voucherEditLogs || []),
                        ...result.logEntries,
                    ],
                },
            };
        });

        return response;
    };

    const handleVoucherRowEdit = async (request: VoucherEditRequest): Promise<VoucherMutationResponse> => {
        return handleVoucherRowEditBatch([request]);
    };

    const handleVoucherRowAdd = async (request: VoucherAddRowRequest): Promise<VoucherMutationResponse> => {
        let response: VoucherMutationResponse = { ok: true };

        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount || {
                smmmData: [] as AccountDetail[],
                firmaData: [] as AccountDetail[],
                smmmFullData: [] as AccountDetail[],
                firmaFullData: [] as AccountDetail[],
                mappings: {} as MappingConfig,
            };

            if (request.source === 'FIRMA') {
                const result = appendVoucherRowToAccounts(currentAccount.firmaFullData || [], request);
                if (result.error) {
                    response = { ok: false, error: result.error };
                    return {};
                }
                if (!result.changed) {
                    response = { ok: true };
                    return {};
                }

                response = { ok: true, focusVoucherNo: result.focusVoucherNo };
                return {
                    currentAccount: {
                        ...currentAccount,
                        firmaFullData: result.accounts,
                        firmaData: filterCurrentAccountScopeData(result.accounts),
                        voucherEditLogs: [
                            ...(currentAccount.voucherEditLogs || []),
                            ...(result.logEntry ? [result.logEntry] : []),
                        ],
                    },
                };
            }

            const result = appendVoucherRowToAccounts(currentAccount.smmmFullData || [], request);
            if (result.error) {
                response = { ok: false, error: result.error };
                return {};
            }
            if (!result.changed) {
                response = { ok: true };
                return {};
            }

            response = { ok: true, focusVoucherNo: result.focusVoucherNo };
            return {
                currentAccount: {
                    ...currentAccount,
                    smmmFullData: result.accounts,
                    smmmData: filterCurrentAccountScopeData(result.accounts),
                    voucherEditLogs: [
                        ...(currentAccount.voucherEditLogs || []),
                        ...(result.logEntry ? [result.logEntry] : []),
                    ],
                },
            };
        });

        return response;
    };

    const voucherRows = useMemo<VoucherDetailRow[]>(() => {
        if (!selectedVoucherNo) return [];
        const target = normalizeVoucherNo(selectedVoucherNo);
        if (!target) return [];

        const rows: VoucherDetailRow[] = [];
        sourceData.forEach((account) => {
            account.transactions.forEach((transaction, transactionIndex) => {
                if (normalizeVoucherNo(transaction.voucherNo) !== target) return;
                rows.push({
                    source,
                    sourceAccountCode: account.code,
                    sourceTransactionIndex: transactionIndex,
                    sourceTransactionId: transaction.id,
                    voucherNo: transaction.voucherNo,
                    accountCode: account.code,
                    accountName: account.name,
                    documentNo: transaction.documentNo || transaction.voucherNo,
                    date: transaction.date,
                    description: transaction.description,
                    debit: transaction.debit,
                    credit: transaction.credit,
                    currencyCode: transaction.currencyCode,
                    exchangeRate: transaction.exchangeRate,
                    fxDebit: transaction.fxDebit,
                    fxCredit: transaction.fxCredit,
                    fxBalance: transaction.fxBalance,
                });
            });
        });

        rows.sort((a, b) => {
            const aTime = a.date ? a.date.getTime() : Number.MAX_SAFE_INTEGER;
            const bTime = b.date ? b.date.getTime() : Number.MAX_SAFE_INTEGER;
            if (aTime !== bTime) return aTime - bTime;
            const accountCompare = a.accountCode.localeCompare(b.accountCode, 'tr-TR');
            if (accountCompare !== 0) return accountCompare;
            return a.sourceTransactionIndex - b.sourceTransactionIndex;
        });

        return rows;
    }, [selectedVoucherNo, sourceData, source]);

    const hasAnyData = firmaData.length > 0 || smmmData.length > 0;

    return (
        <div className="animate-fade-in flex flex-col gap-0">
            {/* ── Compact Toolbar: Source + SubModule + Excel ── */}
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl flex-wrap">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-sm font-bold text-white uppercase tracking-wide">Gecici Vergi</h1>
                    <div className="h-4 w-px bg-slate-700" />
                    <button
                        type="button"
                        onClick={() => setSelectedSource('FIRMA')}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${source === 'FIRMA'
                            ? 'bg-indigo-600 border-indigo-500 text-white'
                            : 'bg-slate-900/50 border-slate-700 text-slate-300 hover:border-indigo-400/50'
                            }`}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            <Building2 size={12} /> Firma ({firmaData.length})
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setSelectedSource('SMMM')}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${source === 'SMMM'
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-slate-900/50 border-slate-700 text-slate-300 hover:border-blue-400/50'
                            }`}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            <UserRound size={12} /> SMMM ({smmmData.length})
                        </span>
                    </button>
                    {sourceData.length > 0 && (
                        <>
                            <div className="h-4 w-px bg-slate-700" />
                            <button
                                type="button"
                                onClick={() => setActiveSubModule('CONTROL')}
                                className={`px-2.5 py-1.5 rounded-md border text-[11px] font-semibold transition-colors ${activeSubModule === 'CONTROL'
                                    ? 'bg-blue-600/20 border-blue-500/40 text-blue-200'
                                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-blue-500/40'
                                    }`}
                            >
                                Kontrol
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveSubModule('PROFIT_LOSS')}
                                className={`px-2.5 py-1.5 rounded-md border text-[11px] font-semibold transition-colors ${activeSubModule === 'PROFIT_LOSS'
                                    ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-200'
                                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-emerald-500/40'
                                    }`}
                            >
                                Kar/Zarar
                            </button>
                        </>
                    )}
                </div>

                {sourceData.length > 0 && (
                    <button
                        type="button"
                        onClick={() => void handleDownloadTemporaryTaxExcel()}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/40 text-blue-200 hover:bg-blue-500/10 transition-colors text-[11px] font-semibold whitespace-nowrap"
                        title="Gecici vergi ciktisini Excel olarak indir"
                    >
                        <Download size={13} />
                        Excel Indir
                    </button>
                )}
            </div>

            {!hasAnyData && (
                <div className="mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Gecici vergi kontrolu icin veri bulunamadi. Once Cari Hesap Kontrol modulunde dosyalari isleyin.
                </div>
            )}

            {hasAnyData && sourceData.length === 0 && (
                <div className="mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Secili kaynakta veri yok. Ustten diger kaynagi secin.
                </div>
            )}

            {sourceData.length > 0 && activeSubModule === 'CONTROL' && (
                <Card className="space-y-5">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {controls.map((control) => {
                            const isActive = selectedControl?.id === control.id;
                            return (
                                <button
                                    key={control.id}
                                    type="button"
                                    onClick={() => setSelectedControlId(control.id)}
                                    className={`text-left rounded-xl border p-4 transition-colors ${isActive
                                        ? 'border-blue-500/50 bg-blue-500/10'
                                        : 'border-slate-700 bg-slate-900/40 hover:border-blue-500/30'
                                        }`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-bold text-white">{control.title}</h3>
                                            <p className="text-xs text-slate-400 mt-1">{control.description}</p>
                                        </div>
                                        <span className={`text-lg font-bold ${control.accounts.length > 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                                            {control.accounts.length}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {selectedControl && (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between gap-3 flex-wrap">
                                <div>
                                    <h4 className="text-base font-semibold text-white">{selectedControl.title}</h4>
                                    <p className="text-xs text-slate-400">{selectedControl.description}</p>
                                </div>
                                <div className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${selectedControl.accounts.length > 0 ? 'bg-red-500/15 text-red-200 border border-red-500/30' : 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30'}`}>
                                    <AlertTriangle size={14} />
                                    {selectedControl.accounts.length} hesap
                                </div>
                            </div>

                            {selectedControl.accounts.length === 0 ? (
                                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
                                    Bu kontrol icin problemli hesap bulunmadi.
                                </div>
                            ) : (
                                <div className="overflow-auto rounded-xl border border-slate-700 bg-slate-900/40">
                                    <table className="w-full text-left border-collapse">
                                        <thead className="bg-slate-800/80 sticky top-0 z-10">
                                            <tr>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Hesap Kodu</th>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Hesap Adi</th>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Kontrol Sonucu</th>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Detay</th>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Bakiye</th>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Hareket</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-800">
                                            {selectedControl.accounts.map((item) => (
                                                <tr
                                                    key={`${selectedControl.id}-${item.account.code}`}
                                                    className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                                                    onClick={() => setSelectedAccountCode(item.account.code)}
                                                    title="Hesap ekstresini ac"
                                                >
                                                    <td className="p-3 text-sm text-blue-300 font-mono">{item.account.code}</td>
                                                    <td className="p-3 text-sm text-slate-200">{item.account.name || '-'}</td>
                                                    <td className="p-3 text-sm text-red-200">{item.reason}</td>
                                                    <td className="p-3 text-sm text-slate-400">{item.detail || '-'}</td>
                                                    <td className="p-3 text-sm text-slate-300 font-mono text-right">{formatCurrency(item.account.balance)}</td>
                                                    <td className="p-3 text-sm text-slate-400 text-right">{item.account.transactionCount}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}
                </Card>
            )}

            {sourceData.length > 0 && activeSubModule === 'PROFIT_LOSS' && (
                <Card className="space-y-5">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div>
                            <h3 className="text-lg font-semibold text-white">Kar/Zarar Analizi</h3>
                            <p className="text-xs text-slate-400 mt-1">
                                6-7 ana hesap dengesi, 689 KKEG, kullanilabilir stok ve gecici vergi kari secilen doneme gore hesaplanir.
                            </p>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                            <select
                                value={String(effectiveProfitLossYear)}
                                onChange={(event) => setSelectedProfitLossYear(Number(event.target.value))}
                                className="h-8 px-2 bg-slate-900 border border-slate-700 rounded-md text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                                title="Yil secimi"
                            >
                                {profitLossYears.length > 0 ? (
                                    profitLossYears.map((year) => (
                                        <option key={year} value={year}>{year}</option>
                                    ))
                                ) : (
                                    <option value={effectiveProfitLossYear}>{effectiveProfitLossYear}</option>
                                )}
                            </select>
                            <select
                                value={selectedProfitLossPeriod}
                                onChange={(event) => setSelectedProfitLossPeriod(event.target.value as ProfitLossPeriod)}
                                className="h-8 px-2 bg-slate-900 border border-slate-700 rounded-md text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                                title="Donem secimi"
                            >
                                {PROFIT_LOSS_PERIOD_OPTIONS.map((periodKey) => (
                                    <option key={periodKey} value={periodKey}>
                                        {PROFIT_LOSS_PERIOD_LABELS[periodKey]}
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                onClick={() => setIsProfitLossCumulative((current) => !current)}
                                disabled={selectedProfitLossPeriod === 'YEARLY'}
                                className={`h-8 px-3 rounded-md border text-xs font-semibold transition-colors ${selectedProfitLossPeriod === 'YEARLY'
                                    ? 'border-slate-700 bg-slate-900/60 text-slate-500 cursor-not-allowed'
                                    : effectiveProfitLossCumulative
                                        ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                                        : 'border-slate-600 bg-slate-900 text-slate-300 hover:border-emerald-500/40'
                                    }`}
                                title="Aciksa secilen ceyregin yil basi-kapanis araligini getirir"
                            >
                                Kumulatif
                            </button>
                            <div className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold border border-blue-500/30 bg-blue-500/10 text-blue-200">
                                {selectedProfitLossPeriodLabel}
                            </div>
                            <div className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border border-slate-700 bg-slate-900/50 text-slate-300">
                                Toplam Ana Hesap: {profitLoss.rows.length}
                            </div>
                        </div>
                    </div>
                    <div className="text-xs text-slate-400">
                        Donem Araligi: {selectedProfitLossDateRangeLabel}
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                        <div className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden">
                            <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/40">
                                <h4 className="text-sm font-semibold text-white">Gelir Tablosu</h4>
                            </div>
                            {profitLoss.rows.length === 0 ? (
                                <div className="p-6 text-sm text-slate-500">
                                    Gelir tablosu kalemlerine (6/7) ait hesap hareketi bulunamadi.
                                </div>
                            ) : (
                                <div className="max-h-[520px] overflow-auto">
                                    <table className="w-full text-left border-collapse">
                                        <thead className="bg-slate-800/70 sticky top-0 z-10">
                                            <tr>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Ana Hesap</th>
                                                <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Bakiye</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-800">
                                            {profitLoss.rows.map((row) => {
                                                const status = resolveBalanceStatus(row.balance);
                                                return (
                                                    <tr key={row.code} className="hover:bg-slate-800/30 transition-colors">
                                                        <td className="p-3 text-sm text-blue-300 font-mono">
                                                            {row.code} <span className="text-slate-400 text-xs ml-2 font-sans">{row.name || '-'}</span>
                                                        </td>
                                                        <td className="p-3 text-sm font-mono text-right">
                                                            <span className={getStatusTextClass(status)}>
                                                                {formatCurrency(Math.abs(row.balance))} {status === 'NOKTA' ? '' : status === 'KAR' ? '(A)' : '(B)'}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        <div className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden">
                            <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/40">
                                <h4 className="text-sm font-semibold text-white">Kar/Zarar Ozet</h4>
                            </div>

                            <div className="divide-y divide-slate-800 text-sm">
                                <div className="p-4 flex items-center justify-between gap-3">
                                    <span className="text-slate-400">6-7 Net Fark</span>
                                    <span className={`font-semibold ${getStatusTextClass(profitLoss.sixSevenStatus)}`}>
                                        {formatCurrency(Math.abs(profitLoss.sixSevenDiff))} {formatStatusText(profitLoss.sixSevenStatus)}
                                    </span>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3">
                                    <span className="text-slate-400">689 KKEG Bakiyesi</span>
                                    <span className={`font-semibold ${getStatusTextClass(resolveBalanceStatus(profitLoss.account689Balance))}`}>
                                        {formatCurrency(Math.abs(profitLoss.account689Balance))} {formatStatusText(resolveBalanceStatus(profitLoss.account689Balance))}
                                    </span>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3">
                                    <span className="text-slate-400">KKEG Dahil Kar/Zarar</span>
                                    <span className={`font-semibold ${getStatusTextClass(profitLoss.kkegIncludedStatus)}`}>
                                        {formatCurrency(Math.abs(profitLoss.kkegIncludedValue))} {formatStatusText(profitLoss.kkegIncludedStatus)}
                                    </span>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3">
                                    <span className="text-slate-400">Kullanilabilir Stok (150+151+152+153+157)</span>
                                    <span className={`font-semibold ${isSmmApplied ? 'text-amber-300' : 'text-blue-300'}`}>
                                        {formatCurrency(profitLoss.stockBalance)}
                                    </span>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3 bg-slate-800/40">
                                    <span className="text-slate-300 font-semibold">Gecici Vergi Kari</span>
                                    <span className={`font-semibold ${getStatusTextClass(profitLoss.temporaryTaxStatus)}`}>
                                        {formatCurrency(Math.abs(profitLoss.temporaryTaxValue))} {formatStatusText(profitLoss.temporaryTaxStatus)}
                                    </span>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3">
                                    <span className="text-slate-400">Hesaplanan Gecici Vergi</span>
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={selectedTaxRate}
                                            onChange={(event) => {
                                                const rate = Number(event.target.value) === 15 ? 15 : 25;
                                                setTaxRateBySource((current) => ({
                                                    ...current,
                                                    [source]: rate,
                                                }));
                                            }}
                                            className="h-8 px-2 bg-slate-900 border border-slate-700 rounded-md text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                                        >
                                            <option value={25}>%25</option>
                                            <option value={15}>%15</option>
                                        </select>
                                        <span className="font-semibold text-emerald-300">
                                            {formatCurrency(Math.abs(calculatedTemporaryTax))}
                                        </span>
                                    </div>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3">
                                    <span className="text-slate-400">Onceki Donem Odenen Gecici Vergi (193)</span>
                                    <div className="flex items-center gap-2">
                                        {isEditingPreviousPaidTax ? (
                                            <>
                                                <input
                                                    type="text"
                                                    value={previousPaidTaxDraft}
                                                    onChange={(event) => setPreviousPaidTaxDraft(event.target.value)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter') {
                                                            event.preventDefault();
                                                            handleSavePreviousPaidTax();
                                                        }
                                                        if (event.key === 'Escape') {
                                                            event.preventDefault();
                                                            handleCancelEditPreviousPaidTax();
                                                        }
                                                    }}
                                                    className="h-8 w-36 px-2 bg-slate-900 border border-slate-700 rounded-md text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                                                    autoFocus
                                                />
                                                <button
                                                    type="button"
                                                    onClick={handleSavePreviousPaidTax}
                                                    className="h-8 px-2 rounded-md border border-emerald-500/40 text-emerald-200 text-xs font-semibold hover:bg-emerald-500/10 transition-colors"
                                                >
                                                    Kaydet
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleCancelEditPreviousPaidTax}
                                                    className="h-8 px-2 rounded-md border border-slate-600 text-slate-300 text-xs font-semibold hover:border-slate-400 transition-colors"
                                                >
                                                    Iptal
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={handleStartEditPreviousPaidTax}
                                                    className="font-semibold text-blue-300 hover:text-blue-200 transition-colors"
                                                    title="Degistirmek icin tiklayin"
                                                >
                                                    {formatCurrency(Math.abs(previousPaidTaxValue))}
                                                </button>
                                                {previousPaidTaxOverrideByContext[selectedProfitLossContextKey] !== undefined && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setPreviousPaidTaxOverrideByContext((current) => {
                                                                const next = { ...current };
                                                                delete next[selectedProfitLossContextKey];
                                                                return next;
                                                            });
                                                        }}
                                                        className="h-7 px-2 rounded-md border border-amber-500/40 text-amber-200 text-[11px] font-semibold hover:bg-amber-500/10 transition-colors"
                                                        title="193 bakiyesine don"
                                                    >
                                                        193'e Don
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3 bg-blue-900/20">
                                    <span className="text-slate-200 font-semibold">Bu Donem Odenecek Gecici Vergi</span>
                                    <span className={`font-semibold ${currentPeriodPayableTax >= -BALANCE_TOLERANCE ? 'text-emerald-300' : 'text-amber-300'}`}>
                                        {formatCurrency(Math.abs(currentPeriodPayableTax))} {currentPeriodPayableTax >= -BALANCE_TOLERANCE ? 'ODENECEK' : 'DEVREDEN'}
                                    </span>
                                </div>
                                <div className="p-4 flex items-center justify-between gap-3">
                                    <div>
                                        <span className="text-slate-400">Gecmis Yil Zarari</span>
                                        <p className="text-[11px] text-slate-500 mt-1">
                                            Firma bazli kalicidir ve 6-7 Net Farktan dusulur.
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {isEditingPriorYearLoss ? (
                                            <>
                                                <input
                                                    type="text"
                                                    value={priorYearLossDraft}
                                                    onChange={(event) => setPriorYearLossDraft(event.target.value)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter') {
                                                            event.preventDefault();
                                                            void handleSavePriorYearLoss();
                                                        }
                                                        if (event.key === 'Escape') {
                                                            event.preventDefault();
                                                            handleCancelEditPriorYearLoss();
                                                        }
                                                    }}
                                                    className="h-8 w-36 px-2 bg-slate-900 border border-slate-700 rounded-md text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                                                    autoFocus
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => void handleSavePriorYearLoss()}
                                                    className="h-8 px-2 rounded-md border border-emerald-500/40 text-emerald-200 text-xs font-semibold hover:bg-emerald-500/10 transition-colors"
                                                >
                                                    Kaydet
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleCancelEditPriorYearLoss}
                                                    className="h-8 px-2 rounded-md border border-slate-600 text-slate-300 text-xs font-semibold hover:border-slate-400 transition-colors"
                                                >
                                                    Iptal
                                                </button>
                                            </>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={handleStartEditPriorYearLoss}
                                                className="font-semibold text-blue-300 hover:text-blue-200 transition-colors"
                                                title="Degistirmek icin tiklayin"
                                            >
                                                {formatCurrency(priorYearLossValue)}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden">
                            <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/40">
                                <h4 className="text-sm font-semibold text-white">SMM Analizi</h4>
                            </div>

                            <div className="divide-y divide-slate-800 text-sm">
                                <div className="p-4 flex items-start justify-between gap-3">
                                    <div>
                                        <span className="text-slate-300 font-semibold">SMM Orani</span>
                                        <p className="text-[11px] text-slate-500 mt-1">
                                            Ref: {smmReferenceLabel}
                                        </p>
                                        <p className="text-[11px] text-slate-500">
                                            A: {formatCurrency(smmRatioAutoMetrics.smmCostAbs)} | B: {formatCurrency(smmRatioAutoMetrics.smmSalesAbs)}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {isEditingSmmRatio ? (
                                            <>
                                                <input
                                                    type="text"
                                                    value={smmRatioDraft}
                                                    onChange={(event) => setSmmRatioDraft(event.target.value)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter') {
                                                            event.preventDefault();
                                                            handleSaveSmmRatio();
                                                        }
                                                        if (event.key === 'Escape') {
                                                            event.preventDefault();
                                                            handleCancelEditSmmRatio();
                                                        }
                                                    }}
                                                    className="h-8 w-24 px-2 bg-slate-900 border border-slate-700 rounded-md text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                                                    autoFocus
                                                />
                                                <button
                                                    type="button"
                                                    onClick={handleSaveSmmRatio}
                                                    className="h-8 px-2 rounded-md border border-emerald-500/40 text-emerald-200 text-xs font-semibold hover:bg-emerald-500/10 transition-colors"
                                                >
                                                    Kaydet
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleCancelEditSmmRatio}
                                                    className="h-8 px-2 rounded-md border border-slate-600 text-slate-300 text-xs font-semibold hover:border-slate-400 transition-colors"
                                                >
                                                    Iptal
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={handleStartEditSmmRatio}
                                                    className="font-semibold text-blue-300 hover:text-blue-200 transition-colors"
                                                    title="Degistirmek icin tiklayin"
                                                >
                                                    %{formatPercent(smmRatioValue)}
                                                </button>
                                                {smmRatioOverrideByContext[selectedSmmRatioContextKey] !== undefined && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setSmmRatioOverrideByContext((current) => {
                                                                const next = { ...current };
                                                                delete next[selectedSmmRatioContextKey];
                                                                return next;
                                                            });
                                                        }}
                                                        className="h-7 px-2 rounded-md border border-amber-500/40 text-amber-200 text-[11px] font-semibold hover:bg-amber-500/10 transition-colors"
                                                        title="Otomatik orana don"
                                                    >
                                                        Otomatige Don
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>

                                <div className="p-4 flex items-center justify-between gap-3">
                                    <span className="text-slate-400">Ciro (600+601+602)</span>
                                    <span className="font-semibold text-cyan-300">
                                        {formatCurrency(ciroMetrics.ciroAbs)}
                                    </span>
                                </div>

                                <div className="p-4 flex items-center justify-between gap-3 bg-blue-900/20">
                                    <div>
                                        <span className="text-slate-200 font-semibold">Bu Donem Maliyet Atilacak</span>
                                        <p className="text-[11px] text-slate-500 mt-1">
                                            ({formatCurrency(ciroMetrics.ciroAbs)} x %{formatPercent(smmRatioValue)}) - {formatCurrency(ciroMetrics.currentCostAbs)}
                                        </p>
                                    </div>
                                    <span className={`font-semibold ${ciroMetrics.currentPeriodCostToPost >= -BALANCE_TOLERANCE ? 'text-emerald-300' : 'text-amber-300'}`}>
                                        {formatCurrency(ciroMetrics.currentPeriodCostToPost)}
                                    </span>
                                </div>
                                {ciroMetrics.isCappedByStock && (
                                    <div className="p-4 bg-amber-500/10 border-t border-amber-500/20">
                                        <p className="text-xs text-amber-200 font-semibold">
                                            Stok normal maliyete yetmiyor
                                        </p>
                                        <p className="text-[11px] text-amber-100/80 mt-1">
                                            Normal: {formatCurrency(ciroMetrics.normalCurrentPeriodCostToPost)} | Kullanilabilir Stok: {formatCurrency(ciroMetrics.availableStockForCost)}
                                        </p>
                                    </div>
                                )}

                                <div className="p-4 flex items-center justify-between gap-3">
                                    <p className="text-[11px] text-slate-500">
                                        Uygulanirsa: 6-7 Net Fark - Bu Donem Maliyet Atilacak, Kullanilabilir Stok = 0
                                    </p>
                                    <button
                                        type="button"
                                        onClick={handleToggleSmmApply}
                                        className={`h-8 px-3 rounded-md border text-xs font-semibold transition-colors ${isSmmApplied
                                            ? 'border-amber-500/40 text-amber-200 hover:bg-amber-500/10'
                                            : 'border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10'
                                            }`}
                                    >
                                        {isSmmApplied ? 'Geri Al' : 'Uygula'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </Card>
            )}

            <AccountStatementModal
                source={source}
                account={selectedAccount}
                isForexAccount={selectedAccountForexType?.isForex || false}
                inferredCurrency={selectedAccountForexType?.inferredCurrency}
                accountTypeSource={selectedAccountForexType?.source}
                inferenceReason={selectedAccountForexType?.reason}
                rowIssueByIndex={selectedAccountRowIssues}
                onAccountTypeChange={handleAccountTypeChange}
                onClose={() => setSelectedAccountCode(null)}
                onVoucherClick={(voucherNo) => setSelectedVoucherNo(voucherNo)}
            />

            <VoucherDetailModal
                source={source}
                voucherNo={selectedVoucherNo}
                rows={voucherRows}
                accountOptions={voucherAccountOptions}
                onVoucherChange={(nextVoucherNo) => setSelectedVoucherNo(nextVoucherNo)}
                onRowEdit={handleVoucherRowEdit}
                onBatchRowEdit={handleVoucherRowEditBatch}
                onAddRow={handleVoucherRowAdd}
                onClose={() => setSelectedVoucherNo(null)}
            />
        </div>
    );
}

export default function TemporaryTaxPage() {
    const { activeCompany } = useCompany();

    if (!activeCompany) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center animate-fade-in">
                <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center mb-6">
                    <Layers className="text-slate-600 w-12 h-12" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Firma secimi gerekli</h2>
                <p className="text-slate-400 max-w-md">
                    Gecici vergi modulu icin lutfen once firma secin.
                </p>
            </div>
        );
    }

    return <TemporaryTaxContent key={activeCompany.id} activeCompany={activeCompany} />;
}
