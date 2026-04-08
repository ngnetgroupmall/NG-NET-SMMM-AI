import { useMemo, useState } from 'react';
import { AlertTriangle, Building2, Download, Layers, Search, UserRound } from 'lucide-react';

import { useCompany } from '../../context/CompanyContext';
import type { AccountDetail, Company, MappingConfig } from '../common/types';
import {
    applyVoucherEditsToAccounts,
    appendVoucherRowToAccounts,
    filterCurrentAccountScopeData,
    type VoucherAddRowRequest,
    type VoucherEditRequest,
} from '../common/voucherEditService';
import { getMainAccountCode, resolveAccountBalanceRule, type ExpectedBalanceSide } from './accountingRules';
import { resolveForexAccountType } from './forexAccountRules';
import AccountStatementModal from './components/AccountStatementModal';
import VoucherDetailModal, {
    type VoucherAccountOption,
    type VoucherDetailRow,
    type VoucherMutationResponse,
} from './components/VoucherDetailModal';
import { formatCurrency } from '../../utils/formatters';
import { matchesSearchAcrossFields } from '../../utils/search';
import {
    round2,
    normalizeVoucherNo,
    parseDateInput,
    isTransactionInDateRange,
    getTransactionAmount,
    BALANCE_TOLERANCE,
} from '../../utils/accounting';
import {
    normalizeAccountDisplayName,
    resolveMainAccountStandardName,
    resolveMainOrIntermediateAccountName,
} from './accountNameResolver';

type MizanSource = 'FIRMA' | 'SMMM';
type ActualBalanceSide = 'BORC' | 'ALACAK' | 'KAPALI';
type AccountTypeMode = 'TL' | 'FOREX' | 'AUTO';
type ApprovalFilter = 'ALL' | 'APPROVED' | 'UNAPPROVED';

interface EvaluatedAccount {
    account: AccountDetail;
    mainCode: string;
    mainName: string;
    actualSide: ActualBalanceSide;
    expectedSide: ExpectedBalanceSide;
    section: string;
    isMismatch: boolean;
    isApproved: boolean;
    indentLevel?: number;
    isGenerated?: boolean;
}

const EMPTY_ACCOUNTS: AccountDetail[] = [];
const EMPTY_FOREX_OVERRIDES: Record<string, boolean> = {};
const EMPTY_APPROVALS: Record<string, boolean> = {};

const getMizanApprovalKey = (source: MizanSource, accountCode: string): string => {
    return `${source}:${String(accountCode || '').trim().toLocaleUpperCase('tr-TR')}`;
};

const getActualBalanceSide = (balance: number): ActualBalanceSide => {
    if (Math.abs(balance) <= BALANCE_TOLERANCE) return 'KAPALI';
    return balance > 0 ? 'BORC' : 'ALACAK';
};

