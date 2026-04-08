import { useRef, useState, type ChangeEvent } from 'react';
import { AlertCircle, CheckCircle2, FileSpreadsheet, Layers, RefreshCcw, Upload } from 'lucide-react';
import { useCompany } from '../../context/CompanyContext';
import { Card } from '../../components/common/Card';
import { Button } from '../../components/common/Button';
import NoCompanySelected from '../../components/common/NoCompanySelected';
import { parseKebirFile } from '../kebir-analysis/utils/kebirParser';
import { MappingStep } from '../reconciliation/components/MappingStep';
import {
    processEInvoiceFile,
    processAccountingFile,
    processAccountingMatrahFile
} from '../reconciliation/services/excelProcessor';
import {
    SALES_EINVOICE_FIELDS,
    PURCHASE_EINVOICE_FIELDS,
    SALES_ACCOUNTING_VAT_FIELDS,
    PURCHASE_ACCOUNTING_VAT_FIELDS,
    ACCOUNTING_MATRAH_FIELDS
} from '../reconciliation/utils/constants';
import type { EInvoiceRow, AccountingRow, AccountingMatrahRow } from '../../types';
import type { ExcelProcessResult } from '../reconciliation/services/excelProcessor';
import type { VoucherEditSource } from '../common/types';

const EXCEL_ACCEPT = '.xlsx,.xls';

const isExcelFile = (file: File): boolean => /\.(xlsx|xls)$/i.test(file.name);

const toExcelFiles = (fileList: FileList | null): File[] => {
    if (!fileList) return [];
    return Array.from(fileList).filter(isExcelFile);
};

interface UploadPanelProps {
    title: string;
    description: string;
    files: File[];
    multiple?: boolean;
    onSelect: (files: File[]) => void;
    onProcess?: (file: File) => void;
    isProcessed?: boolean;
}

