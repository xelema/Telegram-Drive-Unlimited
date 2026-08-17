export const SUPPORTER_PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const SUPPORTER_VALUE_MOMENT_EVENT = 'telegram-drive-supporter-value-moment';

export type SupporterValueMoment = 'upload_completed' | 'download_completed';

interface SupporterVisibilityStatus {
  state: string;
  ad_free: boolean;
  recovery_code_saved?: boolean;
}

export function shouldShowSponsorContent(status: SupporterVisibilityStatus): boolean {
  return status.state !== 'loading' && !status.ad_free;
}

export function shouldOfferNewSupporterPurchase(status: SupporterVisibilityStatus): boolean {
  return status.state === 'inactive' && !status.ad_free && !status.recovery_code_saved;
}

export function announceSupporterValueMoment(moment: SupporterValueMoment): void {
  window.dispatchEvent(new CustomEvent(SUPPORTER_VALUE_MOMENT_EVENT, { detail: { moment } }));
}

export function isSupporterPromptDue(
  status: SupporterVisibilityStatus,
  lastShownAt: number,
  now = Date.now(),
): boolean {
  if (!shouldOfferNewSupporterPurchase(status)) return false;
  if (!Number.isFinite(lastShownAt) || lastShownAt <= 0) return true;
  const elapsed = now - lastShownAt;
  return elapsed < 0 || elapsed >= SUPPORTER_PROMPT_INTERVAL_MS;
}