function MizanContent({ activeCompany }: { activeCompany: Company }) {
    const { patchActiveCompany } = useCompany();
    const [selectedSource, setSelectedSource] = useState<MizanSource>('FIRMA');
    const [search, setSearch] = useState('');
    const [showOnlyMismatched, setShowOnlyMismatched] = useState(false);
    const [approvalFilter, setApprovalFilter] = useState<ApprovalFilter>('ALL');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [selectedAccountCode, setSelectedAccountCode] = useState<string | null>(null);
    const [selectedVoucherNo, setSelectedVoucherNo] = useState<string | null>(null);



    const firmaData = activeCompany.currentAccount?.firmaFullData ?? EMPTY_ACCOUNTS;
    const smmmData = activeCompany.currentAccount?.smmmFullData ?? EMPTY_ACCOUNTS;
    const forexOverrides = activeCompany.currentAccount?.forexAccountOverrides ?? EMPTY_FOREX_OVERRIDES;
    const mizanApprovals = activeCompany.currentAccount?.mizanApprovals ?? EMPTY_APPROVALS;

    const source = useMemo<MizanSource>(() => {
        if (selectedSource === 'FIRMA' && firmaData.length > 0) return 'FIRMA';
        if (selectedSource === 'SMMM' && smmmData.length > 0) return 'SMMM';
        if (firmaData.length > 0) return 'FIRMA';
        if (smmmData.length > 0) return 'SMMM';
        return selectedSource;
    }, [selectedSource, firmaData.length, smmmData.length]);

    const sourceData = useMemo(() => {
        return source === 'FIRMA' ? firmaData : smmmData;
    }, [source, firmaData, smmmData]);

    const filterDateFrom = useMemo(() => parseDateInput(dateFrom, false), [dateFrom]);
    const filterDateTo = useMemo(() => parseDateInput(dateTo, true), [dateTo]);
    const hasDateRangeFilter = Boolean(filterDateFrom || filterDateTo);
    const hasInvalidDateRange = Boolean(filterDateFrom && filterDateTo && filterDateFrom.getTime() > filterDateTo.getTime());

    const scopedSourceData = useMemo<AccountDetail[]>(() => {
        if (!hasDateRangeFilter) return sourceData;
        if (hasInvalidDateRange) return [];

        return sourceData
            .map((account) => {
                const scopedTransactions = account.transactions.filter((transaction) => (
                    isTransactionInDateRange(transaction.date, filterDateFrom, filterDateTo)
                ));
                const totalDebit = round2(scopedTransactions.reduce((sum, transaction) => sum + getTransactionAmount(transaction.debit), 0));
                const totalCredit = round2(scopedTransactions.reduce((sum, transaction) => sum + getTransactionAmount(transaction.credit), 0));
                const balance = round2(totalDebit - totalCredit);

                return {
                    ...account,
                    transactions: scopedTransactions,
                    totalDebit,
                    totalCredit,
                    balance,
                    transactionCount: scopedTransactions.length,
                };
            })
            .filter((account) => (
                account.transactionCount > 0 ||
                Math.abs(account.totalDebit) > BALANCE_TOLERANCE ||
                Math.abs(account.totalCredit) > BALANCE_TOLERANCE
            ));
    }, [sourceData, hasDateRangeFilter, hasInvalidDateRange, filterDateFrom, filterDateTo]);

    const evaluatedAccounts = useMemo<EvaluatedAccount[]>(() => {
        const map = new Map<string, AccountDetail>();
        const hierarchyKeys = new Set<string>();
        const leafCodeSet = new Set<string>();

        // 1. Populate map with existing detail accounts
        scopedSourceData.forEach((account) => {
            map.set(account.code, { ...account });
            hierarchyKeys.add(account.code);
            leafCodeSet.add(account.code);
        });

        // 2. Generate hierarchy keys (parents)
        scopedSourceData.forEach((account) => {
            const parts = account.code.split('.');
            // e.g. 100.01.001 -> parents: 100, 100.01
            // e.g. 120 -> parent: none (it is main)

            // First, handled Main Account (3 digits)
            const mainCode = getMainAccountCode(account.code);
            if (mainCode && mainCode !== account.code) {
                hierarchyKeys.add(mainCode);
            }

            // Handle Intermediate Sub Accounts (Ara Hesap)
            // We assume '.' separator. If 120.01.001, we want 120.01
            let currentCode = '';
            for (let i = 0; i < parts.length - 1; i++) {
                currentCode = currentCode ? `${currentCode}.${parts[i]}` : parts[i];
                if (currentCode !== mainCode) { // Avoid duplicating main code processing
                    hierarchyKeys.add(currentCode);
                }
            }
        });

        // 3. Create missing parent accounts and aggregate totals
        hierarchyKeys.forEach(key => {
            if (!map.has(key)) {
                map.set(key, {
                    code: key,
                    name: '', // Will resolve later
                    balance: 0,
                    totalDebit: 0,
                    totalCredit: 0,
                    transactionCount: 0,
                    transactions: [],
                    vkn: '',
                });
            }
        });

        // Aggregate
        scopedSourceData.forEach((leaf) => {
            const parts = leaf.code.split('.');
            const mainCode = getMainAccountCode(leaf.code);

            // Add to Main
            if (mainCode && mainCode !== leaf.code && map.has(mainCode)) {
                const parent = map.get(mainCode)!;
                parent.totalDebit = round2(parent.totalDebit + leaf.totalDebit);
                parent.totalCredit = round2(parent.totalCredit + leaf.totalCredit);
                parent.balance = round2(parent.balance + leaf.balance);
                parent.transactionCount += leaf.transactionCount;
            }

            // Add to Sub-levels
            let currentCode = '';
            for (let i = 0; i < parts.length - 1; i++) {
                currentCode = currentCode ? `${currentCode}.${parts[i]}` : parts[i];
                if (currentCode !== mainCode && map.has(currentCode)) {
                    const parent = map.get(currentCode)!;
                    parent.totalDebit = round2(parent.totalDebit + leaf.totalDebit);
                    parent.totalCredit = round2(parent.totalCredit + leaf.totalCredit);
                    parent.balance = round2(parent.balance + leaf.balance);
                    parent.transactionCount += leaf.transactionCount;
                }
            }
        });

        // 4. Resolve Names and Sort
        const result: EvaluatedAccount[] = [];
        const sortedKeys = Array.from(hierarchyKeys).sort((a, b) => a.localeCompare(b, 'tr-TR'));

        sortedKeys.forEach(key => {
            const account = map.get(key)!;
            const mainCode = getMainAccountCode(key);
            const isLeaf = leafCodeSet.has(key);
            const depth = key.includes('.')
                ? key.split('.').map((part) => part.trim()).filter(Boolean).length
                : (key.replace(/\D/g, '').length <= 3 ? 1 : 2);

            // Ana ve ara hesaplarda adlari TDHP standardindan zorunlu getiriyoruz.
            // Alt hesaplarda varsa mevcut isim kullaniliyor, yoksa standart fallback devreye giriyor.
            const normalizedExistingName = normalizeAccountDisplayName(account.name || '');
            const resolvedName = (!isLeaf || depth <= 2)
                ? resolveMainOrIntermediateAccountName(key, normalizedExistingName)
                : (normalizedExistingName || resolveMainOrIntermediateAccountName(key, normalizedExistingName));
            const resolvedMainName = resolveMainAccountStandardName(mainCode, normalizedExistingName) || resolvedName;

            account.name = resolvedName;

            const rule = resolveAccountBalanceRule(key); // Check rule for this level
            const actualSide = getActualBalanceSide(account.balance);
            const expectedSide = rule?.expectedBalance || 'FARK_ETMEZ';
            const section = rule?.section || '-';
            const isMismatch = (
                expectedSide !== 'FARK_ETMEZ' &&
                actualSide !== 'KAPALI' &&
                actualSide !== expectedSide
            );
            const isApproved = Boolean(mizanApprovals[getMizanApprovalKey(source, key)]);

            // Determine Indent Level
            let indentLevel = 0;
            if (key !== mainCode) {
                const parts = key.split('.');
                // If 100.01 -> 2 parts -> level 1?
                // If 100.01.001 -> 3 parts -> level 2
                // Base is 1 part (100) -> level 0
                indentLevel = parts.length > 1 ? parts.length - 1 : 1;
                // Fallback
                if (!key.includes('.')) {
                    indentLevel = key.length > 3 ? 1 : 0;
                }
            } else {
                indentLevel = 0;
            }

            result.push({
                account,
                mainCode,
                mainName: resolvedMainName,
                actualSide,
                expectedSide,
                section,
                isMismatch,
                isApproved,
                indentLevel,
                isGenerated: !isLeaf
            });
        });

        return result;
    }, [scopedSourceData, mizanApprovals, source]);

    const approvedCount = useMemo(() => {
        return evaluatedAccounts.filter((row) => row.isApproved).length;
    }, [evaluatedAccounts]);

    const totalEvaluatedCount = evaluatedAccounts.length;

    const visibleAccounts = useMemo(() => {
        const query = search.trim();

        return evaluatedAccounts.filter((row) => {
            if (showOnlyMismatched && !row.isMismatch) return false;
            if (approvalFilter === 'APPROVED' && !row.isApproved) return false;
            if (approvalFilter === 'UNAPPROVED' && row.isApproved) return false;

            return matchesSearchAcrossFields(query, [
                row.account.code,
                row.account.name,
                row.mainCode,
                row.mainName,
                row.expectedSide,
                row.section,
            ]);
        });
    }, [evaluatedAccounts, search, showOnlyMismatched, approvalFilter]);

    const mismatchCount = useMemo(() => {
        return evaluatedAccounts.filter((row) => row.isMismatch).length;
    }, [evaluatedAccounts]);

    const selectedAccount = useMemo(() => {
        if (!selectedAccountCode) return null;
        return sourceData.find((account) => account.code === selectedAccountCode) || null;
    }, [sourceData, selectedAccountCode]);

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

    const handleAccountApprovalToggle = async (accountCode: string, currentlyApproved: boolean) => {
        const approvalKey = getMizanApprovalKey(source, accountCode);

        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount || {
                smmmData: [] as AccountDetail[],
                firmaData: [] as AccountDetail[],
                mappings: {} as MappingConfig,
            };

            const nextApprovals = {
                ...(currentAccount.mizanApprovals || {}),
            };

            if (currentlyApproved) {
                delete nextApprovals[approvalKey];
            } else {
                nextApprovals[approvalKey] = true;
            }

            return {
                currentAccount: {
                    ...currentAccount,
                    mizanApprovals: nextApprovals,
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

    const handleDownloadMizanExcel = async () => {
        const XLSX = await import('xlsx');
        const { applyStyledSheet } = await import('../../utils/excelStyle');

        const rows = visibleAccounts.map((row) => ({
            'Hesap Kodu': row.account.code,
            'Hesap Adi': row.account.name || '',
            Borc: row.account.totalDebit,
            Alacak: row.account.totalCredit,
            Bakiye: Math.abs(row.account.balance),
            'Bakiye Yonu': row.account.balance >= 0 ? 'Borc (B)' : 'Alacak (A)',
            'Beklenen Yon': row.expectedSide,
            'Gerceklesen Yon': row.actualSide,
            Bilanco: row.section,
            Uyumsuz: row.isMismatch ? 'Evet' : 'Hayir',
            Onay: row.isApproved ? 'Onayli' : 'Onaysiz',
            Hareket: row.account.transactionCount,
        }));

        const worksheet = XLSX.utils.json_to_sheet(rows);
        applyStyledSheet(worksheet, { headerRowIndex: 0, numericColumns: [2, 3, 4, 11] });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Mizan');

        const datePart = new Date().toISOString().slice(0, 10);
        const safeSource = source.toLocaleLowerCase('tr-TR').replace(/[^\w.-]+/g, '_');
        const dateFilterSuffix = hasDateRangeFilter
            ? `_filtreli${dateFrom ? `_from_${dateFrom}` : ''}${dateTo ? `_to_${dateTo}` : ''}`
            : '';
        XLSX.writeFile(workbook, `mizan_${safeSource}_${datePart}${dateFilterSuffix}.xlsx`);
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

    const summary = useMemo(() => {
        return scopedSourceData.reduce(
            (accumulator, account) => {
                accumulator.totalDebit += account.totalDebit;
                accumulator.totalCredit += account.totalCredit;
                accumulator.totalTransactions += account.transactionCount;
                return accumulator;
            },
            { totalDebit: 0, totalCredit: 0, totalTransactions: 0 }
        );
    }, [scopedSourceData]);

    const hasAnyData = firmaData.length > 0 || smmmData.length > 0;

    return (
        <div className="animate-fade-in flex flex-col gap-0">
            {/* ── Compact Toolbar Row 1: Source + Stats ── */}
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-sm font-bold text-white uppercase tracking-wide">Mizan</h1>
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
                </div>

                {sourceData.length > 0 && (
                    <div className="flex items-center gap-4 text-xs">
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Hesap</span>
                            <span className="text-white font-semibold">{totalEvaluatedCount}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Borc</span>
                            <span className="text-emerald-300 font-semibold">{formatCurrency(summary.totalDebit)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Alacak</span>
                            <span className="text-rose-300 font-semibold">{formatCurrency(summary.totalCredit)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Uyumsuz</span>
                            <span className={`font-semibold ${mismatchCount > 0 ? 'text-red-300' : 'text-slate-400'}`}>{mismatchCount}</span>
                        </div>
                    </div>
                )}
            </div>

            {!hasAnyData && (
                <div className="mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Mizan verisi bulunamadi. Once Cari Hesap Kontrol modulunde dosyalari isleyin.
                </div>
            )}

            {hasAnyData && sourceData.length === 0 && (
                <div className="mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Secili kaynakta veri yok. Ustten diger kaynagi secin.
                </div>
            )}

            {sourceData.length > 0 && (
                <>
                    {/* ── Compact Toolbar Row 2: Filters + Search + Excel ── */}
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/20 border-b border-slate-700/40">
                        <button
                            type="button"
                            onClick={() => setShowOnlyMismatched((value) => !value)}
                            className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold whitespace-nowrap transition-colors ${showOnlyMismatched
                                ? 'bg-red-600/20 border-red-500/40 text-red-200'
                                : 'bg-slate-900/50 border-slate-700 text-slate-300 hover:border-red-400/40'
                                }`}
                        >
                            <span className="inline-flex items-center gap-1">
                                <AlertTriangle size={12} />
                                {showOnlyMismatched ? 'Tumunu Goster' : 'Sadece Uyumsuzlar'}
                            </span>
                        </button>

                        <select
                            value={approvalFilter}
                            onChange={(event) => setApprovalFilter(event.target.value as ApprovalFilter)}
                            className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
                            title="Onay durumuna gore filtrele"
                        >
                            <option value="ALL">Tum Hesaplar ({totalEvaluatedCount})</option>
                            <option value="APPROVED">Onayli ({approvedCount})</option>
                            <option value="UNAPPROVED">Onaysiz ({Math.max(totalEvaluatedCount - approvedCount, 0)})</option>
                        </select>

                        <input
                            type="date"
                            value={dateFrom}
                            onChange={(event) => setDateFrom(event.target.value)}
                            max={dateTo || undefined}
                            className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-slate-200 focus:outline-none focus:border-blue-500 w-[120px]"
                            title="Baslangic tarihi"
                        />
                        <input
                            type="date"
                            value={dateTo}
                            onChange={(event) => setDateTo(event.target.value)}
                            min={dateFrom || undefined}
                            className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-slate-200 focus:outline-none focus:border-blue-500 w-[120px]"
                            title="Bitis tarihi"
                        />
                        {(dateFrom || dateTo) && (
                            <button
                                type="button"
                                onClick={() => { setDateFrom(''); setDateTo(''); }}
                                className="px-2 py-1 rounded-lg border border-slate-700 bg-slate-900/60 text-[10px] font-semibold text-slate-300 hover:border-slate-500 transition-colors"
                            >
                                Tarih Temizle
                            </button>
                        )}

                        <div className="relative flex-1 max-w-xs">
                            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                            <input
                                type="text"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Hesap kodu/adi ara (orn: 6*, 60*)"
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                            />
                        </div>

                        <button
                            type="button"
                            onClick={() => void handleDownloadMizanExcel()}
                            disabled={visibleAccounts.length === 0 || hasInvalidDateRange}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/40 text-blue-200 hover:bg-blue-500/10 transition-colors text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ml-auto"
                        >
                            <Download size={13} />
                            Excel Indir
                        </button>
                    </div>

                        <div className="overflow-auto rounded-xl border border-slate-700 bg-slate-900/40">
                            {hasInvalidDateRange && (
                                <div className="m-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                                    Baslangic tarihi, bitis tarihinden buyuk olamaz.
                                </div>
                            )}
                            <table className="w-full text-left border-collapse">
                                <thead className="bg-slate-800/80 sticky top-0 z-10">
                                    <tr>
                                        <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Hesap Kodu</th>
                                        <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Hesap Adi</th>
                                        <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Borc</th>
                                        <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Alacak</th>
                                        <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Bakiye</th>
                                        <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Hareket</th>
                                        <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Onay</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                    {visibleAccounts.map((row) => (
                                        <tr
                                            key={`${source}-${row.account.code}`}
                                            className={`${row.isApproved
                                                ? 'bg-emerald-500/10 hover:bg-emerald-500/15'
                                                : row.isMismatch
                                                    ? 'bg-red-500/10 hover:bg-red-500/15'
                                                    : 'hover:bg-slate-800/40'
                                                } transition-colors cursor-pointer`}
                                            onClick={() => setSelectedAccountCode(row.account.code)}
                                            title={`Hesap ekstresini ac | Beklenen: ${row.expectedSide} | Gerceklesen: ${row.actualSide} | Bilanco: ${row.section}`}
                                        >
                                            <td className="p-3 text-sm text-blue-300 font-mono">{row.account.code}</td>
                                            <td className="p-3 text-sm text-slate-200">{row.account.name || '-'}</td>
                                            <td className="p-3 text-sm text-slate-300 font-mono text-right">{formatCurrency(row.account.totalDebit)}</td>
                                            <td className="p-3 text-sm text-slate-300 font-mono text-right">{formatCurrency(row.account.totalCredit)}</td>
                                            <td className="p-3 text-sm font-mono text-right">
                                                <span className={row.account.balance >= 0 ? 'text-blue-300' : 'text-amber-300'}>
                                                    {formatCurrency(Math.abs(row.account.balance))} {row.account.balance >= 0 ? '(B)' : '(A)'}
                                                </span>
                                            </td>
                                            <td className="p-3 text-sm text-slate-400 text-right">{row.account.transactionCount}</td>
                                            <td className="p-3 text-right">
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        void handleAccountApprovalToggle(row.account.code, row.isApproved);
                                                    }}
                                                    className={`px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors ${row.isApproved
                                                        ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-200 hover:bg-emerald-600/30'
                                                        : 'bg-slate-900/60 border-slate-700 text-slate-300 hover:border-emerald-500/50 hover:text-emerald-200'
                                                        }`}
                                                >
                                                    {row.isApproved ? 'Onaylandi' : 'Onayla'}
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {visibleAccounts.length === 0 && (
                                        <tr>
                                            <td colSpan={7} className="p-10 text-center text-slate-500">
                                                Kriterlere uygun hesap bulunamadi.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {mismatchCount > 0 && (
                            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
                                <span className="font-semibold">{mismatchCount}</span> hesap, beklenen bakiye yonu kuralina uymuyor. Bu satirlar tabloda kirmizi renkle gosterilir.
                            </div>
                        )}
                    </> /* Fragment close for sourceData > 0 */
                )}

            {
                selectedAccountCode && (
                    <AccountStatementModal
                        source={source}
                        account={selectedAccount}
                        isForexAccount={selectedAccountForexType?.isForex || false}
                        inferredCurrency={selectedAccountForexType?.inferredCurrency}
                        accountTypeSource={selectedAccountForexType?.source}
                        inferenceReason={selectedAccountForexType?.reason}
                        onAccountTypeChange={handleAccountTypeChange}
                        onClose={() => setSelectedAccountCode(null)}
                        onVoucherClick={(voucherNo) => setSelectedVoucherNo(voucherNo)}
                    />
                )
            }

            {
                selectedVoucherNo && (
                    <VoucherDetailModal
                        source={source}
                        voucherNo={selectedVoucherNo}
                        rows={voucherRows}
                        accountOptions={voucherAccountOptions}
                        onClose={() => setSelectedVoucherNo(null)}
                        onVoucherChange={(nextVoucherNo) => setSelectedVoucherNo(nextVoucherNo)}
                        onRowEdit={handleVoucherRowEdit}
                        onBatchRowEdit={handleVoucherRowEditBatch}
                        onAddRow={handleVoucherRowAdd}
                    />
                )
            }
        </div >
    );
}

export default function MizanPage() {
    const { activeCompany } = useCompany();

    if (!activeCompany) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center animate-fade-in">
                <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center mb-6">
                    <Layers className="text-slate-600 w-12 h-12" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Firma secimi gerekli</h2>
                <p className="text-slate-400 max-w-md">
                    Mizan modulu icin lutfen once firma secin.
                </p>
            </div>
        );
    }

    return <MizanContent key={activeCompany.id} activeCompany={activeCompany} />;
}
