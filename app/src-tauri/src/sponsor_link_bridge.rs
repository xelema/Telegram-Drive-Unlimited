use tauri::{plugin::TauriPlugin, Runtime};

// Tauri's opener integration runs in the main frame only. Provider creatives
// live in nested frames, so their target=_blank links would otherwise be
// blocked by the desktop WebView. This bridge runs in subframes, accepts only
// trusted user clicks or an active user gesture, and relays HTTP(S) URLs one
// frame upward until the loopback ad host can pass them to the application.
const SPONSOR_LINK_BRIDGE_SCRIPT: &str = r#"
(() => {
  if (window.top === window) return;

  const messageType = 'telegram-drive:ad-link';
  let lastForwardedAt = 0;

  const forwardDestination = (destination) => {
    try {
      const url = new URL(String(destination), document.baseURI);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

      const now = Date.now();
      if (now - lastForwardedAt < 500) return true;
      lastForwardedAt = now;
      window.parent.postMessage({ type: messageType, url: url.href }, '*');
      return true;
    } catch (_) {
      return false;
    }
  };

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source === window.parent || !message || message.type !== messageType) return;
    if (typeof message.url !== 'string') return;
    if (navigator.userActivation?.isActive !== true) return;
    window.parent.postMessage({ type: messageType, url: message.url }, '*');
  });

  window.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const anchor = path.find((node) => node && node.nodeType === 1 && node.tagName === 'A');
    if (!anchor || !anchor.href) return;
    if (forwardDestination(anchor.href)) event.preventDefault();
  });

  const nativeOpen = window.open.bind(window);
  window.open = (destination, target, features) => {
    if (navigator.userActivation?.isActive === true && forwardDestination(destination)) return null;
    return nativeOpen(destination, target, features);
  };
})();
"#;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("sponsor-link-bridge")
        .js_init_script_on_all_frames(SPONSOR_LINK_BRIDGE_SCRIPT)
        .build()
}
