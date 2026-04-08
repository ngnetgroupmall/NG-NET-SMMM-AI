import { useState, useEffect } from 'react';
import { parseKebirFile } from '../utils/kebirParser';
import UploadSection from './UploadSection';
import AnalysisDashboard from './AnalysisDashboard';
import { AlertCircle } from 'lucide-react';
import { useCompany } from '../../../context/CompanyContext';
import NoCompanySelected from '../../../components/common/NoCompanySelected';

export default function KebirAnalysisPage() {
    const { activeCompany, patchActiveCompany, setActiveUploads } = useCompany();
    const [step, setStep] = useState<'UPLOAD' | 'ANALYSIS'>('UPLOAD');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Initialize state from active company
    useEffect(() => {
        if (activeCompany?.kebirAnalysis) {
            setStep('ANALYSIS');
        } else {
            setStep('UPLOAD');
        }
    }, [activeCompany?.id, activeCompany?.kebirAnalysis]);

    const handleFileSelect = async (file: File) => {
        if (!activeCompany) return;

        setActiveUploads((current) => ({
            ...current,
            kebirFile: file,
        }));
        setLoading(true);
        setError(null);
        try {
            const result = await parseKebirFile(file);

            // Save to DB via global context
            await patchActiveCompany(() => ({
                kebirAnalysis: result,
            }));

            setStep('ANALYSIS');
        } catch (err: unknown) {
            console.error(err);
            setError(err instanceof Error ? err.message : 'Dosya işlenirken bilinmeyen bir hata oluştu.');
        } finally {
            setLoading(false);
        }
    };

    const handleReset = async () => {
        if (!activeCompany) return;

        setActiveUploads((current) => ({
            ...current,
            kebirFile: null,
        }));
        // Clear data from DB
        await patchActiveCompany(() => ({
            kebirAnalysis: undefined,
        }));

        setStep('UPLOAD');
        setError(null);
    };

    if (!activeCompany) {
        return <NoCompanySelected moduleName="Kebir Analizi" />;
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-2.5 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl">
                <h1 className="text-sm font-bold text-white uppercase tracking-wide">Kebir Analizi</h1>
                <div className="h-4 w-px bg-slate-700" />
                <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded border border-blue-500/20 text-xs">{activeCompany.name}</span>
            </div>

            {loading && (
                <div className="flex flex-col items-center justify-center py-20 animate-fade-in">
                    <div className="w-16 h-16 border-4 border-blue-500/30 rounded-full animate-spin mb-4">
                        <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin absolute top-0 left-0"></div>
                    </div>
                    <p className="text-lg font-bold text-white animate-pulse">Dosya Analiz Ediliyor...</p>
                    <p className="text-slate-400 text-sm mt-2">Bu işlem dosya boyutuna göre biraz zaman alabilir.</p>
                </div>
            )}

            {!loading && error && (
                <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-4 flex items-center gap-4 text-red-200 animate-in fade-in slide-in-from-top-4">
                    <AlertCircle className="shrink-0" size={24} />
                    <div>
                        <p className="font-bold text-red-100">Hata Oluştu</p>
                        <p>{error}</p>
                    </div>
                    <button
                        onClick={() => setError(null)}
                        className="ml-auto hover:bg-red-500/20 p-2 rounded-lg transition-colors"
                    >
                        Tekrar Dene
                    </button>
                </div>
            )}

            {!loading && !error && step === 'UPLOAD' && (
                <UploadSection onFileSelect={handleFileSelect} />
            )}

            {!loading && !error && step === 'ANALYSIS' && activeCompany.kebirAnalysis && (
                <AnalysisDashboard data={activeCompany.kebirAnalysis} onReset={handleReset} />
            )}
        </div>
    );
}
