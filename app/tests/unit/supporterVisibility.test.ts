import { describe, expect, it } from 'vitest';
import {
  isSupporterPromptDue,
  shouldOfferNewSupporterPurchase,
  shouldShowSupporterPrompt,
  shouldShowSponsorContent,
  sponsorAdCooldownRemaining,
  SPONSOR_AD_INTERVAL_MS,
  SUPPORTER_PROMPT_INTERVAL_MS,
} from '../../src/services/supporterVisibility';

describe('supporter visibility', () => {
  it('waits for entitlement resolution before allowing sponsor content', () => {
    expect(shouldShowSponsorContent({ state: 'loading', ad_free: false })).toBe(false);
    expect(shouldShowSponsorContent({ state: 'active', ad_free: true })).toBe(false);
    expect(shouldShowSponsorContent({ state: 'needs_refresh', ad_free: true })).toBe(false);
    expect(shouldShowSponsorContent({ state: 'inactive', ad_free: false })).toBe(true);
  });

  it('offers supporter access once per 24-hour value-moment window to unlicensed users', () => {
    const now = 2_000_000_000_000;
    const inactive = { state: 'inactive', ad_free: false };

    expect(isSupporterPromptDue(inactive, 0, now)).toBe(true);
    expect(isSupporterPromptDue(inactive, now - SUPPORTER_PROMPT_INTERVAL_MS + 1, now)).toBe(false);
    expect(isSupporterPromptDue(inactive, now - SUPPORTER_PROMPT_INTERVAL_MS, now)).toBe(true);
    expect(isSupporterPromptDue({ state: 'active', ad_free: true }, 0, now)).toBe(false);
  });

  it('never asks an existing purchaser to buy again', () => {
    expect(shouldOfferNewSupporterPurchase({ state: 'active', ad_free: true })).toBe(false);
    expect(shouldOfferNewSupporterPurchase({ state: 'needs_refresh', ad_free: true })).toBe(false);
    expect(shouldOfferNewSupporterPurchase({ state: 'expired', ad_free: false })).toBe(false);
    expect(shouldOfferNewSupporterPurchase({ state: 'revoked', ad_free: false })).toBe(false);
    expect(shouldOfferNewSupporterPurchase({ state: 'inactive', ad_free: false, recovery_code_saved: true })).toBe(false);
    expect(shouldOfferNewSupporterPurchase({ state: 'inactive', ad_free: false, recovery_code_saved: false })).toBe(true);

    expect(isSupporterPromptDue({ state: 'expired', ad_free: false }, 0)).toBe(false);
    expect(isSupporterPromptDue({ state: 'inactive', ad_free: false, recovery_code_saved: true }, 0)).toBe(false);
    expect(shouldShowSupporterPrompt({ state: 'inactive', ad_free: false, checkout_pending: true }, 0)).toBe(false);
  });

  it('recovers safely from a system clock moving backwards', () => {
    expect(isSupporterPromptDue(
      { state: 'inactive', ad_free: false },
      2_000_000,
      1_000_000,
    )).toBe(true);
  });

  it('uses a 15-minute sponsor cooldown and recovers from invalid clocks', () => {
    const now = 2_000_000_000_000;

    expect(SPONSOR_AD_INTERVAL_MS).toBe(15 * 60 * 1_000);
    expect(sponsorAdCooldownRemaining(null, now)).toBe(0);
    expect(sponsorAdCooldownRemaining(now - SPONSOR_AD_INTERVAL_MS + 1, now)).toBe(1);
    expect(sponsorAdCooldownRemaining(now - SPONSOR_AD_INTERVAL_MS, now)).toBe(0);
    expect(sponsorAdCooldownRemaining(now + 1, now)).toBe(0);
  });
});
