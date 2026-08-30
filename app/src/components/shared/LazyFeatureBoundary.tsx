import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface BoundaryState {
  error: Error | null;
}

class ChunkErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) console.error('[LazyFeature] Failed to load optional feature', error, info);
  }

  render(): ReactNode {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

export function LazyFeatureBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const loading = (
    <div className="fixed inset-0 z-[240] flex items-center justify-center bg-app-canvas/75 backdrop-blur-sm" role="status" aria-live="polite">
      <div className="viewer-panel flex items-center gap-3 px-4 py-3 text-sm text-app-text">
        <Loader2 className="h-4 w-4 animate-spin text-app-accent" aria-hidden="true" />
        {t('common.loading')}
      </div>
    </div>
  );
  const failed = (
    <div className="fixed inset-0 z-[240] flex items-center justify-center bg-app-canvas/80 p-4 backdrop-blur-sm" role="alert">
      <div className="viewer-panel max-w-sm p-5 text-center text-app-text">
        <p className="font-semibold">{t('common.operation_failed')}</p>
        <button type="button" className="quiet-control mt-4 inline-flex items-center gap-2 px-3 py-2 text-app-accent" onClick={() => window.location.reload()}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t('common.retry')}
        </button>
      </div>
    </div>
  );

  return (
    <ChunkErrorBoundary fallback={failed}>
      <Suspense fallback={loading}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}
