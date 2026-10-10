# Cloud-password command contract

`cmd_auth_check_password` in `app/src-tauri/src/commands/auth.rs` currently returns either `Ok(AuthResult { success: true, next_step: dashboard, error: None })` or a command error. It has no `success: false` return.

Authentication/account acquisition, a missing consumed password challenge and verified-account completion may fail through `?` or a command error. `grammers_client::SignInError::InvalidPassword` renews the password challenge, then returns `Err(INVALID_TWO_STEP_PASSWORD)`. Other client failures renew the challenge and return `Err(2FA Failed: …)`. The success branch is the only constructed response.

Consequently a rejected cloud password enters the frontend's `handleAuthError` and displays the specific backend error. The generic canonical `common.operation_failed` fallback only handles a hypothetical unsuccessful response outside the current command contract. No production authentication code, credentials, locale resources or byte ceilings changed in this review.

The browser contract journey uses the actual sign-in UI with controlled native responses. It verifies the specific rejected-password message, then injects a clearly counterfactual `success: false` response to exercise the defensive generic branch, then signs in successfully. That injected response is not evidence of backend reachability. The existing wrong-password recovery/restart journey also passes. Live Telegram, real password challenge renewal and installed credential behavior remain UNRUN.
