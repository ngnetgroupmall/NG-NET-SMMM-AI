import { lazy, Suspense, useState } from 'react';
import { AlertCircle, Layers } from 'lucide-react';
import AppShell from './components/layout/AppShell';
import HeroSection from './components/dashboard/HeroSection';
import FeatureCards from './components/dashboard/FeatureCards';
import CommandPalette from './components/common/CommandPalette';
import CompanyStatusCard from './components/dashboard/CompanyStatusCard';
import RecentActivity from './components/dashboard/RecentActivity';
import { useReconciliation } from './features/reconciliation/hooks/useReconciliation';
import { useCompany } from './context/CompanyContext';

const ReconciliationWizard = lazy(async () => {
  const module = await import('./features/reconciliation/components/ReconciliationWizard');
  return { default: module.ReconciliationWizard };
});
const DataUploadPage = lazy(() => import('./features/data-upload/DataUploadPage'));
const FaturaXmlPage = lazy(() => import('./features/fatura-xml/FaturaXmlPage'));
const KebirAnalysisPage = lazy(() => import('./features/kebir-analysis/components/KebirAnalysisPage'));
const MizanPage = lazy(() => import('./features/mizan/MizanPage'));
const TemporaryTaxPage = lazy(() => import('./features/temporary-tax/TemporaryTaxPage'));
const VoucherEditReportPage = lazy(() => import('./features/voucher-edit-report/VoucherEditReportPage'));
const VoucherListPage = lazy(() => import('./features/voucher-list/VoucherListPage'));
const CurrentAccountControlPage = lazy(() => import('./features/current-account-control/CurrentAccountControlPage'));

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [kdvMode, setKdvMode] = useState<'SALES' | 'PURCHASE'>('SALES');
  const recon = useReconciliation();
  const { state, actions } = recon;
  const { activeCompany } = useCompany();

  const handleTabChange = (tab: string) => {
    if (tab === 'sales') {
      setKdvMode('SALES');
      setActiveTab('kdv-control');
      return;
    }
    if (tab === 'purchase') {
      setKdvMode('PURCHASE');
      setActiveTab('kdv-control');
      return;
    }
    setActiveTab(tab);
  };

  const handleStart = (mode: 'SALES' | 'PURCHASE') => {
    setKdvMode(mode);
    setActiveTab('kdv-control');
    void actions.resetAll();
    actions.setStep(1);
  };

  const handleKdvModeChange = (mode: 'SALES' | 'PURCHASE') => {
    if (mode === kdvMode) return;
    setKdvMode(mode);
    void actions.resetAll();
    actions.setStep(1);
  };

  const lazyFallback = (
    <div className="flex items-center justify-center h-[40vh] text-slate-400 text-sm">
      Modül yükleniyor...
    </div>
  );

  return (
    <AppShell activeTab={activeTab} onTabChange={handleTabChange} version={__APP_VERSION__}>
      <CommandPalette onNavigate={handleTabChange} />
      {state.loading && (
        <div className="fixed inset-0 bg-[var(--bg-dark)]/80 backdrop-blur-md z-[100] flex flex-col items-center justify-center gap-6 animate-fade-in">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-blue-500/30 rounded-full animate-spin" />
            <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin absolute top-0 left-0" />
          </div>
          <p className="text-xl font-bold text-white tracking-wide animate-pulse">İşleminiz yapılıyor...</p>
        </div>
      )}

      {state.error && (
        <div className="fixed top-24 right-8 z-[100] bg-red-500 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-right duration-300">
          <AlertCircle size={24} />
          <div>
            <p className="font-bold">Bir hata oluştu</p>
            <p className="text-sm opacity-90">{state.error}</p>
          </div>
          <button onClick={() => actions.setError(null)} className="ml-4 hover:bg-white/20 p-1 rounded transition-colors">X</button>
        </div>
      )}

      {state.updateInfo && (
        <div className="fixed bottom-8 right-8 z-[100] bg-slate-800 border border-blue-500/50 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-right duration-300 max-w-md">
          <div className="bg-blue-500/20 p-2 rounded-full">
            <Layers className="text-blue-400 animate-pulse" size={24} />
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-start">
              <p className="font-bold text-blue-400">Güncelleme</p>
              <button
                onClick={actions.dismissUpdate}
                className="text-slate-400 hover:text-white transition-colors"
              >
                X
              </button>
            </div>
            <p className="text-sm text-slate-300">{state.updateInfo.message}</p>
            {state.updateInfo.progress !== undefined && !state.updateInfo.downloaded && (
              <div className="w-full bg-slate-700 h-1.5 rounded-full mt-2 overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${state.updateInfo.progress}%` }}
                />
              </div>
            )}
            {state.updateInfo.downloaded && (
              <button
                onClick={() => window.electronAPI?.restartApp()}
                className="mt-2 text-xs bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded text-white font-bold transition-colors"
              >
                Şimdi yeniden başlat
              </button>
            )}
          </div>
        </div>
      )}

      {activeTab === 'dashboard' && (
        <div className="space-y-8 animate-fade-in">
          <HeroSection onStart={handleStart} />
          {activeCompany && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <CompanyStatusCard />
              <RecentActivity />
            </div>
          )}
          <FeatureCards onAction={(id) => {
            if (id === 'upload') handleTabChange('data-upload');
            else if (id === 'sales') handleStart('SALES');
            else if (id === 'purchase') handleStart('PURCHASE');
            else if (id === 'fatura-xml') handleTabChange('fatura-xml');
            else if (id === 'mizan') handleTabChange('mizan');
            else if (id === 'temporary-tax') handleTabChange('temporary-tax');
            else if (id === 'voucher-list') handleTabChange('voucher-list');
            else if (id === 'voucher-edit-report') handleTabChange('voucher-edit-report');
            else if (id === 'current-account') handleTabChange('current-account');
            else handleTabChange(id);
          }} />
        </div>
      )}

      {activeTab === 'data-upload' && (
        <Suspense fallback={lazyFallback}>
          <DataUploadPage />
        </Suspense>
      )}

      {activeTab === 'fatura-xml' && (
        <Suspense fallback={lazyFallback}>
          <FaturaXmlPage />
        </Suspense>
      )}

      {activeTab === 'kdv-control' && (
        <Suspense fallback={lazyFallback}>
          <div className="space-y-4 animate-fade-in">
            <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold text-white">KDV Kontrol</h2>
                <p className="text-xs text-slate-400 mt-1">Satış ve alış kontrolü tek modül altında yönetilir.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleKdvModeChange('SALES')}
                  className={`px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors ${kdvMode === 'SALES'
                    ? 'bg-blue-600/20 border-blue-500/40 text-blue-200'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-blue-500/40'
                    }`}
                >
                  Satış Kontrol
                </button>
                <button
                  type="button"
                  onClick={() => handleKdvModeChange('PURCHASE')}
                  className={`px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors ${kdvMode === 'PURCHASE'
                    ? 'bg-purple-600/20 border-purple-500/40 text-purple-200'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-purple-500/40'
                    }`}
                >
                  Alış Kontrol
                </button>
              </div>
            </div>
            <ReconciliationWizard recon={recon} mode={kdvMode} />
          </div>
        </Suspense>
      )}

      {activeTab === 'kebir' && (
        <Suspense fallback={lazyFallback}>
          <KebirAnalysisPage />
        </Suspense>
      )}

      {activeTab === 'mizan' && (
        <Suspense fallback={lazyFallback}>
          <MizanPage />
        </Suspense>
      )}

      {activeTab === 'temporary-tax' && (
        <Suspense fallback={lazyFallback}>
          <TemporaryTaxPage />
        </Suspense>
      )}

      {activeTab === 'voucher-edit-report' && (
        <Suspense fallback={lazyFallback}>
          <VoucherEditReportPage />
        </Suspense>
      )}

      {activeTab === 'voucher-list' && (
        <Suspense fallback={lazyFallback}>
          <VoucherListPage />
        </Suspense>
      )}

      {activeTab === 'current-account' && (
        <Suspense fallback={lazyFallback}>
          <CurrentAccountControlPage />
        </Suspense>
      )}

      {activeTab === 'reports' && (
        <div className="space-y-6 animate-fade-in">
          <div className="flex items-center gap-2.5 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl mb-4">
            <h1 className="text-sm font-bold text-white uppercase tracking-wide">Rapor Gecmisi</h1>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-8 text-center">
            <div className="w-20 h-20 bg-slate-700/50 rounded-full flex items-center justify-center mb-4 mx-auto">
              <Layers className="text-slate-500 w-10 h-10" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Yakında Aktif</h3>
            <p className="text-slate-400 text-sm max-w-md mx-auto">Geçmiş mutabakat ve analiz sonuçlarınız burada listelenecek. Bu özellik üzerinde çalışıyoruz.</p>
          </div>
        </div>
      )}

      {activeTab === 'support' && (
        <div className="space-y-6 animate-fade-in">
          <div className="flex items-center gap-2.5 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl mb-4">
            <h1 className="text-sm font-bold text-white uppercase tracking-wide">Destek Merkezi</h1>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-8 text-center">
            <div className="w-20 h-20 bg-slate-700/50 rounded-full flex items-center justify-center mb-4 mx-auto">
              <Layers className="text-blue-500 w-10 h-10" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Yardıma mı İhtiyacınız Var?</h3>
            <p className="text-slate-400 text-sm max-w-md mx-auto mb-4">Sorunlarınız veya önerileriniz için bizimle iletişime geçin.</p>
            <p className="text-blue-400 text-sm font-mono">destek@ngnet.com.tr</p>
          </div>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="space-y-6 animate-fade-in">
          <div className="flex items-center gap-2.5 px-3 py-2 bg-slate-800/40 border-b border-slate-700/60 rounded-t-xl mb-4">
            <h1 className="text-sm font-bold text-white uppercase tracking-wide">Ayarlar</h1>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-8 text-center">
            <div className="w-20 h-20 bg-slate-700/50 rounded-full flex items-center justify-center mb-4 mx-auto">
              <Layers className="text-slate-500 w-10 h-10" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Uygulama Ayarları</h3>
            <p className="text-slate-400 text-sm max-w-md mx-auto">Firma yönetimi için sol üstteki firma seçicisini kullanabilirsiniz. Ek ayarlar yakında eklenecek.</p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
