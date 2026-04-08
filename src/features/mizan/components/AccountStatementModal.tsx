import { Calendar, ChevronDown, ChevronUp, Download, FileText, Minus, Search, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import type { AccountDetail, Transaction, VoucherEditSource } from '../../common/types';
import { useCompany } from '../../../context/CompanyContext';
import { useEscapeKey } from '../../../hooks/useEscapeKey';
import { formatCurrency, formatDate, formatFxNumber } from '../../../utils/formatters';
import { matchesSearchAcrossFields } from '../../../utils/search';

type AccountTypeMode = 'TL' | 'FOREX' | 'AUTO';
type AccountTypeSource = 'INFERRED' | 'MANUAL';

export interface AccountStatementRowIssue {
    code: string;
    message: string;
}

interface AccountStatementModalProps {
    source: VoucherEditSource;
    account: AccountDetail | null;
    isForexAccount: boolean;
    inferredCurrency?: string;
    accountTypeSource?: AccountTypeSource;
    inferenceReason?: string;
    rowIssueByIndex?: Record<number, AccountStatementRowIssue>;
    onAccountTypeChange?: (mode: AccountTypeMode) => void;
    onClose: () => void;
    onVoucherClick: (voucherNo: string) => void;
}

const getFxMovement = (fxDebit: number | undefined, fxCredit: number | undefined): number => {
    const debit = typeof fxDebit === 'number' ? fxDebit : 0;
    const credit = typeof fxCredit === 'number' ? fxCredit : 0;
    return debit - credit;
};

const formatSignedFxMovement = (fxDebit: number | undefined, fxCredit: number | undefined): string => {
    const movement = getFxMovement(fxDebit, fxCredit);
    if (Math.abs(movement) < 0.0001) return '';
    const sign = movement > 0 ? '+' : '-';
    return `${sign}${formatFxNumber(Math.abs(movement))}`;
};

const normalizeCurrencyCode = (currencyCode: string | undefined): string => {
    return String(currencyCode || '').trim().toLocaleUpperCase('tr-TR');
};

const isTlCurrencyCode = (currencyCode: string | undefined): boolean => {
    const normalized = normalizeCurrencyCode(currencyCode);
    if (!normalized) return false;
    return normalized === 'TL' || normalized.includes('TRY');
};

const resolveDisplayForexCurrency = (
    transactionCurrencyCode: string | undefined,
    inferredCurrency: string | undefined,
    hasFxData: boolean
): string => {
    if (!hasFxData) return '';
    const normalized = normalizeCurrencyCode(transactionCurrencyCode);
    if (normalized && !isTlCurrencyCode(normalized)) return normalized;
    return inferredCurrency || '';
};

const normalizeAccountCode = (value: string | undefined): string => {
    return String(value || '').trim().replace(/\s+/g, '').toLocaleUpperCase('tr-TR');
};

const normalizeVoucherNo = (value: string | undefined): string => {
    return String(value || '').trim().replace(/\s+/g, '').toLocaleUpperCase('tr-TR');
};

const formatDateKey = (value: Date | null | undefined): string => {
    if (!value) return '';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};

const normalizeDescriptionKey = (value: string | undefined): string => {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
};

const roundForKey = (value: number | undefined): string => {
    return Number((value || 0).toFixed(4)).toString();
};

const buildTransactionFingerprint = (transaction: Transaction, originalIndex: number): string => {
    const voucherNo = normalizeVoucherNo(transaction.voucherNo);
    const documentNo = normalizeVoucherNo(transaction.documentNo) || voucherNo;
    const dateKey = formatDateKey(transaction.date);
    const description = normalizeDescriptionKey(transaction.description);
    const debitKey = roundForKey(transaction.debit);
    const creditKey = roundForKey(transaction.credit);
    return `${originalIndex}|${dateKey}|${voucherNo}|${documentNo}|${debitKey}|${creditKey}|${description}`;
};

const getStatementRowApprovalKey = (
    source: VoucherEditSource,
    accountCode: string,
    transaction: Transaction,
    originalIndex: number
): string => {
    const transactionKey = transaction.id || buildTransactionFingerprint(transaction, originalIndex);
    return `${source}:${normalizeAccountCode(accountCode)}:${transactionKey}`;
};

/* ─── Sort helpers ─── */
type SortKey = 'date' | 'voucherNo' | 'documentNo' | 'description' | 'debit' | 'credit' | 'balance' | 'fxMovement' | 'fxBalance';
type SortDir = 'asc' | 'desc';

const toDateTs = (d: Date | null | undefined): number => {
    if (!d) return 0;
    const parsed = new Date(d);
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};


/* ─── SortIcon extracted to file-level to avoid re-creation each render ─── */
function SortIcon({ columnKey, activeKey, activeDir }: { columnKey: SortKey; activeKey: SortKey | null; activeDir: SortDir }) {
    if (activeKey !== columnKey) return <ChevronDown size={12} className="text-slate-600 ml-1 inline" />;
    return activeDir === 'asc'
        ? <ChevronUp size={12} className="text-blue-400 ml-1 inline" />
        : <ChevronDown size={12} className="text-blue-400 ml-1 inline" />;
}

export default function AccountStatementModal({
    source,
    account,
    isForexAccount,
    inferredCurrency,
    accountTypeSource = 'INFERRED',
    inferenceReason,
    rowIssueByIndex,
    onAccountTypeChange,
    onClose,
    onVoucherClick,
}: AccountStatementModalProps) {
    const { activeCompany, patchActiveCompany } = useCompany();

    /* ── All hooks BEFORE any early return (React rules of hooks) ── */
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [sortKey, setSortKey] = useState<SortKey | null>(null);
    const [sortDir, setSortDir] = useState<SortDir>('asc');
    const [selectedRowIndexes, setSelectedRowIndexes] = useState<Record<number, boolean>>({});
    const [approvalHistory, setApprovalHistory] = useState<string[][]>([]);
    const [isPersistingApprovals, setIsPersistingApprovals] = useState(false);
    const [isMinimized, setIsMinimized] = useState(false);
    const persistedRowApprovals = activeCompany?.currentAccount?.accountStatementRowApprovals || {};
    useEscapeKey(onClose, !!account && !isMinimized);

    useEffect(() => {
        setSelectedRowIndexes({});
        setApprovalHistory([]);
        setIsMinimized(false);
    }, [account, source]);

    /* Build indexed transactions so we keep the original rowIssueByIndex mapping */
    const indexedTransactions = useMemo(() => {
        if (!account) return [];
        return account.transactions.map((t, i) => ({ transaction: t, originalIndex: i }));
    }, [account]);

    /* Filter + Sort */
    const filteredSortedTransactions = useMemo(() => {
        let items = [...indexedTransactions];

        // Date filter
        if (dateFrom) {
            const fromTs = new Date(dateFrom).getTime();
            if (!Number.isNaN(fromTs)) {
                items = items.filter(({ transaction }) => toDateTs(transaction.date) >= fromTs);
            }
        }
        if (dateTo) {
            const toTs = new Date(dateTo).getTime() + 86400000 - 1; // end of day
            if (!Number.isNaN(toTs)) {
                items = items.filter(({ transaction }) => toDateTs(transaction.date) <= toTs);
            }
        }

        // Text search — use ?? instead of || so zero values are not lost (Bug 4 fix)
        const query = searchQuery.trim();
        if (query) {
            items = items.filter(({ transaction, originalIndex }) => {
                const voucherNo = String(transaction.voucherNo ?? '');
                const documentNo = String(transaction.documentNo ?? '') || voucherNo;
                const desc = String(transaction.description ?? '');
                const rowIssue = rowIssueByIndex?.[originalIndex];
                const issueText = rowIssue ? `${rowIssue.code} ${rowIssue.message}` : '';
                return matchesSearchAcrossFields(query, [
                    formatDate(transaction.date),
                    voucherNo,
                    documentNo,
                    desc,
                    issueText,
                    String(transaction.debit),
                    String(transaction.credit),
                    String(transaction.balance ?? ''),
                ]);
            });
        }

        // Sort
        if (sortKey) {
            items.sort((a, b) => {
                const ta = a.transaction;
                const tb = b.transaction;
                let cmp = 0;

                switch (sortKey) {
                    case 'date':
                        cmp = toDateTs(ta.date) - toDateTs(tb.date);
                        break;
                    case 'voucherNo':
                        cmp = String(ta.voucherNo || '').localeCompare(String(tb.voucherNo || ''), 'tr');
                        break;
                    case 'documentNo': {
                        const docA = String(ta.documentNo || '') || String(ta.voucherNo || '');
                        const docB = String(tb.documentNo || '') || String(tb.voucherNo || '');
                        cmp = docA.localeCompare(docB, 'tr');
                        break;
                    }
                    case 'description':
                        cmp = String(ta.description || '').localeCompare(String(tb.description || ''), 'tr');
                        break;
                    case 'debit':
                        cmp = (ta.debit || 0) - (tb.debit || 0);
                        break;
                    case 'credit':
                        cmp = (ta.credit || 0) - (tb.credit || 0);
                        break;
                    case 'balance':
                        cmp = (typeof ta.balance === 'number' ? ta.balance : 0) - (typeof tb.balance === 'number' ? tb.balance : 0);
                        break;
                    case 'fxMovement':
                        cmp = getFxMovement(ta.fxDebit, ta.fxCredit) - getFxMovement(tb.fxDebit, tb.fxCredit);
                        break;
                    case 'fxBalance':
                        cmp = (ta.fxBalance || 0) - (tb.fxBalance || 0);
                        break;
                    default:
                        cmp = 0;
                }
                return sortDir === 'asc' ? cmp : -cmp;
            });
        }

        return items;
    }, [indexedTransactions, dateFrom, dateTo, searchQuery, sortKey, sortDir, rowIssueByIndex]);

    /* ── Early return AFTER all hooks ── */
    if (!account) return null;

    if (isMinimized) {
        return createPortal(
            <div className="fixed bottom-3 right-3 z-[205] w-[360px] rounded-xl border border-slate-700 bg-[#0f172a]/95 shadow-2xl backdrop-blur-sm">
                <div className="px-3 py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-[11px] text-slate-400 uppercase tracking-wide font-semibold">Hesap Ekstresi</p>
                        <p className="text-sm text-blue-300 font-mono truncate" title={account.code}>{account.code}</p>
                        <p className="text-[11px] text-slate-500 truncate" title={account.name || ''}>{account.name || '-'}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => setIsMinimized(false)}
                            className="px-2.5 py-1.5 rounded border border-blue-500/40 text-blue-200 text-xs font-semibold hover:bg-blue-500/10 transition-colors"
                        >
                            Ac
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="p-1.5 rounded border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 transition-colors"
                            title="Kapat"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
            </div>,
            document.body
        );
    }

    const getRowApprovalKey = (transaction: Transaction, originalIndex: number): string => {
        return getStatementRowApprovalKey(source, account.code, transaction, originalIndex);
    };

    const isRowApproved = (transaction: Transaction, originalIndex: number): boolean => {
        return Boolean(persistedRowApprovals[getRowApprovalKey(transaction, originalIndex)]);
    };

    const hasRowIssueColumn = Object.keys(rowIssueByIndex || {}).length > 0;
    const selectedIndexes = Object.entries(selectedRowIndexes)
        .filter(([indexText, selected]) => {
            if (!selected) return false;
            const index = Number(indexText);
            const transaction = account.transactions[index];
            if (!transaction) return false;
            return !isRowApproved(transaction, index);
        })
        .map(([indexText]) => Number(indexText));
    const approvedCount = account.transactions.reduce((total, transaction, index) => {
        return total + (isRowApproved(transaction, index) ? 1 : 0);
    }, 0);

    const selectedSummary = selectedIndexes.reduce(
        (accumulator, index) => {
            const transaction = account.transactions[index];
            if (!transaction) return accumulator;
            accumulator.totalDebit += transaction.debit || 0;
            accumulator.totalCredit += transaction.credit || 0;
            return accumulator;
        },
        { totalDebit: 0, totalCredit: 0 }
    );
    const selectedDifference = selectedSummary.totalDebit - selectedSummary.totalCredit;

    const tableMinWidthClass = isForexAccount
        ? (hasRowIssueColumn ? 'min-w-[1400px]' : 'min-w-[1260px]')
        : (hasRowIssueColumn ? 'min-w-[1120px]' : 'min-w-[980px]');

    const hasActiveFilters = dateFrom || dateTo || searchQuery.trim();

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir('asc');
        }
    };

    const clearFilters = () => {
        setDateFrom('');
        setDateTo('');
        setSearchQuery('');
        setSortKey(null);
        setSortDir('asc');
    };

    const persistApprovalKeys = async (keys: string[], approved: boolean) => {
        if (!keys.length) return;

        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount;
            if (!currentAccount) return {};

            const nextApprovals = {
                ...(currentAccount.accountStatementRowApprovals || {}),
            };

            keys.forEach((key) => {
                if (approved) {
                    nextApprovals[key] = true;
                    return;
                }
                delete nextApprovals[key];
            });

            return {
                currentAccount: {
                    ...currentAccount,
                    accountStatementRowApprovals: nextApprovals,
                },
            };
        });
    };

    const toggleRowSelection = (index: number) => {
        const transaction = account.transactions[index];
        if (!transaction || isRowApproved(transaction, index)) return;

        setSelectedRowIndexes((prev) => {
            const next = { ...prev };
            if (next[index]) {
                delete next[index];
            } else {
                next[index] = true;
            }
            return next;
        });
    };

    const handleApproveSelectedRows = async () => {
        if (selectedIndexes.length === 0 || isPersistingApprovals) return;

        const approvalKeys = selectedIndexes
            .map((index) => {
                const transaction = account.transactions[index];
                if (!transaction) return null;
                return getRowApprovalKey(transaction, index);
            })
            .filter((value): value is string => Boolean(value));
        if (!approvalKeys.length) return;

        setIsPersistingApprovals(true);
        try {
            await persistApprovalKeys(approvalKeys, true);
            setApprovalHistory((prev) => [...prev, approvalKeys]);
            setSelectedRowIndexes((prev) => {
                const next = { ...prev };
                selectedIndexes.forEach((index) => {
                    delete next[index];
                });
                return next;
            });
        } finally {
            setIsPersistingApprovals(false);
        }
    };

    const handleUndoLastApproval = async () => {
        if (approvalHistory.length === 0 || isPersistingApprovals) return;

        const lastBatch = approvalHistory[approvalHistory.length - 1];
        setIsPersistingApprovals(true);
        try {
            await persistApprovalKeys(lastBatch, false);
            setApprovalHistory((prev) => prev.slice(0, -1));
        } finally {
            setIsPersistingApprovals(false);
        }
    };

    const handleDownloadExcel = async () => {
        const XLSX = await import('xlsx');
        const { applyStyledSheet } = await import('../../../utils/excelStyle');

        const rows = filteredSortedTransactions.map(({ transaction, originalIndex }) => {
            const voucherNo = String(transaction.voucherNo || '').trim();
            const documentNo = String(transaction.documentNo || '').trim() || voucherNo;
            const fxMovement = getFxMovement(transaction.fxDebit, transaction.fxCredit);
            const fxMovementLabel = formatSignedFxMovement(transaction.fxDebit, transaction.fxCredit);
            const hasFxMovement = fxMovementLabel !== '';
            const hasFxBalance = typeof transaction.fxBalance === 'number' && Math.abs(transaction.fxBalance) >= 0.0001;
            const hasForexData = hasFxMovement || hasFxBalance;
            const rowIssue = rowIssueByIndex?.[originalIndex];
            const rowIssueLabel = rowIssue ? `[${rowIssue.code}] ${rowIssue.message}` : '';
            const forexCurrency = resolveDisplayForexCurrency(
                transaction.currencyCode,
                inferredCurrency,
                hasForexData
            );

            if (!isForexAccount) {
                return {
                    Tarih: formatDate(transaction.date),
                    'Fis No': voucherNo,
                    'Evrak No': documentNo,
                    Aciklama: transaction.description || '',
                    Hata: rowIssueLabel,
                    Borc: transaction.debit,
                    Alacak: transaction.credit,
                    Bakiye: typeof transaction.balance === 'number' ? transaction.balance : '',
                };
            }

            return {
                Tarih: formatDate(transaction.date),
                'Fis No': voucherNo,
                'Evrak No': documentNo,
                Aciklama: transaction.description || '',
                Hata: rowIssueLabel,
                'Borc TL': transaction.debit,
                'Alacak TL': transaction.credit,
                'Bakiye TL': typeof transaction.balance === 'number' ? transaction.balance : '',
                'Doviz Turu': hasForexData ? forexCurrency : '',
                'Doviz Hareket': hasForexData && hasFxMovement ? fxMovement : '',
                'Doviz Bakiye': hasForexData && typeof transaction.fxBalance === 'number' ? transaction.fxBalance : '',
            };
        });

        const worksheet = XLSX.utils.json_to_sheet(rows);
        const numericCols = isForexAccount ? [5, 6, 7, 9, 10] : [5, 6, 7];
        applyStyledSheet(worksheet, { headerRowIndex: 0, numericColumns: numericCols });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Ekstre');

        const safeCode = String(account.code || 'hesap').replace(/[^\w.-]+/g, '_');
        const fileDate = new Date().toISOString().slice(0, 10);
        // S7: Include filter info in filename when filters are active
        const filterSuffix = hasActiveFilters
            ? `_filtreli${dateFrom ? `_${dateFrom}` : ''}${dateTo ? `_${dateTo}` : ''}`
            : '';
        XLSX.writeFile(workbook, `ekstre_${safeCode}_${fileDate}${filterSuffix}.xlsx`);
    };

    const thSortableClass = 'p-2.5 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 cursor-pointer select-none hover:text-slate-200 transition-colors';

    return createPortal(
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-[#0f172a] border border-slate-700 w-full max-w-[98vw] h-[96vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
                {/* ── Compact Header Row ── */}
                <div className="px-3 py-2 border-b border-slate-700 bg-slate-800/50 flex items-center justify-between gap-3">
                    {/* Left: Account info + type toggle */}
                    <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-base font-mono font-bold text-blue-400 shrink-0">{account.code}</span>
                        <span className="bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase shrink-0">Hesap Ekstresi</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${isForexAccount ? 'bg-blue-600/20 text-blue-200 border border-blue-500/30' : 'bg-slate-700 text-slate-200 border border-slate-600'}`}>
                            {isForexAccount ? 'Doviz' : 'TL'}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase shrink-0 ${accountTypeSource === 'MANUAL' ? 'bg-amber-600/20 text-amber-200 border border-amber-500/30' : 'bg-slate-700 text-slate-300 border border-slate-600'}`}>
                            {accountTypeSource === 'MANUAL' ? 'Manuel' : 'Tahmin'}
                        </span>
                        <span className="text-sm font-semibold text-white truncate" title={account.name || ''}>{account.name || '-'}</span>
                        <p className="text-[10px] text-slate-500 truncate max-w-[200px] shrink-0 hidden lg:block" title={inferenceReason || 'Hesap tipi manuel olarak duzeltilebilir.'}>{inferenceReason || ''}</p>
                        <div className="flex items-center gap-1 shrink-0 ml-1">
                            <button
                                type="button"
                                onClick={() => onAccountTypeChange?.('TL')}
                                className={`px-2 py-1 rounded border text-[10px] font-semibold transition-colors ${!isForexAccount ? 'bg-slate-200 text-slate-900 border-slate-100' : 'bg-slate-900/60 text-slate-300 border-slate-600 hover:border-slate-400'}`}
                            >
                                TL
                            </button>
                            <button
                                type="button"
                                onClick={() => onAccountTypeChange?.('FOREX')}
                                className={`px-2 py-1 rounded border text-[10px] font-semibold transition-colors ${isForexAccount ? 'bg-blue-500 text-white border-blue-400' : 'bg-slate-900/60 text-slate-300 border-slate-600 hover:border-blue-400'}`}
                            >
                                Doviz
                            </button>
                            {accountTypeSource === 'MANUAL' && (
                                <button
                                    type="button"
                                    onClick={() => onAccountTypeChange?.('AUTO')}
                                    className="px-2 py-1 rounded border border-amber-500/40 text-amber-200 text-[10px] font-semibold hover:bg-amber-500/10 transition-colors"
                                >
                                    Tahmine Don
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Right: Selection summary (compact inline) + actions */}
                    <div className="flex items-center gap-3 shrink-0">
                        <div className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-1.5">
                            <div className="flex items-center gap-3">
                                <span className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                                    Secili ({selectedIndexes.length})
                                </span>
                                <span className="text-[10px] text-slate-500">Onayli: {approvedCount}</span>
                            </div>
                            <div className="h-4 w-px bg-slate-700" />
                            <div className="flex items-center gap-3">
                                <span className="text-[10px] text-slate-500">Borc</span>
                                <span className="text-xs font-bold text-emerald-300">{formatCurrency(selectedSummary.totalDebit)}</span>
                                <span className="text-[10px] text-slate-500">Alacak</span>
                                <span className="text-xs font-bold text-rose-300">{formatCurrency(selectedSummary.totalCredit)}</span>
                                <span className="text-[10px] text-slate-500">Fark</span>
                                <span className={`text-xs font-bold ${selectedDifference >= 0 ? 'text-blue-300' : 'text-amber-300'}`}>
                                    {formatCurrency(Math.abs(selectedDifference))} {selectedDifference >= 0 ? '(B)' : '(A)'}
                                </span>
                            </div>
                            <div className="h-4 w-px bg-slate-700" />
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => void handleUndoLastApproval()}
                                    disabled={approvalHistory.length === 0 || isPersistingApprovals}
                                    className="px-2 py-1 rounded border border-slate-600 text-slate-300 text-[10px] font-semibold hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                    Geri Al
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleApproveSelectedRows()}
                                    disabled={selectedIndexes.length === 0 || isPersistingApprovals}
                                    className="px-2 py-1 rounded border border-emerald-500/40 text-emerald-200 text-[10px] font-semibold hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                    Satirlari Onayla
                                </button>
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={() => void handleDownloadExcel()}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/40 text-blue-200 hover:bg-blue-500/10 transition-colors text-[11px] font-semibold"
                        >
                            <Download size={13} />
                            Excel Indir
                        </button>
                        <button
                            type="button"
                            onClick={() => setIsMinimized(true)}
                            className="p-1.5 hover:bg-slate-700/50 rounded-lg text-slate-400 hover:text-white transition-colors"
                            title="Alta Al"
                        >
                            <Minus size={16} />
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1.5 hover:bg-slate-700/50 rounded-lg text-slate-400 hover:text-white transition-colors"
                            title="Kapat (Esc)"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* ── Compact Filter + Summary Row ── */}
                <div className="px-3 py-1.5 border-b border-slate-700/60 bg-slate-800/30 flex items-center gap-3">
                    {/* Filters */}
                    <div className="flex items-center gap-1">
                        <Calendar size={12} className="text-slate-500" />
                        <input
                            type="date"
                            value={dateFrom}
                            onChange={(e) => setDateFrom(e.target.value)}
                            max={dateTo || undefined}
                            className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-white focus:outline-none focus:border-blue-500 w-[120px]"
                            title="Baslangic tarihi"
                        />
                        <span className="text-slate-600 text-[10px]">-</span>
                        <input
                            type="date"
                            value={dateTo}
                            onChange={(e) => setDateTo(e.target.value)}
                            min={dateFrom || undefined}
                            className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-white focus:outline-none focus:border-blue-500 w-[120px]"
                            title="Bitis tarihi"
                        />
                    </div>
                    <div className="relative flex items-center gap-1 flex-1 max-w-[260px]">
                        <Search size={12} className="text-slate-500" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Ara... (fis no, aciklama, tutar, * destekli)"
                            className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 pr-6 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                className="absolute right-1.5 text-slate-500 hover:text-white transition-colors"
                                title="Aramayi temizle"
                            >
                                <X size={10} />
                            </button>
                        )}
                    </div>
                    {hasActiveFilters && (
                        <button
                            type="button"
                            onClick={clearFilters}
                            className="px-1.5 py-0.5 rounded border border-slate-600 text-slate-400 hover:text-white hover:border-slate-400 transition-colors text-[10px] font-semibold"
                        >
                            Temizle
                        </button>
                    )}

                    {/* Inline Summary Totals */}
                    <div className="flex items-center gap-4 ml-auto">
                        <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-slate-500 uppercase font-semibold">Toplam Borc TL</span>
                            <span className="text-xs font-bold text-emerald-400">{formatCurrency(account.totalDebit)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-slate-500 uppercase font-semibold">Toplam Alacak TL</span>
                            <span className="text-xs font-bold text-rose-400">{formatCurrency(account.totalCredit)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-slate-500 uppercase font-semibold">Bakiye TL</span>
                            <span className={`text-xs font-bold ${account.balance >= 0 ? 'text-blue-400' : 'text-amber-400'}`}>
                                {formatCurrency(Math.abs(account.balance))} {account.balance >= 0 ? '(B)' : '(A)'}
                            </span>
                        </div>
                        <span className="text-[10px] text-slate-500">
                            {filteredSortedTransactions.length}/{account.transactions.length} hareket
                        </span>
                    </div>
                </div>

                {/* ── Table ── */}
                <div className="flex-1 overflow-auto custom-scrollbar bg-slate-900/50">
                    <table className={`w-full ${tableMinWidthClass} text-left border-collapse table-fixed text-[11px] sm:text-xs`}>
                        <thead className="bg-slate-800/80 sticky top-0 z-10 backdrop-blur-sm">
                            <tr>
                                <th className="p-2.5 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-center w-20">
                                    Klik
                                </th>
                                <th className={`${thSortableClass} w-24`} onClick={() => handleSort('date')}>
                                    <div className="flex items-center gap-1">
                                        <Calendar size={14} /> Tarih <SortIcon columnKey="date" activeKey={sortKey} activeDir={sortDir} />
                                    </div>
                                </th>
                                <th className={`${thSortableClass} w-24`} onClick={() => handleSort('voucherNo')}>
                                    <div className="flex items-center gap-1">
                                        <FileText size={14} /> Fis No <SortIcon columnKey="voucherNo" activeKey={sortKey} activeDir={sortDir} />
                                    </div>
                                </th>
                                <th className={`${thSortableClass} w-28`} onClick={() => handleSort('documentNo')}>
                                    <div className="flex items-center gap-1">
                                        Evrak No <SortIcon columnKey="documentNo" activeKey={sortKey} activeDir={sortDir} />
                                    </div>
                                </th>
                                <th className={`${thSortableClass}`} onClick={() => handleSort('description')}>
                                    <div className="flex items-center gap-1">
                                        Aciklama <SortIcon columnKey="description" activeKey={sortKey} activeDir={sortDir} />
                                    </div>
                                </th>
                                {hasRowIssueColumn && (
                                    <th className="p-2.5 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 w-52">
                                        Hata
                                    </th>
                                )}
                                <th className={`${thSortableClass} text-right w-28`} onClick={() => handleSort('debit')}>
                                    <div className="flex items-center justify-end gap-1">
                                        {isForexAccount ? 'Borc TL' : 'Borc'} <SortIcon columnKey="debit" activeKey={sortKey} activeDir={sortDir} />
                                    </div>
                                </th>
                                <th className={`${thSortableClass} text-right w-28`} onClick={() => handleSort('credit')}>
                                    <div className="flex items-center justify-end gap-1">
                                        {isForexAccount ? 'Alacak TL' : 'Alacak'} <SortIcon columnKey="credit" activeKey={sortKey} activeDir={sortDir} />
                                    </div>
                                </th>
                                <th className={`${thSortableClass} text-right w-28`} onClick={() => handleSort('balance')}>
                                    <div className="flex items-center justify-end gap-1">
                                        {isForexAccount ? 'Bakiye TL' : 'Bakiye'} <SortIcon columnKey="balance" activeKey={sortKey} activeDir={sortDir} />
                                    </div>
                                </th>
                                {isForexAccount && (
                                    <>
                                        <th className="p-2.5 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 w-20">
                                            Doviz Turu
                                        </th>
                                        <th className={`${thSortableClass} text-right w-28`} onClick={() => handleSort('fxMovement')}>
                                            <div className="flex items-center justify-end gap-1">
                                                Doviz Hareket <SortIcon columnKey="fxMovement" activeKey={sortKey} activeDir={sortDir} />
                                            </div>
                                        </th>
                                        <th className={`${thSortableClass} text-right w-28`} onClick={() => handleSort('fxBalance')}>
                                            <div className="flex items-center justify-end gap-1">
                                                Doviz Bakiye <SortIcon columnKey="fxBalance" activeKey={sortKey} activeDir={sortDir} />
                                            </div>
                                        </th>
                                    </>
                                )}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {filteredSortedTransactions.map(({ transaction, originalIndex }) => {
                                const voucherNo = String(transaction.voucherNo || '').trim();
                                const documentNo = String(transaction.documentNo || '').trim() || voucherNo;
                                const rowIssue = rowIssueByIndex?.[originalIndex];
                                const rowApproved = isRowApproved(transaction, originalIndex);
                                const fxMovementLabel = formatSignedFxMovement(transaction.fxDebit, transaction.fxCredit);
                                const hasFxMovement = fxMovementLabel !== '';
                                const hasFxBalance = typeof transaction.fxBalance === 'number' && Math.abs(transaction.fxBalance) >= 0.0001;
                                const hasForexData = hasFxMovement || hasFxBalance;
                                const forexCurrency = resolveDisplayForexCurrency(
                                    transaction.currencyCode,
                                    inferredCurrency,
                                    hasForexData
                                );

                                return (
                                    <tr
                                        key={`${account.code}-${originalIndex}`}
                                        className={`${rowIssue ? 'bg-red-500/10 hover:bg-red-500/15' : 'hover:bg-slate-800/30'} transition-colors`}
                                    >
                                        <td className="p-2.5 text-center">
                                            {rowApproved ? (
                                                ''
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleRowSelection(originalIndex)}
                                                    className={`px-2 py-1 rounded border text-[11px] font-semibold transition-colors ${selectedRowIndexes[originalIndex]
                                                        ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-200'
                                                        : 'bg-slate-900/50 border-slate-700 text-slate-300 hover:border-blue-400'
                                                        }`}
                                                >
                                                    {selectedRowIndexes[originalIndex] ? 'Secildi' : 'Klik'}
                                                </button>
                                            )}
                                        </td>
                                        <td className="p-2.5 text-slate-300 font-mono whitespace-nowrap">
                                            {formatDate(transaction.date)}
                                        </td>
                                        <td className="p-2.5">
                                            {voucherNo ? (
                                                <button
                                                    type="button"
                                                    onClick={() => onVoucherClick(voucherNo)}
                                                    className="text-blue-400 hover:text-blue-300 underline underline-offset-2 font-mono break-all text-left"
                                                    title="Bu fisin detayini ac"
                                                >
                                                    {voucherNo}
                                                </button>
                                            ) : (
                                                <span className="text-slate-500">-</span>
                                            )}
                                        </td>
                                        <td className="p-2.5 text-slate-300 font-mono break-all">
                                            {documentNo || '-'}
                                        </td>
                                        <td className="p-2.5 text-slate-300">
                                            <div className="truncate" title={transaction.description || ''}>
                                                {transaction.description || '-'}
                                            </div>
                                        </td>
                                        {hasRowIssueColumn && (
                                            <td className="p-2.5 text-red-200 leading-5">
                                                {rowIssue ? (
                                                    <span className="inline-flex items-center gap-2">
                                                        <span className="px-2 py-0.5 rounded border border-red-400/50 bg-red-500/10 text-[11px] font-bold text-red-200">
                                                            {rowIssue.code}
                                                        </span>
                                                        <span>{rowIssue.message}</span>
                                                    </span>
                                                ) : (
                                                    ''
                                                )}
                                            </td>
                                        )}
                                        <td className="p-2.5 text-slate-300 font-mono text-right whitespace-nowrap">
                                            {transaction.debit > 0 ? formatCurrency(transaction.debit) : '-'}
                                        </td>
                                        <td className="p-2.5 text-slate-300 font-mono text-right whitespace-nowrap">
                                            {transaction.credit > 0 ? formatCurrency(transaction.credit) : '-'}
                                        </td>
                                        <td className="p-2.5 text-slate-300 font-mono text-right whitespace-nowrap">
                                            {typeof transaction.balance === 'number' ? formatCurrency(transaction.balance) : '-'}
                                        </td>
                                        {isForexAccount && (
                                            <>
                                                <td className="p-2.5 text-slate-300 whitespace-nowrap">
                                                    {hasForexData ? forexCurrency : ''}
                                                </td>
                                                <td className="p-2.5 text-slate-300 font-mono text-right whitespace-nowrap">
                                                    {hasForexData ? fxMovementLabel : ''}
                                                </td>
                                                <td className="p-2.5 text-slate-300 font-mono text-right whitespace-nowrap">
                                                    {hasForexData ? formatFxNumber(transaction.fxBalance) : ''}
                                                </td>
                                            </>
                                        )}
                                    </tr>
                                );
                            })}
                            {filteredSortedTransactions.length === 0 && (
                                <tr>
                                    <td colSpan={(isForexAccount ? 11 : 8) + (hasRowIssueColumn ? 1 : 0)} className="p-12 text-center text-slate-500">
                                        {hasActiveFilters ? 'Filtreye uygun hareket bulunamadi.' : 'Bu hesapta hareket bulunamadi.'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="px-3 py-1.5 border-t border-slate-700 bg-slate-800/30 text-[11px] text-slate-500">
                    {hasActiveFilters
                        ? `${filteredSortedTransactions.length} / ${account.transactionCount} hareket gösteriliyor (filtrelendi)`
                        : `Toplam ${account.transactionCount} hareket listelendi.`}
                </div>
            </div>
        </div>,
        document.body
    );
}
