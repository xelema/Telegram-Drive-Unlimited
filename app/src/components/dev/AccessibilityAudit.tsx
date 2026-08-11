import { useEffect } from 'react';

declare global {
  interface Window {
    __TELEGRAM_DRIVE_AXE_RESULTS__?: unknown;
  }
}

/**
 * Development-only axe audit. Launch the dev UI with `?a11y-audit` and the
 * complete result is exposed for CI/browser assertions without entering the
 * production bundle or collecting user data.
 */
export default function AccessibilityAudit() {
  const requested = new URLSearchParams(window.location.search).has('a11y-audit');
  useEffect(() => {
    if (!requested) return;
    window.__TELEGRAM_DRIVE_AXE_RESULTS__ = { status: 'scheduled' };
    document.documentElement.dataset.axeAuditStatus = 'scheduled';
    const timer = window.setTimeout(async () => {
      try {
        const axeModule = await import('axe-core');
        const axe = axeModule.default ?? axeModule;
        const results = await axe.run(document, {
          resultTypes: ['violations', 'incomplete'],
        });
        window.__TELEGRAM_DRIVE_AXE_RESULTS__ = results;
        document.documentElement.dataset.axeAuditStatus = 'complete';
        document.documentElement.dataset.axeAuditViolations = String(results.violations.length);
        window.dispatchEvent(new CustomEvent('telegram-drive-axe-complete', {
          detail: { violations: results.violations.length },
        }));
        if (results.violations.length > 0) {
          console.warn(`[Accessibility] axe found ${results.violations.length} violation groups`, results.violations);
        } else {
          console.info('[Accessibility] axe scan passed');
        }
      } catch (error) {
        window.__TELEGRAM_DRIVE_AXE_RESULTS__ = { status: 'failed', error: String(error) };
        document.documentElement.dataset.axeAuditStatus = 'failed';
        document.documentElement.dataset.axeAuditError = String(error);
        console.error('[Accessibility] axe scan failed to run', error);
      }
    }, 750);
    return () => {
      window.clearTimeout(timer);
      delete document.documentElement.dataset.axeAuditStatus;
      delete document.documentElement.dataset.axeAuditViolations;
      delete document.documentElement.dataset.axeAuditError;
    };
  }, [requested]);

  return requested ? <span hidden data-a11y-audit-runner="active" /> : null;
}