function UploadPanel({
    title,
    description,
    files,
    multiple = false,
    onSelect,
    onProcess,
    isProcessed = false,
}: UploadPanelProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
        const pickedFiles = toExcelFiles(event.target.files);
        onSelect(multiple ? pickedFiles : pickedFiles.slice(0, 1));
        event.target.value = '';
    };

    return (
        <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-3 relative overflow-hidden">
            {isProcessed && (
                <div className="absolute top-0 right-0 p-2">
                    <div className="bg-emerald-500/10 text-emerald-400 text-xs px-2 py-1 rounded-full border border-emerald-500/20 flex items-center gap-1">
                        <CheckCircle2 size={12} />
                        <span>İşlendi</span>
                    </div>
                </div>
            )}
            <div>
                <h3 className="text-sm font-semibold text-white">{title}</h3>
                <p className="text-xs text-slate-400 mt-1">{description}</p>
            </div>

            <div className="flex gap-2">
                <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    leftIcon={<Upload size={14} />}
                    onClick={() => inputRef.current?.click()}
                >
                    {multiple ? 'Dosyaları Seç' : 'Dosya Seç'}
                </Button>

                {onProcess && files.length > 0 && !isProcessed && (
                    <Button
                        variant="primary"
                        size="sm"
                        className="px-3"
                        onClick={() => onProcess(files[0])}
                        title="Dosyayı İşle"
                    >
                        İşle
                    </Button>
                )}
            </div>

            <input
                ref={inputRef}
                type="file"
                accept={EXCEL_ACCEPT}
                multiple={multiple}
                className="hidden"
                onChange={handleChange}
            />

            <div className="space-y-1">
                {files.length === 0 && (
                    <p className="text-xs text-slate-500">Yüklenen dosya yok.</p>
                )}
                {files.map((file) => (
                    <div
                        key={`${file.name}-${file.size}-${file.lastModified}`}
                        className="text-xs text-slate-200 bg-slate-800/70 border border-slate-700 rounded px-2 py-1 truncate"
                        title={file.name}
                    >
                        {file.name}
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function DataUploadPage() {
    const {
        activeCompany,
        activeUploads,
        setActiveUploads,
        clearActiveUploads,
        patchActiveCompany,
    } = useCompany();
    const [kebirError, setKebirError] = useState<string | null>(null);
    const [kebirLoading, setKebirLoading] = useState(false);
    const [activeUploadTab, setActiveUploadTab] = useState<'kdv' | 'cari' | 'kebir'>('kdv');

    const setReconciliationFiles = (
        key: 'eInvoiceFiles' | 'accountingFiles' | 'accountingMatrahFiles',
        files: File[]
    ) => {
        setActiveUploads((current) => ({
            ...current,
            reconciliation: {
                ...current.reconciliation,
                [key]: files,
            },
        }));
    };

    const clearVoucherEditLogsBySource = async (source: VoucherEditSource) => {
        await patchActiveCompany((company) => {
            const currentAccount = company.currentAccount;
            if (!currentAccount) return {};

            const nextLogs = (currentAccount.voucherEditLogs || []).filter((log) => log.source !== source);
            return {
                currentAccount: {
                    ...currentAccount,
                    voucherEditLogs: nextLogs,
                },
            };
        });
    };

    const setCurrentAccountFile = async (key: 'smmmFile' | 'firmaFile', file: File | null) => {
        setActiveUploads((current) => ({
            ...current,
            currentAccount: {
                ...current.currentAccount,
                [key]: file,
            },
        }));

        if (!file || !activeCompany) return;

        const source: VoucherEditSource = key === 'firmaFile' ? 'FIRMA' : 'SMMM';
        const sourceLabel = source === 'FIRMA' ? 'Firma' : 'SMMM';
        const hasSourceLogs = (activeCompany.currentAccount?.voucherEditLogs || []).some((log) => log.source === source);
        if (!hasSourceLogs) return;

        const shouldClear = window.confirm(
            `${sourceLabel} kaynağında kayıtlı fiş düzenleme geçmişi var. Yeni dosya yüklenirken bu kayıtlar silinsin mi?`
        );
        if (!shouldClear) return;

        await clearVoucherEditLogsBySource(source);
    };

    const handleKebirUpload = async (file: File | null) => {
        setKebirError(null);

        setActiveUploads((current) => ({
            ...current,
            kebirFile: file,
        }));

        if (!file) {
            await patchActiveCompany(() => ({ kebirAnalysis: undefined }));
            return;
        }

        setKebirLoading(true);
        try {
            const result = await parseKebirFile(file);
            await patchActiveCompany(() => ({
                kebirAnalysis: result,
            }));
        } catch (error) {
            console.error('Kebir parse error:', error);
            setKebirError(error instanceof Error ? error.message : 'Kebir dosyası işlenemedi.');
        } finally {
            setKebirLoading(false);
        }
    };

    // State for processing
    const [processingState, setProcessingState] = useState<{
        type: 'EINVOICE' | 'ACCOUNTING' | 'ACCOUNTING_MATRAH' | null;
        file: File | null;
        mode: 'SALES' | 'PURCHASE'; // Defaulting to SALES for now, maybe add a toggle later
    }>({ type: null, file: null, mode: 'SALES' });

    const [isProcessingModalOpen, setIsProcessingModalOpen] = useState(false);

    const handleProcessClick = (
        type: 'EINVOICE' | 'ACCOUNTING' | 'ACCOUNTING_MATRAH',
        file: File
    ) => {
        setProcessingState({ type, file, mode: 'SALES' }); // Default to Sales for now
        setIsProcessingModalOpen(true);
    };

    const handleMappingComplete = async (mapping: Record<string, string>, headerRowIndex: number) => {
        const { file, type, mode } = processingState;
        if (!file || !type) return;

        setKebirLoading(true); // Reuse loading state or create a new one
        setIsProcessingModalOpen(false);

        try {

            // let result; // Removing this to use scoped typed variables
            if (type === 'EINVOICE') {
                const result = await processEInvoiceFile(file, mapping, headerRowIndex, mode) as ExcelProcessResult<EInvoiceRow[]>;
                if (result.success && result.data) {
                    await patchActiveCompany((company) => {
                        const currentData = company.reconciliation?.eInvoiceData || [];
                        return {
                            reconciliation: {
                                ...company.reconciliation,
                                eInvoiceData: [...currentData, ...result.data!]
                            }
                        };
                    });
                }
            } else if (type === 'ACCOUNTING') {
                const result = await processAccountingFile(file, mapping, headerRowIndex, mode) as ExcelProcessResult<AccountingRow[]>;
                if (result.success && result.data) {
                    await patchActiveCompany((company) => {
                        const currentData = company.reconciliation?.accountingData || [];
                        return {
                            reconciliation: {
                                ...company.reconciliation,
                                accountingData: [...currentData, ...result.data!]
                            }
                        };
                    });
                }
            } else if (type === 'ACCOUNTING_MATRAH') {
                const result = await processAccountingMatrahFile(file, mapping, headerRowIndex) as ExcelProcessResult<AccountingMatrahRow[]>;
                if (result.success && result.data) {
                    await patchActiveCompany((company) => {
                        const currentData = company.reconciliation?.accountingMatrahData || [];
                        return {
                            reconciliation: {
                                ...company.reconciliation,
                                accountingMatrahData: [...currentData, ...result.data!]
                            }
                        };
                    });
                }
            }

            // Error handling moved to individual blocks or use a shared error var if needed
            // For now, simplifiying to avoid "result used before assigned" complexity with different types


        } catch (error) {
            console.error('Processing error:', error);
            alert('İşlem sırasında bir hata oluştu.');
        } finally {
            setKebirLoading(false);
            setProcessingState({ type: null, file: null, mode: 'SALES' });
        }
    };

    const getCanonicalFields = () => {
        const { type, mode } = processingState;
        if (type === 'EINVOICE') {
            return mode === 'SALES' ? SALES_EINVOICE_FIELDS : PURCHASE_EINVOICE_FIELDS;
        } else if (type === 'ACCOUNTING') {
            return mode === 'SALES' ? SALES_ACCOUNTING_VAT_FIELDS : PURCHASE_ACCOUNTING_VAT_FIELDS;
        } else if (type === 'ACCOUNTING_MATRAH') {
            return ACCOUNTING_MATRAH_FIELDS;
        }
        return [];
    };

    const resetCompanyData = async () => {
        clearActiveUploads();
        setKebirError(null);
        await patchActiveCompany(() => ({
            reconciliation: undefined,
            currentAccount: undefined,
            kebirAnalysis: undefined,
        }));
    };

    if (!activeCompany) {
        return <NoCompanySelected moduleName="Veri Yükleme" />;
    }

    const smmmFiles = activeUploads.currentAccount.smmmFile ? [activeUploads.currentAccount.smmmFile] : [];
    const firmaFiles = activeUploads.currentAccount.firmaFile ? [activeUploads.currentAccount.firmaFile] : [];
    const kebirFiles = activeUploads.kebirFile ? [activeUploads.kebirFile] : [];

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-sm font-bold text-white uppercase tracking-wide">Veri Yukleme</h1>
                    <div className="h-4 w-px bg-slate-700" />
                    <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded border border-blue-500/20 text-xs">{activeCompany.name}</span>
                </div>

                <Button
                    variant="danger"
                    size="sm"
                    leftIcon={<RefreshCcw size={12} />}
                    onClick={() => {
                        if (window.confirm('Firma verilerini sıfırlamak istiyor musunuz?')) {
                            void resetCompanyData();
                        }
                    }}
                >
                    Sifirla
                </Button>
            </div>

            {/* Tab Navigation */}
            <div className="flex gap-1 bg-slate-900/50 p-1 rounded-xl border border-slate-700/50">
                {[
                    { id: 'kdv' as const, label: 'KDV Mutabakat', icon: FileSpreadsheet },
                    { id: 'cari' as const, label: 'Cari Hesap', icon: Layers },
                    { id: 'kebir' as const, label: 'Kebir Analiz', icon: CheckCircle2 },
                ].map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveUploadTab(tab.id)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all flex-1 justify-center ${activeUploadTab === tab.id
                            ? 'bg-blue-600 text-white shadow'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                            }`}
                    >
                        <tab.icon size={16} />
                        {tab.label}
                    </button>
                ))}
            </div>

            {activeUploadTab === 'kdv' && (
                <Card className="space-y-4">
                    <div className="flex items-center gap-2">
                        <FileSpreadsheet size={18} className="text-blue-400" />
                        <h2 className="text-lg font-semibold text-white">KDV Mutabakat Dosyaları</h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <UploadPanel
                            title="E-Fatura Listeleri"
                            description="Satış/alış kontrolü için e-fatura listelerini seçin."
                            files={activeUploads.reconciliation.eInvoiceFiles}
                            multiple
                            onSelect={(files) => setReconciliationFiles('eInvoiceFiles', files)}
                            onProcess={(file) => handleProcessClick('EINVOICE', file)}
                            isProcessed={(activeCompany.reconciliation?.eInvoiceData || []).length > 0}
                        />
                        <UploadPanel
                            title="Muhasebe KDV"
                            description="191/391 tarafındaki muhasebe KDV dosyalarını seçin."
                            files={activeUploads.reconciliation.accountingFiles}
                            multiple
                            onSelect={(files) => setReconciliationFiles('accountingFiles', files)}
                            onProcess={(file) => handleProcessClick('ACCOUNTING', file)}
                            isProcessed={(activeCompany.reconciliation?.accountingData || []).length > 0}
                        />
                        <UploadPanel
                            title="Muhasebe Matrah"
                            description="Satış modülü için matrah dosyalarını seçin."
                            files={activeUploads.reconciliation.accountingMatrahFiles}
                            multiple
                            onSelect={(files) => setReconciliationFiles('accountingMatrahFiles', files)}
                            onProcess={(file) => handleProcessClick('ACCOUNTING_MATRAH', file)}
                            isProcessed={(activeCompany.reconciliation?.accountingMatrahData || []).length > 0}
                        />
                    </div>
                </Card>
            )}

            {activeUploadTab === 'cari' && (
                <Card className="space-y-4">
                    <div className="flex items-center gap-2">
                        <Layers size={18} className="text-indigo-400" />
                        <h2 className="text-lg font-semibold text-white">Cari Hesap Kontrol Dosyaları</h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <UploadPanel
                            title="SMMM Kebir Dosyası"
                            description="SMMM tarafından gelen tek dosya seçilir."
                            files={smmmFiles}
                            onSelect={(files) => {
                                void setCurrentAccountFile('smmmFile', files[0] || null);
                            }}
                        />
                        <UploadPanel
                            title="Firma Kebir Dosyası"
                            description="Firma tarafından gelen tek dosya seçilir."
                            files={firmaFiles}
                            onSelect={(files) => {
                                void setCurrentAccountFile('firmaFile', files[0] || null);
                            }}
                        />
                    </div>
                </Card>
            )}

            {activeUploadTab === 'kebir' && (
                <Card className="space-y-4">
                    <div className="flex items-center gap-2">
                        <CheckCircle2 size={18} className="text-emerald-400" />
                        <h2 className="text-lg font-semibold text-white">Kebir Analiz Dosyası</h2>
                    </div>
                    <UploadPanel
                        title="Kebir Dosyası"
                        description="Dosya yüklendiginde analiz otomatik çalıştırılır ve kaydedilir."
                        files={kebirFiles}
                        onSelect={(files) => {
                            void handleKebirUpload(files[0] || null);
                        }}
                    />

                    {kebirLoading && (
                        <p className="text-sm text-blue-300">Kebir dosyası analiz ediliyor...</p>
                    )}

                    {!kebirLoading && activeCompany.kebirAnalysis && (
                        <p className="text-sm text-emerald-300">
                            Kebir analizi hazır. Kebir Analizi modülü doğrudan bu veriyi kullanacak.
                        </p>
                    )}

                    {kebirError && (
                        <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                            <AlertCircle size={16} className="mt-0.5 shrink-0" />
                            <p>{kebirError}</p>
                        </div>
                    )}
                </Card>
            )}


            {/* Processing Modal */}
            {
                isProcessingModalOpen && processingState.file && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
                        <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto">
                            <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl overflow-hidden">
                                <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
                                    <h3 className="text-lg font-bold text-white">Veri İşleme Sihirbazı</h3>
                                    <button
                                        onClick={() => setIsProcessingModalOpen(false)}
                                        className="text-slate-400 hover:text-white transition-colors"
                                    >
                                        Kapat
                                    </button>
                                </div>
                                <div className="p-1">
                                    <MappingStep
                                        file={processingState.file}
                                        canonicalFields={getCanonicalFields()}
                                        onComplete={handleMappingComplete}
                                        onCancel={() => setIsProcessingModalOpen(false)}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }
        </div >
    );
}
