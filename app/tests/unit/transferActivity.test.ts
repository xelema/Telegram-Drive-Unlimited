import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { readTransferActivity, redactedTransferReport, projectActivityJob, type ActivityJob } from '../../src/services/transferActivity';
import { uploadItemToTransferRequest, downloadItemToTransferRequest } from '../../src/services/desktopTransferEngine';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const record: ActivityJob = {
  id: 'private-id', ownerId: 'private-account', filename: 'private-file.pdf', path: '/Users/private/file',
  url: 'https://private.test/file?token=secret', folderId: 7788, messageId: 111,
  error: 'secret path and credential details', errorCategory: 'network', direction: 'upload', kind: 'url_upload',
  status: 'failed', progress: 40, transferredBytes: 2000, totalBytes: 5000, speedBytesPerSec: 0,
  queuePosition: 2, revision: 10, createdAt: 10, updatedAt: 20,
};

describe('account-scoped transfer activity', () => {
  it('rejects a late snapshot and a foreign record even inside a matching snapshot', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ownerId: 'old', jobs: [], legacy: [] });
    await expect(readTransferActivity('current')).rejects.toThrow('ACCOUNT_CHANGED');
    vi.mocked(invoke).mockResolvedValueOnce({ ownerId: 'current', jobs: [record], legacy: [] });
    await expect(readTransferActivity('current')).rejects.toThrow('ACCOUNT_CHANGED');
  });
  it('exports only allowlisted diagnostics with no paths, names, account identifiers or remote details', () => {
    const report = redactedTransferReport([record], new Date('2026-09-10T00:00:00Z'));
    expect(report).not.toMatch(/private|secret|7788|111|credential|https/);
    expect(JSON.parse(report).transfers).toEqual([{ direction: 'upload', kind: 'url_upload', status: 'failed', errorCategory: 'network', progress: 40, persistencePending: false }]);
    const malformed = redactedTransferReport([{ ...record, errorCategory: 'secret-token' as never, status: 'private-path' as never, progress: Number.NaN }]);
    expect(malformed).not.toMatch(/secret|private/);
    expect(JSON.parse(malformed).transfers[0]).toMatchObject({ status: null, errorCategory: null, progress: 0 });
  });
  it('redacts protected metadata while retaining the identity and mode required to retry', () => {
    const protectedJob = { ...record, protectionMode: 'vault_and_passphrase', protectMetadata: true, savePath: '/private/destination', tempZipPath: '/private/source.zip' };
    const projected = projectActivityJob(protectedJob);
    expect(projected).toMatchObject({ id: record.id, ownerId: record.ownerId, protectionMode: 'vault_and_passphrase', filename: '', totalBytes: 0 });
    for (const field of ['path', 'url', 'savePath', 'tempZipPath', 'error'] as const) expect(projected[field]).toBeUndefined();
    expect(protectedJob.filename).toBe('private-file.pdf');
    expect(projectActivityJob({ ...record, protectionMode: 'standard', protectMetadata: true }).filename).toBe(record.filename);
    expect(projectActivityJob({ ...record, protectionMode: 'standard', status: 'waiting_for_unlock' }).filename).toBe('');
  });
  it('preserves action-time ownership and never auto-assigns an unowned migration', () => {
    expect(uploadItemToTransferRequest({ id: 'up', ownerId: 'account-at-picker-open', path: '/tmp/a', folderId: null, status: 'pending' }).ownerId).toBe('account-at-picker-open');
    expect(downloadItemToTransferRequest({ id: 'down', ownerId: 'old-account', messageId: 5, filename: 'a', folderId: null, savePath: '/tmp/a', status: 'pending' })).toMatchObject({ ownerId: 'old-account', folderId: null });
    expect(uploadItemToTransferRequest({ id: 'legacy', path: '/tmp/a', folderId: null, status: 'pending' }).ownerId).toBeUndefined();
  });
});
