import { useMemo, useState } from 'react';
import { Building2, Download, Search, UserRound } from 'lucide-react';

import { useCompany } from '../../context/CompanyContext';
import type { AccountDetail, Company } from '../common/types';
import VoucherDetailModal, { type VoucherAccountOption, type VoucherDetailRow } from '../mizan/components/VoucherDetailModal';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { matchesSearchAcrossFields } from '../../utils/search';
import { round2, normalizeVoucherNo, parseDateInput, BALANCE_TOLERANCE } from '../../utils/accounting';
import NoCompanySelected from '../../components/common/NoCompanySelected';

type VoucherListSource = 'FIRMA' | 'SMMM';

interface VoucherListRow {
    key: string;
    voucherNo: string;
    firstDate: Date | null;
    lastDate: Date | null;
    rowCount: number;
    totalDebit: number;
    totalCredit: number;
    balance: number;
    accountCount: number;
    accountPreview: string;
    accountSearchText: string;
    documentPreview: string;
    descriptionPreview: string;
}

const EMPTY_ACCOUNTS: AccountDetail[] = [];
const EMPTY_VOUCHER_KEY = '__EMPTY_VOUCHER__';

const isDateInRange = (value: Date | null | undefined, from: Date | null, to: Date | null): boolean => {
    if (!from && !to) return true;
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return false;
    if (from && value.getTime() < from.getTime()) return false;
    if (to && value.getTime() > to.getTime()) return false;
    return true;
};

const getVoucherGroupKey = (voucherNo: string | undefined): string => {
    const normalized = normalizeVoucherNo(voucherNo);
    if (!normalized) return EMPTY_VOUCHER_KEY;
    return normalized;
};

