import { Download, FileClock, Layers, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useCompany } from '../../context/CompanyContext';
import type { AccountDetail, MappingConfig, VoucherEditLogEntry, VoucherEditSource } from '../common/types';
import { filterCurrentAccountScopeData, undoVoucherEditOnAccounts } from '../common/voucherEditService';

type SourceFilter = 'ALL' | VoucherEditSource;

const formatDateTime = (value: string): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString('tr-TR');
};

const normalizeText = (value: string): string => {
    return String(value || '').toLocaleLowerCase('tr-TR');
};

const isUndoEligible = (log: VoucherEditLogEntry): boolean => {
    if (log.undoneAt) return false;
    if (String(log.field || '').startsWith('undo-')) return false;
    return true;
};

export default function VoucherEditReportPage() {
    const { activeCompany, patchActiveCompany } = useCompany();
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');
    const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
    const [isBusy, setIsBusy] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const logs = useMemo(() => {
        return [...(activeCompany?.currentAccount?.voucherEditLogs || [])].sort((left, right) => {
            const leftTime = new Date(left.createdAt).getTime();
            const rightTime = new Date(right.createdAt).getTime();
            return rightTime - leftTime;
        });
    }, [activeCompany?.currentAccount?.voucherEditLogs]);

    const filteredLogs = useMemo(() => {
        const query = normalizeText(search.trim());
        return logs.filter((log) => {
            if (sourceFilter !== 'ALL' && log.source !== sourceFilter) return false;
            if (!query) return true;

            const haystack = normalizeText([
                log.voucherNo,
                log.fieldLabel,
                log.accountCodeBefore,
                log.accountNameBefore,
                log.accountCodeAfter,
                log.accountNameAfter,
                log.oldValue,
                log.newValue,
                log.documentNo || '',
                log.description || '',
            ].join(' | '));
            return haystack.includes(query);
        });
    }, [logs, search, sourceFilter]);

    const selectedCount = useMemo(() => {
        return Object.values(selectedIds).filter(Boolean).length;
    }, [selectedIds]);

    const selectedUndoableLogs = useMemo(() => {
        const selected = new Set(
            Object.entries(selectedIds)
                .filter(([, isSelected]) => isSelected)
                .map(([id]) => id)
        );
        return logs.filter((log) => selected.has(log.id) && isUndoEligible(log));
    }, [logs, selectedIds]);

    const filteredUndoableLogs = useMemo(() => {
        return filteredLogs.filter((log) => isUndoEligible(log));
    }, [filteredLogs]);

    if (!activeCompany) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center animate-fade-in">
                <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center mb-6">
                    <Layers className="text-slate-600 w-12 h-12" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Firma secimi gerekli</h2>
                <p className="text-slate-400 max-w-md">
                    Fis duzenleme raporu icin lutfen once firma secin.
                </p>
            </div>
        );
    }

    const updateLogs = async (nextLogs: VoucherEditLogEntry[]) => {
        setIsBusy(true);
        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount;
            if (!currentAccount) return {};

            return {
                currentAccount: {
                    ...currentAccount,
                    voucherEditLogs: nextLogs,
                },
            };
        });
        setIsBusy(false);
    };

    const removeOne = async (id: string) => {
        setErrorMessage(null);
        const nextLogs = logs.filter((log) => log.id !== id);
        await updateLogs(nextLogs);
        setSelectedIds((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
    };

    const removeSelected = async () => {
        setErrorMessage(null);
        const selected = new Set(
            Object.entries(selectedIds)
                .filter(([, isSelected]) => isSelected)
                .map(([id]) => id)
        );
        if (!selected.size) return;

        const nextLogs = logs.filter((log) => !selected.has(log.id));
        await updateLogs(nextLogs);
        setSelectedIds({});
    };

    const removeBySource = async (source: VoucherEditSource) => {
        setErrorMessage(null);
        const hasSourceLogs = logs.some((log) => log.source === source);
        if (!hasSourceLogs) return;
        const sourceLabel = source === 'FIRMA' ? 'Firma' : 'SMMM';
        const confirmed = window.confirm(`${sourceLabel} kaynagindaki tum duzenleme kayitlari silinsin mi?`);
        if (!confirmed) return;

        const nextLogs = logs.filter((log) => log.source !== source);
        await updateLogs(nextLogs);
        setSelectedIds({});
    };

    const removeAll = async () => {
        setErrorMessage(null);
        if (!logs.length) return;
        const confirmed = window.confirm('Tum fis duzenleme kayitlari silinsin mi?');
        if (!confirmed) return;
        await updateLogs([]);
        setSelectedIds({});
    };

    const applyUndoEntries = async (entries: VoucherEditLogEntry[]) => {
        const eligibleEntries = entries.filter((entry) => isUndoEligible(entry));
        if (!eligibleEntries.length) return;

        setErrorMessage(null);
        setIsBusy(true);
        let failureMessage = '';
        let undoneCount = 0;
        const undoneIds = new Set<string>();

        const ordered = [...eligibleEntries].sort((left, right) => {
            const leftTime = new Date(left.createdAt).getTime();
            const rightTime = new Date(right.createdAt).getTime();
            return rightTime - leftTime;
        });

        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount || {
                smmmData: [] as AccountDetail[],
                firmaData: [] as AccountDetail[],
                smmmFullData: [] as AccountDetail[],
                firmaFullData: [] as AccountDetail[],
                mappings: {} as MappingConfig,
            };

            let nextFirmaFullData = currentAccount.firmaFullData || [];
            let nextSmmmFullData = currentAccount.smmmFullData || [];
            const nextLogs = [...(currentAccount.voucherEditLogs || [])];
            const logIndexById = new Map<string, number>();
            nextLogs.forEach((entry, index) => {
                logIndexById.set(entry.id, index);
            });

            ordered.forEach((entry) => {
                const idx = logIndexById.get(entry.id);
                if (idx === undefined) return;
                const liveEntry = nextLogs[idx];
                if (!isUndoEligible(liveEntry)) return;

                const sourceAccounts = liveEntry.source === 'FIRMA' ? nextFirmaFullData : nextSmmmFullData;
                const undoResult = undoVoucherEditOnAccounts(sourceAccounts, liveEntry);
                if (undoResult.error) {
                    if (!failureMessage) {
                        failureMessage = `[${liveEntry.voucherNo}] ${undoResult.error}`;
                    }
                    return;
                }
                if (!undoResult.changed) return;

                if (liveEntry.source === 'FIRMA') {
                    nextFirmaFullData = undoResult.accounts;
                } else {
                    nextSmmmFullData = undoResult.accounts;
                }

                nextLogs[idx] = {
                    ...liveEntry,
                    undoneAt: new Date().toISOString(),
                    undoLogId: undoResult.logEntry?.id,
                };
                if (undoResult.logEntry) {
                    nextLogs.push(undoResult.logEntry);
                    logIndexById.set(undoResult.logEntry.id, nextLogs.length - 1);
                }
                undoneCount += 1;
                undoneIds.add(liveEntry.id);
            });

            if (undoneCount === 0) {
                return {};
            }

            return {
                currentAccount: {
                    ...currentAccount,
                    firmaFullData: nextFirmaFullData,
                    smmmFullData: nextSmmmFullData,
                    firmaData: filterCurrentAccountScopeData(nextFirmaFullData),
                    smmmData: filterCurrentAccountScopeData(nextSmmmFullData),
                    voucherEditLogs: nextLogs,
                },
            };
        });

        setIsBusy(false);
        if (undoneIds.size > 0) {
            setSelectedIds((current) => {
                const next = { ...current };
                undoneIds.forEach((id) => {
                    delete next[id];
                });
                return next;
            });
        }
        if (failureMessage) {
            setErrorMessage(failureMessage);
        } else if (undoneCount === 0) {
            setErrorMessage('Geri alinabilir kayit bulunamadi.');
        }
    };

    const undoOne = async (log: VoucherEditLogEntry) => {
        await applyUndoEntries([log]);
    };

    const undoSelected = async () => {
        await applyUndoEntries(selectedUndoableLogs);
    };

    const undoBulk = async () => {
        await applyUndoEntries(filteredUndoableLogs);
    };

    const exportExcel = async () => {
        const XLSX = await import('xlsx');
        const { applyStyledSheet } = await import('../../utils/excelStyle');

        const rows = filteredLogs.map((log) => ({
            'Tarih Saat': formatDateTime(log.createdAt),
            Kaynak: log.source,
            'Fis No': log.voucherNo,
            'Alan': log.fieldLabel,
            'Eski Deger': log.oldValue,
            'Yeni Deger': log.newValue,
            'Hesap Once': `${log.accountCodeBefore} ${log.accountNameBefore}`.trim(),
            'Hesap Sonra': `${log.accountCodeAfter} ${log.accountNameAfter}`.trim(),
            Durum: log.undoneAt
                ? `Geri alindi (${formatDateTime(log.undoneAt)})`
                : (String(log.field || '').startsWith('undo-') ? 'Undo kaydi' : 'Aktif'),
            'Evrak No': log.documentNo || '',
            Aciklama: log.description || '',
        }));

        const worksheet = XLSX.utils.json_to_sheet(rows);
        applyStyledSheet(worksheet, { headerRowIndex: 0 });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'FisDuzenlemeLog');
        const datePart = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(workbook, `fis_duzenleme_log_${datePart}.xlsx`);
    };

    return (
        <div className="animate-fade-in flex flex-col gap-0">
            {/* ── Compact Toolbar Row 1: Title + Actions ── */}
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl flex-wrap">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-sm font-bold text-white uppercase tracking-wide">Fis Duzenleme Raporu</h1>
                    <div className="h-4 w-px bg-slate-700" />
                    <span className="text-xs text-slate-400">{logs.length} kayit</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => void exportExcel()}
                        disabled={filteredLogs.length === 0}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/40 text-blue-200 hover:bg-blue-500/10 transition-colors text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Download size={13} />
                        Excel
                    </button>
                    <button
                        type="button"
                        onClick={() => void undoSelected()}
                        disabled={selectedUndoableLogs.length === 0 || isBusy}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 transition-colors text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <FileClock size={12} />
                        Geri Al ({selectedUndoableLogs.length})
                    </button>
                    <button
                        type="button"
                        onClick={() => void undoBulk()}
                        disabled={filteredUndoableLogs.length === 0 || isBusy}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 transition-colors text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <FileClock size={12} />
                        Toplu ({filteredUndoableLogs.length})
                    </button>
                    <button
                        type="button"
                        onClick={() => void removeSelected()}
                        disabled={selectedCount === 0 || isBusy}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-500/40 text-amber-200 hover:bg-amber-500/10 transition-colors text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Trash2 size={12} />
                        Sil ({selectedCount})
                    </button>
                    <button
                        type="button"
                        onClick={() => void removeAll()}
                        disabled={!logs.length || isBusy}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-500/40 text-red-200 hover:bg-red-500/10 transition-colors text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Trash2 size={12} />
                        Tumunu Sil
                    </button>
                </div>
            </div>

            {/* ── Compact Toolbar Row 2: Search + Filters ── */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/20 border-b border-slate-700/40">
                <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Fis no, hesap, alan, aciklama ara..."
                    className="w-64 max-w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
                <select
                    value={sourceFilter}
                    onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-blue-500"
                    title="Kaynak filtresi"
                >
                    <option value="ALL">Tum Kaynaklar</option>
                    <option value="FIRMA">Firma</option>
                    <option value="SMMM">SMMM</option>
                </select>
                <div className="ml-auto flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => void removeBySource('FIRMA')}
                        disabled={isBusy}
                        className="px-2 py-1 rounded border border-slate-600 text-slate-300 hover:border-red-400/50 hover:text-red-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-[10px]"
                    >
                        Firma Sil
                    </button>
                    <button
                        type="button"
                        onClick={() => void removeBySource('SMMM')}
                        disabled={isBusy}
                        className="px-2 py-1 rounded border border-slate-600 text-slate-300 hover:border-red-400/50 hover:text-red-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-[10px]"
                    >
                        SMMM Sil
                    </button>
                </div>
            </div>

                {errorMessage && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
                        {errorMessage}
                    </div>
                )}

                <div className="overflow-auto rounded-xl border border-slate-700 bg-slate-900/40">
                    <table className="w-full min-w-[1200px] text-left border-collapse text-xs">
                        <thead className="bg-slate-800/80 sticky top-0 z-10">
                            <tr>
                                <th className="p-2.5 border-b border-slate-700 w-10">
                                    <input
                                        type="checkbox"
                                        checked={filteredLogs.length > 0 && filteredLogs.every((log) => selectedIds[log.id])}
                                        onChange={(event) => {
                                            const checked = event.target.checked;
                                            if (!checked) {
                                                setSelectedIds({});
                                                return;
                                            }
                                            const next: Record<string, boolean> = {};
                                            filteredLogs.forEach((log) => {
                                                next[log.id] = true;
                                            });
                                            setSelectedIds(next);
                                        }}
                                    />
                                </th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Tarih Saat</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Kaynak</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Fis No</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Alan</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Eski Deger</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Yeni Deger</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Hesap Sonra</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase">Durum</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase w-20">Geri Al</th>
                                <th className="p-2.5 border-b border-slate-700 text-slate-400 uppercase w-16">Sil</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {filteredLogs.map((log) => (
                                <tr key={log.id} className="hover:bg-slate-800/30">
                                    <td className="p-2.5">
                                        <input
                                            type="checkbox"
                                            checked={!!selectedIds[log.id]}
                                            onChange={(event) => {
                                                const checked = event.target.checked;
                                                setSelectedIds((current) => ({ ...current, [log.id]: checked }));
                                            }}
                                        />
                                    </td>
                                    <td className="p-2.5 text-slate-300 whitespace-nowrap">{formatDateTime(log.createdAt)}</td>
                                    <td className="p-2.5">
                                        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${log.source === 'FIRMA' ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/30' : 'bg-blue-500/20 text-blue-200 border border-blue-500/30'}`}>
                                            {log.source}
                                        </span>
                                    </td>
                                    <td className="p-2.5 text-blue-300 font-mono whitespace-nowrap">{log.voucherNo || '-'}</td>
                                    <td className="p-2.5 text-slate-200">{log.fieldLabel}</td>
                                    <td className="p-2.5 text-slate-300">{log.oldValue || '-'}</td>
                                    <td className="p-2.5 text-emerald-200">{log.newValue || '-'}</td>
                                    <td className="p-2.5 text-slate-300">
                                        <div className="font-mono text-blue-300">{log.accountCodeAfter}</div>
                                        <div className="text-slate-400">{log.accountNameAfter || '-'}</div>
                                    </td>
                                    <td className="p-2.5 text-slate-300">
                                        {log.undoneAt ? (
                                            <span className="text-amber-200 text-[11px] font-semibold">
                                                Geri alindi ({formatDateTime(log.undoneAt)})
                                            </span>
                                        ) : String(log.field || '').startsWith('undo-') ? (
                                            <span className="text-emerald-200 text-[11px] font-semibold">Undo kaydi</span>
                                        ) : (
                                            <span className="text-slate-400 text-[11px]">Aktif</span>
                                        )}
                                    </td>
                                    <td className="p-2.5">
                                        <button
                                            type="button"
                                            onClick={() => void undoOne(log)}
                                            disabled={isBusy || !!log.undoneAt || String(log.field || '').startsWith('undo-')}
                                            className="px-2 py-1 rounded border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 transition-colors text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                                            title="Bu degisikligi geri al"
                                        >
                                            Geri Al
                                        </button>
                                    </td>
                                    <td className="p-2.5">
                                        <button
                                            type="button"
                                            onClick={() => void removeOne(log.id)}
                                            disabled={isBusy}
                                            className="p-1.5 rounded border border-red-500/40 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                            title="Kaydi sil"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {filteredLogs.length === 0 && (
                                <tr>
                                    <td colSpan={11} className="p-10 text-center text-slate-500">
                                        <div className="inline-flex items-center gap-2">
                                            <FileClock size={16} />
                                            Gosterilecek fis duzenleme kaydi bulunamadi.
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

        </div>
    );
}
