/* Lynch Digitance — Auto Refresh: "does this page need a human?"
 *
 * Injected into the refreshed tab (isolated world) after each reload, and loaded
 * directly by tests. It reads only text that is already on the page and hands
 * back a tiny verdict: a reason string if the page is blocking or challenging
 * you, plus which of YOUR OWN words appeared. The page text itself never leaves
 * the tab.
 *
 * Deliberately conservative: a false alarm costs a Telegram message and a paused
 * tab, so vague words ("blocked", "captcha") are not enough on their own.
 */
(function (root) {
  'use strict';

  const HUMAN_REASON = 'Human check (captcha or verification)';
  const BLOCK_REASON = 'Blocked or access denied';

  // A human check is on screen. Matched anywhere on the page.
  const HUMAN_CHECK = [
    'verify you are human', 'verify you are a human', "verify you're human", 'verifying you are human',
    'human verification', 'confirm you are human', 'confirm you are not a robot', 'prove you are human',
    'prove you are not a robot', 'i am not a robot', "i'm not a robot", 'are you a robot', 'are you human',
    'press & hold', 'press and hold', 'checking your browser', 'checking if the site connection is secure',
    'complete the security check', 'security check to access', 'solve the captcha', 'complete the captcha',
    'solve this captcha', 'enter the characters you see', 'unusual traffic from your',
    'enable javascript and cookies to continue'
  ];

  // Block pages are short. These only count on a short page, so a long article
  // that merely mentions "access denied" does not trigger an alert.
  const BLOCKED_SHORT = [
    'access denied', 'you have been blocked', 'you are blocked', 'request blocked',
    'your request has been blocked', 'too many requests', 'rate limit exceeded', '403 forbidden',
    'error 1020', 'temporarily blocked', 'your ip has been', 'automated queries', 'suspicious activity'
  ];
  const SHORT_PAGE = 2500; // characters

  // Page titles that mean a security interstitial. Word boundaries keep
  // "Security Checkup" from matching "security check".
  const TITLE_BLOCK = [
    /just a moment/, /attention required/, /access denied/, /are you a robot/,
    /\bsecurity check\b/, /human verification/, /(you have been|request) blocked/
  ];

  // A challenge frame from a known captcha provider.
  const CAPTCHA_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha-delivery/i;

  const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

  /* Pure decision from text alone, so it can be tested without a browser. */
  function scanText(input) {
    const title = norm(input.title);
    const text = norm(input.text);
    let block = null;

    if (input.block !== false) {
      if (HUMAN_CHECK.some((p) => text.includes(p) || title.includes(p))) block = HUMAN_REASON;
      else if (TITLE_BLOCK.some((re) => re.test(title))) block = BLOCK_REASON;
      else if (text.length < SHORT_PAGE && BLOCKED_SHORT.some((p) => text.includes(p))) block = BLOCK_REASON;
      else if (input.captchaFrame) block = HUMAN_REASON;
    }

    const words = [];
    for (const w of input.words || []) {
      const n = norm(w).trim();
      if (n && text.includes(n)) words.push(String(w).trim());
    }
    return { block, words };
  }

  function shown(el, win) {
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 8; n = n.parentElement, i++) {
      const cs = win.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    }
    return true;
  }

  /* A challenge-sized, visible frame. The tiny "protected by reCAPTCHA" badge that
     many ordinary forms carry is under 120px tall and is ignored. */
  function captchaFrameVisible(doc, win) {
    const frames = doc.querySelectorAll ? doc.querySelectorAll('iframe') : [];
    for (const f of frames) {
      const hint = (f.getAttribute('src') || '') + ' ' + (f.getAttribute('title') || '');
      if (!CAPTCHA_FRAME.test(hint)) continue;
      const r = f.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 120 && shown(f, win)) return true;
    }
    return false;
  }

  function scanPage(cfg) {
    const c = cfg || {};
    const doc = root.document;
    const text = doc && doc.body ? String(doc.body.innerText || '').slice(0, 300000) : '';
    return scanText({
      title: doc ? doc.title : '',
      text,
      words: c.words,
      block: c.block,
      captchaFrame: c.block !== false && doc ? captchaFrameVisible(doc, root) : false
    });
  }

  const api = { scanText, scanPage, HUMAN_REASON, BLOCK_REASON };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LynchHuman = api;
})(typeof self !== 'undefined' ? self : this);
