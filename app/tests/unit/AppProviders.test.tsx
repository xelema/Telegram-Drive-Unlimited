import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../src/components/shared/AppProviders';

vi.mock('../../src/components/shared/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => (
    <section data-provider="error-boundary">{children}</section>
  ),
}));

vi.mock('../../src/context/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => (
    <section data-provider="theme">{children}</section>
  ),
}));

vi.mock('../../src/context/ConfirmContext', () => ({
  ConfirmProvider: ({ children }: { children: ReactNode }) => (
    <section data-provider="confirm">{children}</section>
  ),
}));

vi.mock('../../src/context/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: ReactNode }) => (
    <section data-provider="settings">{children}</section>
  ),
}));

vi.mock('../../src/context/SupporterContext', () => ({
  SupporterProvider: ({ children }: { children: ReactNode }) => (
    <section data-provider="supporter">{children}</section>
  ),
}));

vi.mock('../../src/context/SyncContext', () => ({
  SyncProvider: ({ children }: { children: ReactNode }) => (
    <section data-provider="sync">{children}</section>
  ),
}));

vi.mock('../../src/context/UploadChoiceContext', () => ({
  UploadChoiceProvider: ({ children }: { children: ReactNode }) => (
    <section data-provider="upload-choice">{children}</section>
  ),
}));

vi.mock('../../src/hooks/useEncryption', () => ({
  EncryptionProvider: ({ children }: { children: ReactNode }) => (
    <section data-provider="encryption">{children}</section>
  ),
}));

function QueryClientProbe({ clients }: { clients: QueryClient[] }) {
  clients.push(useQueryClient());
  return <span data-testid="provider-child">ready</span>;
}

describe('AppProviders', () => {
  it('preserves provider dependency order', () => {
    const { container } = render(
      <AppProviders>
        <span>content</span>
      </AppProviders>,
    );

    const order: string[] = [];
    let current = container.firstElementChild;
    while (current?.hasAttribute('data-provider')) {
      order.push(current.getAttribute('data-provider') ?? '');
      current = current.firstElementChild;
    }

    expect(order).toEqual([
      'error-boundary',
      'theme',
      'confirm',
      'settings',
      'supporter',
      'sync',
      'upload-choice',
      'encryption',
    ]);
  });

  it('retains one QueryClient per mounted application tree', () => {
    const clients: QueryClient[] = [];
    const firstTree = render(
      <AppProviders>
        <QueryClientProbe clients={clients} />
      </AppProviders>,
    );
    const firstClient = clients.at(-1);
    expect(firstClient?.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);

    firstTree.rerender(
      <AppProviders>
        <QueryClientProbe clients={clients} />
      </AppProviders>,
    );
    expect(clients.at(-1)).toBe(firstClient);

    firstTree.unmount();
    render(
      <AppProviders>
        <QueryClientProbe clients={clients} />
      </AppProviders>,
    );
    expect(clients.at(-1)).not.toBe(firstClient);
  });
});
