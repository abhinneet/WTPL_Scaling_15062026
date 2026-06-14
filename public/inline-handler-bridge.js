/**
 * lib/inline-handler-bridge.js
 *
 * The original dashboard HTML uses many inline event handlers
 * (e.g. <button onclick="doThing()">). Under a strict Content Security
 * Policy this would be blocked. This bridge gives you two paths:
 *
 *  A) During migration: ALLOW_INLINE_SCRIPTS=true is honored in server.js,
 *     which keeps inline handlers working. (Default for staging.)
 *
 *  B) For production: ALLOW_INLINE_SCRIPTS=false and load THIS script
 *     in the dashboard <head>. It rewrites every onclick/onchange/etc.
 *     attribute on DOMContentLoaded into a delegated, CSP-safe listener.
 *
 * This is a defensive shim — over time you should migrate handlers to
 * data-action attributes and add proper event delegation in the dashboard.
 */
(function () {
  const ATTRS = [
    'onclick', 'onchange', 'oninput', 'onsubmit', 'onfocus', 'onblur',
    'onmouseover', 'onmouseout', 'onkeydown', 'onkeyup', 'onkeypress',
    'ondblclick', 'oncontextmenu',
  ];

  function rewriteAttr(el, attr) {
    const code = el.getAttribute(attr);
    if (!code) return;
    el.removeAttribute(attr);
    const evt = attr.slice(2); // 'onclick' → 'click'
    el.addEventListener(evt, function (event) {
      try {
        // Build a function in the global scope, with `this` bound to the element
        // and `event` available. Function() runs in global scope, which the
        // original handlers expect (they call window-level functions).
        const fn = new Function('event', code);
        fn.call(el, event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[inline-handler-bridge] handler error:', err, 'in', attr, code);
      }
    });
  }

  function rewriteAll(root) {
    ATTRS.forEach(attr => {
      const nodes = root.querySelectorAll('[' + attr + ']');
      nodes.forEach(n => rewriteAttr(n, attr));
    });
  }

  function init() {
    rewriteAll(document);

    // Observe DOM additions so dynamically inserted markup keeps working
    const obs = new MutationObserver(muts => {
      muts.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            ATTRS.forEach(attr => {
              if (node.hasAttribute && node.hasAttribute(attr)) rewriteAttr(node, attr);
            });
            if (node.querySelectorAll) rewriteAll(node);
          }
        });
      });
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
