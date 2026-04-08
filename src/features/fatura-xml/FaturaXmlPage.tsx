import { useMemo, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Layers, RefreshCcw, Trash2, Upload } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { useCompany } from '../../context/CompanyContext';
import type { FaturaXmlInvoice } from '../common/types';
import {
    buildFaturaXmlModuleData,
    exportFaturaXmlExcel,
    generateInvoiceHtml,
    parseFaturaXmlFile,
    type ParseProgressState,
} from './utils/parser';

const ACCEPTED_FILES = '.zip,.rar,.7z,.xml';

export default function FaturaXmlPage() {
    const { activeCompany, patchActiveCompany } = useCompany();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [isDragging, setIsDragging] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [selectedInvoice, setSelectedInvoice] = useState<FaturaXmlInvoice | null>(null);
    const [progress, setProgress] = useState<ParseProgressState>({
        phase: 'reading',
        percent: 0,
        message: 'Islem bekleniyor...',
        processedInvoices: 0,
        processedItems: 0,
    });

    const moduleData = activeCompany?.faturaXml ?? null;
    const previewHtml = useMemo(() => {
        if (!selectedInvoice) return '';
        if (selectedInvoice.previewHtml?.trim()) {
            return selectedInvoice.previewHtml;
        }
        return generateInvoiceHtml(selectedInvoice);
    }, [selectedInvoice]);

    const handleProgress = (state: ParseProgressState) => {
        setProgress(state);
    };

    const processFile = async (file: File) => {
        if (!activeCompany) return;
        setErrorMessage(null);
        setIsProcessing(true);
        setSelectedInvoice(null);

        try {
            const parsed = await parseFaturaXmlFile(file, handleProgress);
            const nextModuleData = buildFaturaXmlModuleData(file.name, parsed);
            await patchActiveCompany(() => ({ faturaXml: nextModuleData }));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Dosya islenirken hata olustu.';
            setErrorMessage(message);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleFileSelect = (files: FileList | null) => {
        if (!files || files.length === 0) return;
        void processFile(files[0]);
    };

    const onDragOver = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragging(true);
    };

    const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragging(false);
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragging(false);
        handleFileSelect(event.dataTransfer.files);
    };

    const clearStoredData = async () => {
        if (!activeCompany) return;
        const approved = window.confirm('Bu firmaya ait Fatura XML kaydini silmek istiyor musunuz?');
        if (!approved) return;
        await patchActiveCompany(() => ({ faturaXml: undefined }));
        setSelectedInvoice(null);
        setErrorMessage(null);
        setProgress({
            phase: 'reading',
            percent: 0,
            message: 'Islem bekleniyor...',
            processedInvoices: 0,
            processedItems: 0,
        });
    };

    const downloadExcel = () => {
        if (!moduleData) return;
        try {
            exportFaturaXmlExcel(moduleData.excelRows);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Excel olusturulamadi.';
            setErrorMessage(message);
        }
    };

    if (!activeCompany) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center animate-fade-in">
                <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center mb-6">
                    <Layers className="text-slate-600 w-12 h-12" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Firma secimi gerekli</h2>
                <p className="text-slate-400 max-w-md">Fatura XML modulunu kullanmak icin once firma secin.</p>
            </div>
        );
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl flex-wrap">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-sm font-bold text-white uppercase tracking-wide">Fatura XML</h1>
                    <div className="h-4 w-px bg-slate-700" />
                    <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded border border-blue-500/20 text-xs">{activeCompany.name}</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<RefreshCcw size={12} />}
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isProcessing}
                    >
                        Dosya sec
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<Upload size={12} />}
                        onClick={downloadExcel}
                        disabled={!moduleData || moduleData.excelRows.length === 0}
                    >
                        Excel
                    </Button>
                    <Button
                        variant="danger"
                        size="sm"
                        leftIcon={<Trash2 size={12} />}
                        onClick={() => {
                            void clearStoredData();
                        }}
                        disabled={!moduleData}
                    >
                        Temizle
                    </Button>
                </div>
            </div>

            <Card className="space-y-4">
                <div
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    className={`rounded-xl border-2 border-dashed transition-colors p-8 text-center cursor-pointer ${isDragging
                            ? 'border-blue-400 bg-blue-500/10'
                            : 'border-slate-600 bg-slate-900/40 hover:border-blue-500/60'
                        }`}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <Upload className="mx-auto text-blue-400 mb-3" size={28} />
                    <p className="text-white font-semibold">Arsiv veya XML dosyasini buraya birakin</p>
                    <p className="text-xs text-slate-400 mt-1">Desteklenen formatlar: .zip, .rar, .7z, .xml</p>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept={ACCEPTED_FILES}
                        className="hidden"
                        onChange={(event) => {
                            handleFileSelect(event.target.files);
                            event.target.value = '';
                        }}
                    />
                </div>

                <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-4">
                    <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                        <div
                            className="h-full bg-blue-500 transition-all duration-300"
                            style={{ width: `${progress.percent}%` }}
                        />
                    </div>
                    <p className="text-sm text-slate-300 mt-3">{progress.message}</p>
                    <div className="mt-2 text-xs text-slate-400 flex flex-wrap gap-x-6 gap-y-1">
                        <span>Islenen fatura: {moduleData?.invoiceCount ?? progress.processedInvoices}</span>
                        <span>Cikarilan kalem: {moduleData?.itemCount ?? progress.processedItems}</span>
                        {moduleData?.processedAt && (
                            <span>Son islem: {new Date(moduleData.processedAt).toLocaleString('tr-TR')}</span>
                        )}
                    </div>
                </div>

                {errorMessage && (
                    <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                        <AlertCircle size={16} className="mt-0.5 shrink-0" />
                        <p>{errorMessage}</p>
                    </div>
                )}
            </Card>

            <Card noPadding className="overflow-hidden">
                <div className="p-4 border-b border-slate-700 bg-slate-900/40 flex items-center justify-between">
                    <h2 className="text-white font-semibold">Islenen Faturalar</h2>
                    <span className="text-xs px-2 py-1 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-200">
                        {moduleData?.invoiceCount ?? 0} adet
                    </span>
                </div>
                {!moduleData || moduleData.invoices.length === 0 ? (
                    <div className="p-6 text-sm text-slate-400">Henuz islenmis fatura yok.</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-900/60 text-slate-300">
                                <tr>
                                    <th className="text-left px-4 py-3">Tarih</th>
                                    <th className="text-left px-4 py-3">Fatura No</th>
                                    <th className="text-left px-4 py-3">Firma</th>
                                    <th className="text-left px-4 py-3">Toplam</th>
                                    <th className="text-left px-4 py-3">Islem</th>
                                </tr>
                            </thead>
                            <tbody>
                                {moduleData.invoices.map((invoice) => (
                                    <tr key={invoice.id} className="border-t border-slate-800 text-slate-200">
                                        <td className="px-4 py-3">{invoice.invDate}</td>
                                        <td className="px-4 py-3 font-semibold">{invoice.invNo}</td>
                                        <td className="px-4 py-3">{invoice.companyName || '-'}</td>
                                        <td className="px-4 py-3">{invoice.totalAmountLabel}</td>
                                        <td className="px-4 py-3">
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={() => setSelectedInvoice(invoice)}
                                            >
                                                Goruntule
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            {selectedInvoice && createPortal(
                <div
                    className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
                    onClick={() => setSelectedInvoice(null)}
                >
                    <div
                        className="w-full max-w-6xl h-[88vh] bg-slate-900 border border-slate-700 rounded-xl overflow-hidden"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="h-12 border-b border-slate-700 px-4 flex items-center justify-between">
                            <p className="text-sm text-white font-semibold">
                                Fatura: {selectedInvoice.invNo} - {selectedInvoice.invDate}
                            </p>
                            <Button size="sm" variant="secondary" onClick={() => setSelectedInvoice(null)}>
                                Kapat
                            </Button>
                        </div>
                        <iframe title="Fatura Onizleme" srcDoc={previewHtml} className="w-full h-[calc(100%-48px)]" />
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
