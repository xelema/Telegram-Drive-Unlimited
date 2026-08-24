import { useCallback, useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AlertTriangle, CheckCircle2, ExternalLink, Heart, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useSupporter } from '../../context/SupporterContext';
import { shouldOfferNewSupporterPurchase } from '../../services/supporterVisibility';

const SUPPORT_URL = 'https://github.com/caamer20/Telegram-Drive/issues/new/choose';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MobileSupporterCard() {
  const { status, latestRecoveryCode, beginCheckout, pollCheckout, activate, refreshEntitlement, refreshStatus } = useSupporter();
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newRecoveryCode, setNewRecoveryCode] = useState('');

  const termsUrl = status.terms_url ?? 'https://github.com/caamer20/Telegram-Drive/blob/main/SUPPORTER_TERMS.md';
  const canPurchase = shouldOfferNewSupporterPurchase(status) && !status.checkout_pending;
  const canRestore = !status.ad_free && !status.checkout_pending && !['loading', 'revoked'].includes(status.state);
  const canRefresh = ['active', 'needs_refresh', 'expired'].includes(status.state);

  const checkPayment = useCallback(async (quiet = false) => {
    try {
      const result = await pollCheckout();
      if (result.status === 'completed') {
        setCheckoutPending(false);
        if (result.recovery_code) setNewRecoveryCode(result.recovery_code);
        toast.success('Payment verified. Android sponsor ads are now disabled.');
      } else if (result.status === 'failed' || result.status === 'expired') {
        setCheckoutPending(false);
        await refreshStatus();
        if (!quiet) toast.error(result.message);
      } else if (!quiet) {
        toast.info(result.message);
      }
    } catch (error) {
      if (!quiet) toast.error(message(error));
    }
  }, [pollCheckout, refreshStatus]);

  useEffect(() => {
    setCheckoutPending(Boolean(status.checkout_pending && !status.ad_free));
  }, [status.ad_free, status.checkout_pending]);

  const startCheckout = async () => {
    setBusy(true);
    try {
      const checkout = await beginCheckout(status.terms_version);
      await openUrl(checkout.approval_url);
      setCheckoutPending(true);
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  };

  const restorePurchase = async () => {
    if (!recoveryCode.trim()) return;
    setBusy(true);
    try {
      await activate(recoveryCode.trim(), status.terms_version);
      setRecoveryCode('');
      toast.success('Lifetime ad-free access was restored on this Android device.');
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-telegram-primary/25 bg-telegram-primary/5 p-4" aria-labelledby="android-supporter-title">
      <div className="flex items-start gap-3">
        <Heart className="mt-0.5 h-5 w-5 flex-none text-telegram-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id="android-supporter-title" className="text-sm font-semibold text-telegram-text">$5 lifetime ad-free license</h3>
          <p className="mt-1 text-[11px] leading-5 text-telegram-subtext">Every feature stays free. One verified PayPal payment removes Android sponsor ads—no subscription.</p>
        </div>
      </div>

      <div className={`mt-3 rounded-xl border p-3 text-[11px] leading-5 ${status.ad_free ? 'border-emerald-400/25 bg-emerald-400/10' : 'border-telegram-border/30 bg-telegram-bg/45'}`}>
        <div className="flex items-center gap-2 font-semibold text-telegram-text">
          {status.state === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : status.ad_free ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <KeyRound className="h-4 w-4 text-telegram-primary" />}
          {status.state === 'loading' ? 'Checking license…' : status.ad_free ? 'Lifetime ad-free access is active' : 'No verified license is active'}
        </div>
        <p className="mt-1 text-telegram-subtext">{status.message}</p>
        {status.ad_free && <p className="mt-1 text-telegram-subtext">The Android Keystore keeps this device activated through normal app updates.</p>}
      </div>

      {canPurchase && (
        <div className="mt-4 rounded-xl border border-telegram-primary/25 bg-telegram-bg/55 p-4 text-center">
          <p className="text-3xl font-bold text-telegram-text">$5 <span className="text-xs font-medium text-telegram-subtext">USD once</span></p>
          <div className="mt-3 grid gap-2 text-left text-[11px] text-telegram-subtext">
            {['Android sponsor ads removed for life', 'Up to three supported devices total', 'Recovery code for reinstalls and another device'].map(item => (
              <span key={item} className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-none text-emerald-400" />{item}</span>
            ))}
          </div>
        </div>
      )}

      {(newRecoveryCode || latestRecoveryCode) && (
        <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-[11px] leading-5 text-telegram-subtext">
          <strong className="text-telegram-text">Save your recovery code now</strong>
          <code className="mt-2 block select-all break-all rounded-lg bg-telegram-bg/70 px-3 py-2 font-mono text-xs text-telegram-text">{newRecoveryCode || latestRecoveryCode}</code>
          <p className="mt-2">It is encrypted by Android Keystore on this device, but an offline copy is needed after uninstalling or replacing the device.</p>
        </div>
      )}

      {checkoutPending && !status.ad_free && (
        <div className="mt-3 rounded-xl border border-telegram-primary/25 bg-telegram-primary/10 p-3 text-[11px] leading-5 text-telegram-subtext" role="status">
          <strong className="text-telegram-text">Waiting for PayPal confirmation</strong>
          <p>Return to Telegram Drive after checkout. Verification resumes automatically.</p>
        </div>
      )}

      {(canPurchase || canRestore) && (
        <label className="mt-4 flex items-start gap-2 text-[10px] leading-4 text-telegram-subtext">
          <input type="checkbox" checked={acceptedTerms} onChange={event => setAcceptedTerms(event.target.checked)} className="mt-0.5 accent-[var(--color-telegram-primary)]" />
          <span>I accept the <button type="button" onClick={event => { event.preventDefault(); void openUrl(termsUrl); }} className="text-telegram-primary underline">Supporter Terms</button>, device limit, recovery responsibility, and refund/reversal policy.</span>
        </label>
      )}

      {canPurchase && (
        <details className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-4 text-telegram-subtext">
          <summary className="flex cursor-pointer items-center gap-2 font-semibold text-telegram-text"><AlertTriangle className="h-3.5 w-3.5 text-amber-300" />Purchase and refund information</summary>
          <p className="mt-2">Refunds are not automatic or guaranteed except where required by law. Refunds, reversals, chargebacks, and upheld disputes revoke ad-free access. PayPal handles payment; Telegram Drive does not store your card details or PayPal email.</p>
        </details>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {canPurchase && (
          <button type="button" disabled={!acceptedTerms || busy || checkoutPending} onClick={() => void startCheckout()} className="rounded-xl bg-telegram-primary px-4 py-2.5 text-[11px] font-semibold text-white disabled:opacity-50">
            {busy ? 'Preparing checkout…' : checkoutPending ? 'Checkout opened' : 'Get lifetime ad-free · $5'}
          </button>
        )}
        {checkoutPending && <button type="button" onClick={() => void checkPayment()} className="rounded-xl border border-telegram-border/40 px-3 py-2.5 text-[11px] font-semibold text-telegram-text">Check payment</button>}
        {canRefresh && (
          <button type="button" onClick={() => void refreshEntitlement().then(() => toast.success('License verification refreshed.')).catch(error => toast.error(message(error)))} className="flex items-center gap-1.5 rounded-xl border border-telegram-border/40 px-3 py-2.5 text-[11px] font-semibold text-telegram-text">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        )}
        <button type="button" onClick={() => void openUrl(termsUrl)} className="flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-[11px] text-telegram-primary"><ExternalLink className="h-3.5 w-3.5" /> Terms</button>
      </div>

      {canRestore && (
        <details className="mt-4 rounded-xl border border-telegram-border/30 bg-telegram-bg/45 p-3">
          <summary className="cursor-pointer text-[11px] font-semibold text-telegram-text">Already supported? Restore your license</summary>
          <p className="mt-2 text-[10px] leading-4 text-telegram-subtext">Use the recovery code from another activated device or a previous installation. This counts toward the three-device limit.</p>
          <input value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autoComplete="off" spellCheck={false} className="mt-3 w-full rounded-xl border border-telegram-border/40 bg-telegram-bg px-3 py-2.5 text-xs text-telegram-text outline-none focus:border-telegram-primary" />
          <button type="button" disabled={!acceptedTerms || !recoveryCode.trim() || busy} onClick={() => void restorePurchase()} className="mt-2 w-full rounded-xl border border-telegram-primary/30 bg-telegram-primary/10 px-3 py-2.5 text-[11px] font-semibold text-telegram-primary disabled:opacity-50">Restore lifetime license</button>
        </details>
      )}

      {status.state === 'unavailable' && (
        <button type="button" onClick={() => void openUrl(SUPPORT_URL)} className="mt-3 text-[10px] text-telegram-primary underline">Open activation help</button>
      )}
    </section>
  );
}