function VoucherListContent({ activeCompany }: { activeCompany: Company }) {
    const [selectedSource, setSelectedSource] = useState<VoucherListSource>('FIRMA');
    const [search, setSearch] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [selectedVoucherKey, setSelectedVoucherKey] = useState<string | null>(null);

    const firmaData = activeCompany.currentAccount?.firmaFullData ?? EMPTY_ACCOUNTS;
    const smmmData = activeCompany.currentAccount?.smmmFullData ?? EMPTY_ACCOUNTS;

    const source = useMemo<VoucherListSource>(() => {
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
    const hasInvalidDateRange = Boolean(filterDateFrom && filterDateTo && filterDateFrom.getTime() > filterDateTo.getTime());

    const voucherRows = useMemo<VoucherListRow[]>(() => {
        if (hasInvalidDateRange) return [];

        type VoucherAggregate = {
            key: string;
            voucherNo: string;
            firstDate: Date | null;
            lastDate: Date | null;
            rowCount: number;
            totalDebit: number;
            totalCredit: number;
            accountCodes: Set<string>;
            accountSearchParts: Set<string>;
            documentNos: Set<string>;
            description: string;
        };

        const map = new Map<string, VoucherAggregate>();

        sourceData.forEach((account) => {
            account.transactions.forEach((transaction) => {
                if (!isDateInRange(transaction.date, filterDateFrom, filterDateTo)) return;

                const key = getVoucherGroupKey(transaction.voucherNo);
                const voucherNoText = String(transaction.voucherNo || '').trim() || '-';
                const documentNo = String(transaction.documentNo || transaction.voucherNo || '').trim();
                const description = String(transaction.description || '').trim();

                let aggregate = map.get(key);
                if (!aggregate) {
                    aggregate = {
                        key,
                        voucherNo: voucherNoText,
                        firstDate: null,
                        lastDate: null,
                        rowCount: 0,
                        totalDebit: 0,
                        totalCredit: 0,
                        accountCodes: new Set<string>(),
                        accountSearchParts: new Set<string>(),
                        documentNos: new Set<string>(),
                        description: description || '',
                    };
                    map.set(key, aggregate);
                } else if (aggregate.voucherNo === '-' && voucherNoText !== '-') {
                    aggregate.voucherNo = voucherNoText;
                }

                aggregate.rowCount += 1;
                aggregate.totalDebit = round2(aggregate.totalDebit + (transaction.debit || 0));
                aggregate.totalCredit = round2(aggregate.totalCredit + (transaction.credit || 0));

                const txDate = transaction.date instanceof Date && !Number.isNaN(transaction.date.getTime())
                    ? transaction.date
                    : null;
                if (txDate) {
                    if (!aggregate.firstDate || txDate.getTime() < aggregate.firstDate.getTime()) {
                        aggregate.firstDate = txDate;
                    }
                    if (!aggregate.lastDate || txDate.getTime() > aggregate.lastDate.getTime()) {
                        aggregate.lastDate = txDate;
                    }
                }

                aggregate.accountCodes.add(account.code);
                aggregate.accountSearchParts.add(account.code);
                if (account.name) {
                    aggregate.accountSearchParts.add(account.name);
                }
                if (documentNo) {
                    aggregate.documentNos.add(documentNo);
                }
                if (!aggregate.description && description) {
                    aggregate.description = description;
                }
            });
        });

        const rows = Array.from(map.values()).map((item): VoucherListRow => {
            const accountCodeList = Array.from(item.accountCodes).sort((left, right) => left.localeCompare(right, 'tr-TR'));
            const documentList = Array.from(item.documentNos).sort((left, right) => left.localeCompare(right, 'tr-TR'));
            const accountPreview = accountCodeList.slice(0, 3).join(', ');
            const documentPreview = documentList.slice(0, 2).join(', ');

            return {
                key: item.key,
                voucherNo: item.voucherNo,
                firstDate: item.firstDate,
                lastDate: item.lastDate,
                rowCount: item.rowCount,
                totalDebit: item.totalDebit,
                totalCredit: item.totalCredit,
                balance: round2(item.totalDebit - item.totalCredit),
                accountCount: item.accountCodes.size,
                accountPreview: accountPreview || '-',
                accountSearchText: Array.from(item.accountSearchParts).join(' '),
                documentPreview: documentPreview || '-',
                descriptionPreview: item.description || '-',
            };
        });

        return rows.sort((left, right) => {
            const leftTs = left.firstDate ? left.firstDate.getTime() : 0;
            const rightTs = right.firstDate ? right.firstDate.getTime() : 0;
            if (leftTs !== rightTs) return rightTs - leftTs;
            return left.voucherNo.localeCompare(right.voucherNo, 'tr-TR');
        });
    }, [sourceData, filterDateFrom, filterDateTo, hasInvalidDateRange]);

    const visibleVoucherRows = useMemo(() => {
        return voucherRows.filter((row) => {
            return matchesSearchAcrossFields(search, [
                row.voucherNo,
                row.documentPreview,
                row.descriptionPreview,
                row.accountPreview,
                row.accountSearchText,
                row.rowCount,
                row.accountCount,
                formatDate(row.firstDate),
                formatDate(row.lastDate),
                row.totalDebit,
                row.totalCredit,
                row.balance,
            ]);
        });
    }, [voucherRows, search]);

    const summary = useMemo(() => {
        return visibleVoucherRows.reduce(
            (accumulator, row) => {
                accumulator.totalRows += row.rowCount;
                accumulator.totalDebit = round2(accumulator.totalDebit + row.totalDebit);
                accumulator.totalCredit = round2(accumulator.totalCredit + row.totalCredit);
                return accumulator;
            },
            { totalRows: 0, totalDebit: 0, totalCredit: 0 }
        );
    }, [visibleVoucherRows]);

    const selectedVoucherRows = useMemo<VoucherDetailRow[]>(() => {
        if (!selectedVoucherKey) return [];

        const rows: VoucherDetailRow[] = [];
        sourceData.forEach((account) => {
            account.transactions.forEach((transaction, transactionIndex) => {
                const key = getVoucherGroupKey(transaction.voucherNo);
                if (key !== selectedVoucherKey) return;

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

        rows.sort((left, right) => {
            const leftTs = left.date ? left.date.getTime() : 0;
            const rightTs = right.date ? right.date.getTime() : 0;
            if (leftTs !== rightTs) return leftTs - rightTs;
            const accountCompare = left.accountCode.localeCompare(right.accountCode, 'tr-TR');
            if (accountCompare !== 0) return accountCompare;
            return left.sourceTransactionIndex - right.sourceTransactionIndex;
        });

        return rows;
    }, [selectedVoucherKey, sourceData, source]);

    const voucherAccountOptions = useMemo<VoucherAccountOption[]>(() => {
        return sourceData
            .map((account) => ({ code: account.code, name: account.name || '' }))
            .sort((left, right) => {
                const codeCompare = left.code.localeCompare(right.code, 'tr-TR');
                if (codeCompare !== 0) return codeCompare;
                return left.name.localeCompare(right.name, 'tr-TR');
            });
    }, [sourceData]);

    const selectedVoucherLabel = useMemo(() => {
        if (!selectedVoucherKey) return null;
        const row = voucherRows.find((item) => item.key === selectedVoucherKey);
        if (row) return row.voucherNo === '-' ? 'Fis No Yok' : row.voucherNo;
        if (selectedVoucherKey === EMPTY_VOUCHER_KEY) return 'Fis No Yok';
        return selectedVoucherKey;
    }, [selectedVoucherKey, voucherRows]);

    const handleDownloadExcel = async () => {
        const XLSX = await import('xlsx');
        const { applyStyledSheet } = await import('../../utils/excelStyle');

        const rows = visibleVoucherRows.map((row) => ({
            'Ilk Tarih': formatDate(row.firstDate),
            'Son Tarih': formatDate(row.lastDate),
            'Fis No': row.voucherNo,
            'Evrak Ozet': row.documentPreview,
            'Aciklama Ozet': row.descriptionPreview,
            'Hesap Sayisi': row.accountCount,
            'Satir Sayisi': row.rowCount,
            Borc: row.totalDebit,
            Alacak: row.totalCredit,
            Fark: Math.abs(row.balance),
            'Fark Yonu': row.balance >= 0 ? 'Borc (B)' : 'Alacak (A)',
        }));

        const worksheet = XLSX.utils.json_to_sheet(rows);
        applyStyledSheet(worksheet, { headerRowIndex: 0, numericColumns: [5, 6, 7, 8, 9] });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'FisListesi');

        const datePart = new Date().toISOString().slice(0, 10);
        const sourceKey = source.toLocaleLowerCase('tr-TR');
        const filterSuffix = `${dateFrom ? `_from_${dateFrom}` : ''}${dateTo ? `_to_${dateTo}` : ''}`;
        XLSX.writeFile(workbook, `fis_listesi_${sourceKey}_${datePart}${filterSuffix}.xlsx`);
    };

    const hasAnyData = firmaData.length > 0 || smmmData.length > 0;

    return (
        <div className="animate-fade-in flex flex-col gap-0">
            {/* ── Compact Toolbar Row 1: Source + Stats ── */}
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-sm font-bold text-white uppercase tracking-wide">Fis Listesi</h1>
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
                            <span className="text-slate-500">Fis</span>
                            <span className="text-white font-semibold">{visibleVoucherRows.length}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Satir</span>
                            <span className="text-white font-semibold">{summary.totalRows}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Borc</span>
                            <span className="text-emerald-300 font-semibold">{formatCurrency(summary.totalDebit)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Alacak</span>
                            <span className="text-rose-300 font-semibold">{formatCurrency(summary.totalCredit)}</span>
                        </div>
                    </div>
                )}
            </div>

            {!hasAnyData && (
                <div className="mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Fis listesi icin veri bulunamadi. Once Cari Hesap Kontrol modulunde dosyalari isleyin.
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
                                placeholder="Fis no, evrak, aciklama, hesap ara..."
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                            />
                        </div>

                        <button
                            type="button"
                            onClick={() => void handleDownloadExcel()}
                            disabled={visibleVoucherRows.length === 0 || hasInvalidDateRange}
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
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Ilk Tarih</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Son Tarih</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Fis No</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Evrak Ozet</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700">Aciklama Ozet</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Hesap</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Satir</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Borc</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Alacak</th>
                                    <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700 text-right">Fark</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                                {visibleVoucherRows.map((row) => (
                                    <tr
                                        key={row.key}
                                        className={`transition-colors cursor-pointer ${Math.abs(row.balance) > BALANCE_TOLERANCE
                                            ? 'bg-amber-500/5 hover:bg-amber-500/10'
                                            : 'hover:bg-slate-800/40'
                                            }`}
                                        onClick={() => setSelectedVoucherKey(row.key)}
                                        title="Fis detayini ac"
                                    >
                                        <td className="p-3 text-sm text-slate-300 font-mono">{formatDate(row.firstDate)}</td>
                                        <td className="p-3 text-sm text-slate-300 font-mono">{formatDate(row.lastDate)}</td>
                                        <td className="p-3 text-sm text-blue-300 font-mono">{row.voucherNo}</td>
                                        <td className="p-3 text-sm text-slate-300">{row.documentPreview}</td>
                                        <td className="p-3 text-sm text-slate-300">
                                            <div className="truncate max-w-[480px]" title={row.descriptionPreview}>
                                                {row.descriptionPreview}
                                            </div>
                                        </td>
                                        <td className="p-3 text-sm text-slate-400 text-right">{row.accountCount}</td>
                                        <td className="p-3 text-sm text-slate-400 text-right">{row.rowCount}</td>
                                        <td className="p-3 text-sm text-slate-300 font-mono text-right">{formatCurrency(row.totalDebit)}</td>
                                        <td className="p-3 text-sm text-slate-300 font-mono text-right">{formatCurrency(row.totalCredit)}</td>
                                        <td className="p-3 text-sm font-mono text-right">
                                            <span className={row.balance >= 0 ? 'text-blue-300' : 'text-amber-300'}>
                                                {formatCurrency(Math.abs(row.balance))} {row.balance >= 0 ? '(B)' : '(A)'}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                                {visibleVoucherRows.length === 0 && (
                                    <tr>
                                        <td colSpan={10} className="p-10 text-center text-slate-500">
                                            Kriterlere uygun fis bulunamadi.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </> /* Fragment close */
            )}

            <VoucherDetailModal
                source={source}
                voucherNo={selectedVoucherLabel}
                rows={selectedVoucherRows}
                accountOptions={voucherAccountOptions}
                onVoucherChange={(nextVoucherNo) => setSelectedVoucherKey(getVoucherGroupKey(nextVoucherNo))}
                onClose={() => setSelectedVoucherKey(null)}
            />
        </div>
    );
}

export default function VoucherListPage() {
    const { activeCompany } = useCompany();

    if (!activeCompany) {
        return <NoCompanySelected moduleName="Fiş Listesi" />;
    }

    return <VoucherListContent key={activeCompany.id} activeCompany={activeCompany} />;
}
