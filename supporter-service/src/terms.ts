import type { Env } from './types';

export function supporterTermsHtml(env: Env): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Drive Supporter Terms</title></head>
<body style="margin:0;background:#0f172a;color:#e2e8f0;font:16px/1.6 system-ui,sans-serif">
<main style="max-width:720px;margin:auto;padding:40px 24px">
<h1>Telegram Drive Supporter Terms</h1>
<p><strong>Terms version:</strong> ${env.TERMS_VERSION}</p>
<p>The supporter purchase is an optional, one-time payment of ${env.SUPPORTER_PRICE} ${env.SUPPORTER_CURRENCY}. It activates ad-free use on up to ${env.MAX_ACTIVE_DEVICES} desktop devices. The application’s core file-management features remain available without purchasing.</p>
<h2>Activation and recovery</h2>
<p>Payment does not create a Telegram Drive account. Activation requires the desktop app to contact the Telegram Drive supporter service and receive a valid entitlement. Keep the recovery code shown after payment. Losing every activated device and the recovery code may make restoration impossible.</p>
<h2>Refunds, reversals, and disputes</h2>
<p><strong>Refunds are not automatic and are not guaranteed, except where applicable law requires otherwise.</strong> Contact the project maintainer before purchasing if you are unsure whether activation will work in your environment. Any refund, payment reversal, chargeback, or upheld payment dispute revokes the associated ad-free entitlement.</p>
<h2>Availability</h2>
<p>The supporter service may be temporarily unavailable because of network, PayPal, operating-system, or third-party outages. Reasonable efforts will be made to restore valid purchases, but uninterrupted availability is not promised. These terms do not exclude rights or remedies that cannot legally be excluded.</p>
<p>The payment purchases only the supporter entitlement described above. It is not a promise that every sponsor request will be blocked in every build, operating system, network condition, or third-party integration. To the maximum extent permitted by law, the project and its contributors are not liable for indirect, incidental, special, consequential, or punitive loss arising from the supporter feature, and aggregate liability relating to the supporter payment will not exceed the amount paid for that entitlement. These limits do not apply where liability cannot legally be limited, including mandatory consumer rights and responsibility reserved by law for fraud, willful misconduct, or gross negligence.</p>
<h2>Privacy</h2>
<p>Telegram Drive does not request or store your PayPal email address. It stores only the minimum payment identifiers, entitlement status, accepted terms version, and cryptographic device identifiers needed to verify access and handle refunds or reversals. PayPal separately processes the payment under its own terms and privacy policy. Cloudflare processes network requests needed to operate the verification service under its own privacy and security terms; Telegram Drive does not add IP addresses or raw PayPal webhook payloads to its D1 entitlement records.</p>
</main></body></html>`;
}

export function checkoutResultHtml(title: string, message: string, success: boolean): string {
  const accent = success ? '#22c55e' : '#f59e0b';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#0f172a;color:#e2e8f0;font:16px/1.6 system-ui,sans-serif"><main style="max-width:560px;margin:10vh auto;padding:32px"><div style="border:1px solid #334155;border-radius:16px;padding:28px;background:#1e293b"><h1 style="color:${accent}">${title}</h1><p>${message}</p><p>You may close this page and return to Telegram Drive.</p></div></main></body></html>`;
}
