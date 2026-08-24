import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../../context/ConfirmContext';
import { SettingsProvider } from '../../context/SettingsContext';
import { SupporterProvider } from '../../context/SupporterContext';
import { SyncProvider } from '../../context/SyncContext';
import { ThemeProvider } from '../../context/ThemeContext';
import { UploadChoiceProvider } from '../../context/UploadChoiceContext';
import { EncryptionProvider } from '../../hooks/useEncryption';
import { ErrorBoundary } from './ErrorBoundary';

interface AppProvidersProps {
  children: ReactNode;
}

/**
 * Owns application-wide services and preserves their dependency order.
 *
 * The QueryClient belongs to this mounted application tree rather than the
 * JavaScript module, preventing Fast Refresh from sharing stale cache state
 * across replaced application instances.
 */
export function AppProviders({ children }: AppProvidersProps) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ConfirmProvider>
            <SettingsProvider>
              <SupporterProvider>
                <SyncProvider>
                  <UploadChoiceProvider>
                    <EncryptionProvider>{children}</EncryptionProvider>
                  </UploadChoiceProvider>
                </SyncProvider>
              </SupporterProvider>
            </SettingsProvider>
          </ConfirmProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
