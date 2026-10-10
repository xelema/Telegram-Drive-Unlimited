# Sponsor placement acceptance for v4.0.0

The established media/share loopback origin remains the default. On desktop, start the candidate with `TELEGRAM_DRIVE_AD_ORIGIN=separate` to select a dedicated OS-assigned loopback listener. Startup health reports `sponsor_port`; the frame and its message checks use that actual port. In separate mode the media server's ad routes are inert, and the ad server exposes no media, share or HLS routes. Failure of the separate listener shows the bounded fallback; it does not silently revert to the media origin. No setting or entitlement migration is required.

**Owner decision:** switching the default to the separate origin waits for this matrix to be completed and reviewed. The existing return interval is **15 minutes**; older release notes saying 45 minutes do not change the current constant. Any different interval is a separate owner decision.

## Current evidence

Native child-process journeys use real loopback HTTP, synthetic signed device-bound entitlements and a controlled loader HTTP server. They exercise route isolation, actual ports/CSP, active and offline-grace 204 suppression, invalid-token rejection, deadline expiry, and verification during fresh/stale loader responses. The controlled loader replaces the provider's network boundary; it does not establish Adsterra delivery, real secure-storage behavior, production revocation or WebView behavior. Browser journeys use the application UI with a simulated native boundary and static sponsor frame.

The fallback UA is Chrome154's reduced desktop UA, based on the [official stable release announcement of 22 September 2026](https://chromereleases.googleblog.com/2026/09/stable-channel-update-for-desktop_0856730748.html). A nonempty request UA is forwarded unchanged. The Adsterra loader URL, direct loader, relay validation, DNS-over-HTTPS fallback, sandbox and external-link bridge remain in place.

## Required matrix

Every cell below is **UNRUN**. Record OS, app build, WebView version, date, tester and observed provider delivery/failure reason. Run desktop rows with both default and separate origins; Android uses its existing external sponsor banner/gateway and has no desktop loopback creative.

| Runtime | Default origin / existing placement | Selectable separate origin | Supporter / recovery / update | Result |
| --- | --- | --- | --- | --- |
| Windows WebView2 | UNRUN | UNRUN | UNRUN | UNRUN |
| macOS WKWebView | UNRUN | UNRUN | UNRUN | UNRUN |
| Linux WebKitGTK | UNRUN | UNRUN | UNRUN | UNRUN |
| Android WebView / Google TV | UNRUN on device | Not applicable: desktop-only listener; confirm unchanged external placement | UNRUN | UNRUN |

For every applicable origin/runtime:

1. Start free, confirm the optional post-sign-in gateway, continue without opening an offer, and verify every feature remains available.
2. Load the actual creative directly; force direct-loader failure to exercise the validated relay, and normal DNS failure to exercise the existing DoH recovery. Record CSP/network errors and provider delivery separately.
3. Occupy the preferred media port. Confirm actual media/sponsor ports, CSP and message-origin/source checks follow the bound listeners. In separate mode confirm media ad routes are inert, ad routes cannot access media/share/HLS, and the sponsor origin is not accepted by media CORS.
4. Block the provider/relay and verify the fallback appears within 12 seconds. Check translated loading/status/countdown and screen-reader labels. Countdown begins after loaded/fallback, dismisses after 10 seconds, manual dismissal works, and the banner returns after 15 minutes within the same session. Restart must clear the legacy persisted dismissal.
5. Open the fallback and creative links by real user activation. Confirm the intended external browser destination, `noopener,noreferrer` fallback and unchanged bridge; reject untrusted message origin/source and unsafe URL schemes.
6. Hold entitlement loading, then verify active and offline-grace supporters see no gateway/banner/frame or sponsor request. Direct local `/ad-banner` and `/ad-script` requests return204/no-store after verified local state loads. A verification arriving during a pending relay must suppress its final body, including retained stale fallback.
7. Check temporary offline refresh failure preserves ad-free access through the signed grace deadline, existing recovery works within the three-device allowance, and an update preserves activation. No second payment prompt. A sandbox revocation exercise requires explicit owner authorization; do not use live PayPal or production state.
8. Exit while the frame/relay is active, restart, and confirm both desktop loopback listeners close and reopen cleanly. On Android/TV check external sponsor action, dismissal, D-pad focus and lifecycle on actual hardware.

The backend is an additional hiding layer only. Its RAM cache is populated by the existing local signature/device verification and expires at the signed offline deadline. HTTP handlers do not call the supporter network service, secure storage or backup health, and cannot cause frontend sponsor content to appear. Telegram sign-out does not clear this device-wide entitlement.
