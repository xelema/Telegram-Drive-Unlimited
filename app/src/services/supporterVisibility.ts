export const SUPPORTER_PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface SupporterVisibilityStatus {
  state: string;
  ad_free: boolean;
}

export function shouldShowSponsorContent(status: SupporterVisibilityStatus): boolean {
  return status.state !== 'loading' && !status.ad_free;
}

export function isSupporterPromptDue(
  status: SupporterVisibilityStatus,
  lastShownAt: number,
  now = Date.now(),
): boolean {
  if (!shouldShowSponsorContent(status)) return false;
  if (!Number.isFinite(lastShownAt) || lastShownAt <= 0) return true;
  const elapsed = now - lastShownAt;
  return elapsed < 0 || elapsed >= SUPPORTER_PROMPT_INTERVAL_MS;
}
