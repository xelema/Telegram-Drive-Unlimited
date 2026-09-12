import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { ConfirmProvider, useConfirm } from '../../src/context/ConfirmContext';
vi.mock('../../src/services/feedback', () => ({ triggerHaptic: vi.fn() }));
function Caller({ complete }: { complete: (choice: string | null) => void }) {
  const { chooseDownloadCollision } = useConfirm();
  return <button onClick={() => void chooseDownloadCollision().then(complete)}>Start download</button>;
}
describe('download collision dialog', () => {
  it('defaults each new choice to keep both, even after explicit replacement', async () => {
    const complete = vi.fn();
    render(<ConfirmProvider><Caller complete={complete} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }));
    await screen.findByRole('dialog');
    expect((screen.getByRole('radio', { name: /Keep both/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Replace existing files/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download and allow replacement' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith('replace'));
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }));
    await screen.findByRole('dialog');
    expect((screen.getByRole('radio', { name: /Keep both/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Continue download' }));
    await waitFor(() => expect(complete).toHaveBeenLastCalledWith('keep_both'));
  });
  it('cancels without making an overwrite choice on Escape', async () => {
    const complete = vi.fn();
    render(<ConfirmProvider><Caller complete={complete} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(complete).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
