// No network access. Only the app's own bundled files and the Tauri IPC
// channel are reachable. This backs up the Content Security Policy in
// tauri.conf.json; MediaPipe otherwise POSTs usage metrics to Google.
// Each blocked attempt is reported to the native side, which logs it.
(() => {
  const isAllowed = (url) => {
    try {
      const u = new URL(url, location.href);
      return (
        u.origin === location.origin ||
        u.protocol === 'ipc:' || // Tauri IPC on macOS
        u.hostname === 'ipc.localhost' || // Tauri IPC on Windows
        u.protocol === 'blob:' ||
        u.protocol === 'data:'
      );
    } catch {
      return false;
    }
  };

  const report = (url) => {
    window.__TAURI__?.core.invoke('net_blocked', { url: String(url) }).catch(() => {});
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isAllowed(url)) {
      report(url);
      return Promise.reject(new TypeError(`Network access is disabled: ${url}`));
    }
    return realFetch(input, init);
  };

  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (!isAllowed(url)) {
      report(url);
      throw new TypeError(`Network access is disabled: ${url}`);
    }
    return realOpen.call(this, method, url, ...rest);
  };

  // Anything else (images, sockets, …) is stopped by the CSP; log it too.
  document.addEventListener('securitypolicyviolation', (e) => report(e.blockedURI));
})();
