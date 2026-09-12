import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCheckoutRecovery, startSupporterRenewal } from '../../src/services/supporterRenewal';
import type { SupporterStatus } from '../../src/context/SupporterContext';

const state = (value: SupporterStatus['state']): SupporterStatus => ({ state:value, ad_free:['active','needs_refresh'].includes(value),message:'',terms_version:'2026-08-11',terms_url:null,expires_at:0,offline_until:0,recovery_code_saved:true,checkout_pending:false });
let stop: (()=>void)|undefined;
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{stop?.();stop=undefined;vi.useRealTimers();});
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('bounded supporter renewal',()=>{
  it('renews a known expired token without initiating another purchase',async()=>{
    const readStatus=vi.fn().mockResolvedValue(state('expired'));
    const refresh=vi.fn().mockResolvedValue(state('active'));
    stop=startSupporterRenewal({isAndroid:false,readStatus,refresh});await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10*60_000);expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('includes an expired entitlement after Android secure storage becomes ready',async()=>{
    const readStatus=vi.fn().mockResolvedValueOnce(state('unavailable')).mockResolvedValue(state('expired'));
    const refresh=vi.fn().mockResolvedValue(state('active'));
    stop=startSupporterRenewal({isAndroid:true,readStatus,refresh});await flush();
    expect(refresh).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1500);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('stops after three failed attempts and retries when connectivity returns',async()=>{
    const readStatus=vi.fn().mockResolvedValue(state('expired'));
    const refresh=vi.fn().mockRejectedValue(new Error('offline'));
    stop=startSupporterRenewal({isAndroid:false,readStatus,refresh});await flush();
    await vi.advanceTimersByTimeAsync(30_000);await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(60*60_000);expect(refresh).toHaveBeenCalledTimes(3);
    refresh.mockResolvedValue(state('active'));window.dispatchEvent(new Event('online'));await flush();
    expect(refresh).toHaveBeenCalledTimes(4);
  });
  it.each([false, true])('bounds native status-read failures without an extra unavailable retry (Android: %s)', async isAndroid => {
    const readStatus = vi.fn()
      .mockRejectedValueOnce(new Error('Credential read failed'))
      .mockRejectedValueOnce(new Error('Credential read still unavailable'))
      .mockResolvedValue(state('unavailable'));
    const refresh = vi.fn();
    stop = startSupporterRenewal({ isAndroid, readStatus, refresh });
    await flush();
    expect(readStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('keeps offline-grace entitlement eligible without modifying its cached status',async()=>{
    const cached=Object.freeze(state('needs_refresh'));
    const readStatus=vi.fn().mockResolvedValue(cached);const refresh=vi.fn().mockRejectedValue(new Error('outage'));
    stop=startSupporterRenewal({isAndroid:false,readStatus,refresh});await flush();
    expect(cached.ad_free).toBe(true);expect(cached.state).toBe('needs_refresh');
    expect(readStatus).toHaveBeenCalledTimes(2);
  });
  it('does not automatically refresh inactive or verified revoked records',async()=>{
    let current=state('revoked');const readStatus=vi.fn(async()=>current);const refresh=vi.fn();
    stop=startSupporterRenewal({isAndroid:false,readStatus,refresh});await flush();
    current=state('inactive');window.dispatchEvent(new Event('online'));await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('stops retrying once a failed refresh has persisted verified revocation',async()=>{
    const readStatus=vi.fn().mockResolvedValueOnce(state('active')).mockResolvedValue(state('revoked'));
    const refresh=vi.fn().mockRejectedValue(new Error('ENTITLEMENT_NOT_ACTIVE'));
    stop=startSupporterRenewal({isAndroid:false,readStatus,refresh});await flush();
    await vi.advanceTimersByTimeAsync(60*60_000);expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('coalesces duplicate reconnect signals and removes listeners/timers on disposal',async()=>{
    let finish!:(value:SupporterStatus)=>void;
    const readStatus=vi.fn().mockResolvedValue(state('expired'));
    const refresh=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(state('active'));
    stop=startSupporterRenewal({isAndroid:false,readStatus,refresh});await flush();
    window.dispatchEvent(new Event('online'));window.dispatchEvent(new CustomEvent('android-environment-change',{detail:{connected:true}}));
    expect(refresh).toHaveBeenCalledTimes(1);finish(state('active'));await flush();
    expect(refresh).toHaveBeenCalledTimes(2);stop();
    await vi.advanceTimersByTimeAsync(1000);window.dispatchEvent(new Event('online'));await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});


describe('bounded pending payment recovery', () => {
  it('backs off after repeated pending responses and can resume on reconnect', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'pending' });
    stop = startCheckoutRecovery(poll);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(poll).toHaveBeenCalledTimes(7);
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(poll).toHaveBeenCalledTimes(8);
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(poll).toHaveBeenCalledTimes(8);
  });
  it('never overlaps pending requests or lets a completed request restart disposed timers', async () => {
    let finish!: () => void;
    const poll = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    stop = startCheckoutRecovery(poll);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    stop(); finish(); await flush();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
