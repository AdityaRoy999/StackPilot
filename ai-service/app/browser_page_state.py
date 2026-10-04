"""Small, event-driven page identity updates, independent of DOM extraction."""

PAGE_STATE_BINDING = "__stackpilotPageState"
PAGE_STATE_SCRIPT = r"""
(() => {
  if (window !== window.top || window.__spPageStateInstalled) return;
  window.__spPageStateInstalled = true;
  let previous = '';
  const publish = () => {
    const payload = JSON.stringify({url: location.href, title: document.title});
    if (payload === previous) return;
    if (typeof window.__stackpilotPageState === 'function') {
      window.__stackpilotPageState(payload);
      previous = payload;
    }
  };
  const observer = new MutationObserver(publish);
  const watchTitle = () => {
    observer.disconnect();
    if (document.head) observer.observe(document.head, {subtree: true, childList: true, characterData: true});
    publish();
  };
  document.addEventListener('DOMContentLoaded', watchTitle, {once: true});
  for (const event of ['pageshow', 'hashchange', 'popstate']) window.addEventListener(event, publish);
  watchTitle();
})();
"""
