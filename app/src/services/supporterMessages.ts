import type { CheckoutPollResult, SupporterStatus } from '../context/SupporterContext';
import '../i18n/supporterTranslations';

type Translate = (key: string) => string;

/** Presentation only: entitlement and checkout decisions remain in their existing owners. */
export function supporterStatusMessage(status: SupporterStatus, t: Translate): string {
  const key = status.state === 'loading' ? 'status_loading'
    : status.state === 'needs_refresh' ? 'status_grace'
      : status.ad_free ? 'status_active'
        : status.state === 'revoked' ? 'status_revoked'
          : status.state === 'expired' ? 'status_expired'
            : status.state === 'inactive' ? 'status_inactive'
              : /not configured in this build/i.test(status.message) ? 'status_unconfigured'
                : /unavailable on this platform|available in supported desktop and Android builds/i.test(status.message) ? 'status_unsupported'
                  : /device (?:credential|identity).*(?:missing|match)|secure.*device.*key.*missing/i.test(status.message) ? 'status_recovery_needed'
                    : 'status_unavailable';
  return t(`supporter_license.${key}`);
}

/** Do not interpolate service errors: they may contain URLs, identifiers, or credentials. */
export function supporterErrorMessage(error: unknown, t: Translate): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const key = /TERMS_NOT_ACCEPTED|accept the current supporter terms/i.test(raw) ? 'error_terms'
    : /DEVICE_LIMIT_REACHED|already active on \d+ devices|device limit/i.test(raw) ? 'error_device_limit'
      : /RECOVERY_CODE_INVALID|recovery code is invalid/i.test(raw) ? 'error_recovery'
        : /existing purchase or payment verification/i.test(raw) ? 'returning_warning'
          : /keychain|keystore|secure credential|secure storage/i.test(raw) ? 'error_storage'
            : /unable to reach|network|connection|timed? ?out|temporarily unavailable/i.test(raw) ? 'error_network'
              : 'error_generic';
  return t(`supporter_license.${key}`);
}

export function supporterPaymentMessage(result: CheckoutPollResult, t: Translate): string {
  if (result.status === 'completed') {
    return t(`supporter_license.${/recovery information is still pending/i.test(result.message) ? 'recovery_pending' : 'payment_verified'}`);
  }
  if (/closed without a payment/i.test(result.message)) return t('supporter_license.payment_unpaid');
  if (result.status === 'failed' || result.status === 'expired') return t('supporter_license.payment_closed');
  return t('supporter_license.payment_pending');
}
