import { Component, type ReactNode } from 'react';
import {useTranslation} from 'react-i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { reportCrash } from '../../services/crashTelemetry';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('ErrorBoundary caught an error:', error, errorInfo);
        sessionStorage.setItem('telegram-drive-recovered-session', 'true');
        reportCrash(error, 'react');
    }

    handleReload = () => {
        window.location.reload();
    };

    render() {
        if (this.state.hasError) {
            return <RecoveryScreen error={this.state.error} onReload={this.handleReload} />;
        }

        return this.props.children;
    }
}

/** The fallback remains reactive after the protected subtree has failed. */
function RecoveryScreen({error,onReload}:{error:Error|null;onReload:()=>void}) {
    const {t} = useTranslation();
    return (
                <div className="h-screen w-screen flex items-center justify-center bg-telegram-bg p-8">
                    <div className="max-w-md w-full bg-telegram-surface border border-telegram-border rounded-2xl p-8 text-center shadow-2xl">
                        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/10 flex items-center justify-center">
                            <AlertTriangle className="w-8 h-8 text-red-400" />
                        </div>
                        <h1 className="text-xl font-semibold text-telegram-text mb-2">{t('runtime.error_title')}</h1>
                        <p className="text-telegram-subtext text-sm mb-6">
                            {t('runtime.error_description')}
                        </p>

                        {error && (
                            <details className="mb-6 text-left">
                                <summary className="text-xs text-telegram-subtext cursor-pointer hover:text-telegram-text transition-colors">
                                    {t('runtime.error_details')}
                                </summary>
                                <pre className="mt-2 p-3 bg-telegram-hover rounded-lg text-xs text-red-400 overflow-auto max-h-32">
                                    {error.message}
                                </pre>
                            </details>
                        )}

                        <button
                            onClick={onReload}
                            className="inline-flex items-center gap-2 px-6 py-3 bg-telegram-primary text-black font-medium rounded-lg hover:bg-telegram-primary/90 transition-colors"
                        >
                            <RefreshCw className="w-4 h-4" />
                            {t('runtime.error_recover')}
                        </button>
                    </div>
                </div>
            );
}
