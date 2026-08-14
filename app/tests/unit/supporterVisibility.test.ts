import { describe, expect, it } from 'vitest';
import {
  isSupporterPromptDue,
  shouldShowSponsorContent,
  SUPPORTER_PROMPT_INTERVAL_MS,
} from '../../src/services/supporterVisibility';

describe('supporter visibility', () => {
  it('waits for entitlement resolution before allowing sponsor content', () => {
    expect(shouldShowSponsorContent({ state: 'loading', ad_free: false })).toBe(false);
    expect(shouldShowSponsorContent({ state: 'active', ad_free: true })).toBe(false);
    expect(shouldShowSponsorContent({ state: 'needs_refresh', ad_free: true })).toBe(false);
    expect(shouldShowSponsorContent({ state: 'inactive', ad_free: false })).toBe(true);
  });

  it('offers supporter access once per 24-hour launch window to unlicensed users', () => {
    const now = 2_000_000_000_000;
    const inactive = { state: 'inactive', ad_free: false };

    expect(isSupporterPromptDue(inactive, 0, now)).toBe(true);
    expect(isSupporterPromptDue(inactive, now - SUPPORTER_PROMPT_INTERVAL_MS + 1, now)).toBe(false);
    expect(isSupporterPromptDue(inactive, now - SUPPORTER_PROMPT_INTERVAL_MS, now)).toBe(true);
    expect(isSupporterPromptDue({ state: 'active', ad_free: true }, 0, now)).toBe(false);
  });

  it('recovers safely from a system clock moving backwards', () => {
    expect(isSupporterPromptDue(
      { state: 'inactive', ad_free: false },
      2_000_000,
      1_000_000,
    )).toBe(true);
  });
});
