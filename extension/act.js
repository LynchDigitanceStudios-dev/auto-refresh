/* Lynch Digitance — Auto Refresh: "act human on the page".
 *
 * Injected into the refreshed tab (isolated world) after a reload, and only when
 * the user has switched "Act human on the page" on. It plays one short, randomised
 * visit, so the page sees ordinary activity between reloads and not a tab that
 * reloads on a timer and is otherwise dead:
 *   - the pointer drifts along curved paths at uneven speed, hovering what it passes
 *   - the page scrolls down a little, with pauses, then returns to where it was
 *   - sometimes (optional) a click on empty space
 *
 * It never reads the page: it only asks where elements are, so it can steer clear
 * of links, buttons and form fields. Nothing is sent anywhere. The events it makes
 * are synthetic (isTrusted is false), so this helps against idle timers and simple
 * activity checks, not against real bot protection. Real mouse, wheel, touch or key
 * input from the user ends the visit at once, and a tab that is not on screen only
 * gets a few pointer moves.
 *
 * Loaded directly by tests too.
 */
(function (root) {
  'use strict';

  const RUN_KEY = '__lynchActVisit';

  // Anything a click could act on. Checked on the element under the pointer AND on
  // every ancestor (closest). Script-driven click targets are caught separately by
  // the cursor test in emptyAt(). Roles/tabindex are limited to the interactive ones,
  // because pages commonly put role="main" or tabindex="-1" on a whole wrapper.
  const NOT_EMPTY = [
    'a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'details', 'option',
    'video', 'audio', 'iframe', 'embed', 'object', 'canvas', 'svg', 'img', 'picture', 'map', 'area',
    '[contenteditable]', '[onclick]', '[draggable="true"]', '[tabindex]:not([tabindex^="-"])',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="option"]', '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]', '[role="slider"]',
    '[role="spinbutton"]', '[role="treeitem"]', '[role="gridcell"]', '[role="scrollbar"]'
  ].join(',');
  const MODAL = 'dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]';

  const rnd = (a, b) => a + Math.random() * (b - a);
  const rint = (a, b) => Math.round(rnd(a, b));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const rawSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  /* ---------- the visit's clock ---------- */

  const left = (st) => st.end - Date.now();
  const live = (st, reserve) => !st.aborted && left(st) > (reserve || 0);
  const nap = (st, ms) => rawSleep(Math.min(ms, Math.max(0, left(st))));

  /* ---------- events ---------- */

  const PTR = { pointerId: 1, pointerType: 'mouse', isPrimary: true };

  function send(el, kind, type, init) {
    try {
      const C = kind === 'pointer' ? (typeof root.PointerEvent === 'function' ? root.PointerEvent : root.MouseEvent)
        : kind === 'wheel' ? root.WheelEvent : root.MouseEvent;
      el.dispatchEvent(new C(type, init));
    } catch (e) { /* a page can never break the visit */ }
  }

  function init(x, y, more) {
    return Object.assign({
      bubbles: true, cancelable: true, composed: true, view: root,
      clientX: x, clientY: y,
      screenX: x + (root.screenX || 0),
      screenY: y + (root.screenY || 0) + Math.max(0, (root.outerHeight || 0) - (root.innerHeight || 0)),
      button: 0, buttons: 0
    }, more || {});
  }

  /* Tell the page the pointer left one element and entered another, as a real one would. */
  function hover(st, el, x, y) {
    if (el === st.over) return;
    const from = st.over;
    if (from) {
      send(from, 'pointer', 'pointerout', init(x, y, Object.assign({ relatedTarget: el }, PTR)));
      send(from, 'mouse', 'mouseout', init(x, y, { relatedTarget: el }));
    }
    send(el, 'pointer', 'pointerover', init(x, y, Object.assign({ relatedTarget: from }, PTR)));
    send(el, 'mouse', 'mouseover', init(x, y, { relatedTarget: from }));
    st.over = el;
  }

  function pointAt(st, x, y, dx, dy) {
    const el = document.elementFromPoint(x, y) || document.body;
    hover(st, el, x, y);
    const mv = { movementX: Math.round(dx), movementY: Math.round(dy) };
    send(el, 'pointer', 'pointermove', init(x, y, Object.assign({}, PTR, mv)));
    send(el, 'mouse', 'mousemove', init(x, y, mv));
    st.x = x;
    st.y = y;
    st.out.moves++;
  }

  /* ---------- the pointer ---------- */

  const pickPoint = () => ({ x: rnd(0.08, 0.92) * root.innerWidth, y: rnd(0.1, 0.9) * root.innerHeight });
  // farther takes longer, but not in proportion: short hops are quick, long ones ease along
  const glideTime = (dist, st) => clamp(240 + dist * rnd(0.8, 1.5), 380, 1700) * st.scale;

  /* A cubic curve with two random bends and an eased speed, plus a little hand
     tremor, sampled at about the rate a real mouse reports. Time-based, so a
     throttled tab simply produces fewer points instead of running long. */
  async function glide(st, x1, y1, dur) {
    const x0 = st.x, y0 = st.y;
    const dx = x1 - x0, dy = y1 - y0, dist = Math.hypot(dx, dy);
    if (dist < 6) return;
    const nx = -dy / dist, ny = dx / dist;
    const b1 = rnd(-0.2, 0.2) * dist, b2 = rnd(-0.2, 0.2) * dist;
    const c1x = x0 + dx * 0.3 + nx * b1, c1y = y0 + dy * 0.3 + ny * b1;
    const c2x = x0 + dx * 0.7 + nx * b2, c2y = y0 + dy * 0.7 + ny * b2;
    const t0 = Date.now();
    let px = x0, py = y0;
    while (live(st)) {
      const p = clamp((Date.now() - t0) / dur, 0, 1);
      const e = ease(p), u = 1 - e;
      let x = u * u * u * x0 + 3 * u * u * e * c1x + 3 * u * e * e * c2x + e * e * e * x1;
      let y = u * u * u * y0 + 3 * u * u * e * c1y + 3 * u * e * e * c2y + e * e * e * y1;
      if (p < 1) { x += rnd(-0.7, 0.7); y += rnd(-0.7, 0.7); }
      x = clamp(x, 1, root.innerWidth - 2);
      y = clamp(y, 1, root.innerHeight - 2);
      pointAt(st, x, y, x - px, y - py);
      px = x;
      py = y;
      if (p >= 1) break;
      await nap(st, rnd(13, 25));
    }
  }

  async function wander(st, glides) {
    const n = glides || rint(1, 2);
    for (let i = 0; i < n && live(st); i++) {
      let p = pickPoint();
      for (let k = 0; k < 4 && Math.hypot(p.x - st.x, p.y - st.y) < 90; k++) p = pickPoint();
      await glide(st, p.x, p.y, glideTime(Math.hypot(p.x - st.x, p.y - st.y), st));
      await nap(st, rnd(150, 650) * st.scale);
    }
  }

  /* ---------- scrolling ---------- */

  const pageH = () => Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  );
  const maxY = () => Math.max(0, pageH() - root.innerHeight);

  // 'instant' beats a site's own scroll-behavior:smooth, which would turn each step into a slow glide
  function jump(y) {
    try { root.scrollTo({ top: y, left: root.scrollX, behavior: 'instant' }); }
    catch (e) { root.scrollTo(root.scrollX, y); }
  }

  function wheel(st, dy) {
    const el = document.elementFromPoint(st.x, st.y) || document.body;
    send(el, 'wheel', 'wheel', init(st.x, st.y, { deltaX: 0, deltaY: dy, deltaZ: 0, deltaMode: 0 }));
  }

  /* Eased scroll to y1, with a wheel notch now and then so wheel listeners see it too.
     The scroll events themselves come from the browser, as they do for a real scroll. */
  async function rollTo(st, y1, dur) {
    const y0 = root.scrollY;
    if (Math.abs(y1 - y0) < 24) return false;
    const t0 = Date.now();
    let nextWheel = 0;
    while (live(st)) {
      const p = clamp((Date.now() - t0) / dur, 0, 1);
      if (Date.now() >= nextWheel) {
        wheel(st, (y1 > y0 ? 1 : -1) * rint(53, 125));
        nextWheel = Date.now() + rnd(55, 150);
      }
      jump(Math.round(y0 + (y1 - y0) * ease(p)));
      if (p >= 1) break;
      await nap(st, rnd(14, 26));
    }
    st.out.scrolled = true;
    return true;
  }

  /* A few small scrolls with reading pauses, then back to exactly where the page was,
     so a dashboard is never left scrolled away from its top. */
  async function scrollVisit(st) {
    const orig = root.scrollY;
    const steps = st.budget < 6000 ? 1 : rint(1, 3);
    const lo = Math.max(0, orig - root.innerHeight * 0.6);
    const hi = Math.min(maxY(), orig + root.innerHeight * 1.2);
    try {
      for (let i = 0; i < steps && live(st, 1300 * st.scale); i++) {
        const down = i === 0 || Math.random() < 0.7;
        const target = clamp(root.scrollY + (down ? 1 : -1) * rnd(0.18, 0.55) * root.innerHeight, lo, hi);
        await rollTo(st, target, rnd(500, 1100) * st.scale);
        await nap(st, rnd(500, 1500) * st.scale);
      }
    } finally {
      // if the user took over, leave the page exactly as they have it
      if (!st.aborted && Math.abs(root.scrollY - orig) > 3) {
        await rollTo(st, orig, rnd(450, 850) * st.scale);
        if (!st.aborted && Math.abs(root.scrollY - orig) > 3) jump(orig); // out of time: just put it back
      }
    }
  }

  /* ---------- clicking (empty space only) ---------- */

  const hasText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  };

  /* True only for a blank patch of page: not inside anything interactive, not on
     text, and with an ordinary arrow cursor (a pointer or text cursor means something
     is listening there, and the cursor is inherited from ancestors). */
  function emptyAt(x, y) {
    let el;
    try { el = document.elementFromPoint(x, y); } catch (e) { return false; }
    if (!el || el.closest(NOT_EMPTY) || hasText(el)) return false;
    const cs = root.getComputedStyle(el);
    return (cs.cursor === 'auto' || cs.cursor === 'default') && cs.pointerEvents !== 'none' && cs.visibility !== 'hidden';
  }

  // a click outside a dialog usually dismisses it, and a click would blur a field being typed in
  function clickable() {
    if (document.querySelector(MODAL) || document.fullscreenElement) return false;
    const a = document.activeElement;
    return !(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
  }

  function findEmpty() {
    for (let i = 0; i < 24; i++) {
      const x = rnd(0.1, 0.9) * root.innerWidth, y = rnd(0.12, 0.88) * root.innerHeight;
      if (emptyAt(x, y)) return { x, y };
    }
    return null;
  }

  async function clickVisit(st) {
    if (!clickable()) return;
    const spot = findEmpty();
    if (!spot) return;
    await glide(st, spot.x, spot.y, glideTime(Math.hypot(spot.x - st.x, spot.y - st.y), st));
    await nap(st, rnd(160, 520) * st.scale);
    // look again at the last moment: the page may have changed while the pointer travelled
    if (!live(st) || !clickable() || !emptyAt(st.x, st.y)) return;
    const el = document.elementFromPoint(st.x, st.y) || document.body;
    send(el, 'pointer', 'pointerdown', init(st.x, st.y, Object.assign({ buttons: 1 }, PTR)));
    send(el, 'mouse', 'mousedown', init(st.x, st.y, { buttons: 1, detail: 1 }));
    await nap(st, rnd(55, 150));
    send(el, 'pointer', 'pointerup', init(st.x, st.y, Object.assign({}, PTR)));
    send(el, 'mouse', 'mouseup', init(st.x, st.y, { detail: 1 }));
    send(el, 'mouse', 'click', init(st.x, st.y, { detail: 1 }));
    st.out.clicked = true;
  }

  /* ---------- the visit ---------- */

  /* Real input ends the visit. Our own events are never trusted, and the browser's
     "fake" mouse moves after a layout change report no movement, so neither counts. */
  function watchUser(st) {
    const types = ['wheel', 'mousedown', 'pointerdown', 'keydown', 'touchstart', 'mousemove'];
    const handler = (e) => {
      if (!e.isTrusted) return;
      if (e.type === 'mousemove' && !e.movementX && !e.movementY) return;
      st.aborted = true;
      st.out.aborted = true;
    };
    types.forEach((t) => root.addEventListener(t, handler, { capture: true, passive: true }));
    return () => types.forEach((t) => root.removeEventListener(t, handler, { capture: true }));
  }

  /* cfg: { budgetMs, clicks, force? } — budgetMs is the most time the visit may take
     (the caller leaves room before the next refresh). `force` ({scroll, click}) pins a
     part on or off, for tests; without it each part is left to chance, so no two visits
     look alike. Resolves with what happened. */
  async function visit(cfg) {
    cfg = cfg || {};
    const budget = clamp(Number(cfg.budgetMs) || 0, 0, 20000);
    const out = { moves: 0, scrolled: false, clicked: false, aborted: false, skipped: null };
    if (budget < 1500) { out.skipped = 'short'; return out; }
    if (!document.body || !root.innerWidth || !root.innerHeight) { out.skipped = 'no-page'; return out; }

    if (root[RUN_KEY]) root[RUN_KEY].cancel();
    const st = {
      out, budget, end: Date.now() + budget, aborted: false, x: 0, y: 0, over: null,
      scale: clamp(budget / 9000, 0.35, 1)
    };
    root[RUN_KEY] = { st, cancel: () => { st.aborted = true; out.aborted = true; } };
    const unwatch = watchUser(st);

    // a tab nobody is looking at gets a few pointer moves only: scroll events don't
    // fire for it, and clicking in a page that isn't on screen would be the odd part
    const visible = document.visibilityState === 'visible';
    const force = cfg.force || {};
    const pick = (key, chance) => (force[key] !== undefined ? !!force[key] : Math.random() < chance);
    const wantScroll = visible && maxY() > 60 && pick('scroll', 0.85);
    const wantClick = visible && cfg.clicks !== false && budget >= 4500 && pick('click', 0.45);

    try {
      await nap(st, rnd(350, 1500) * st.scale);              // eyes land on the page
      if (live(st)) pointAt(st, rnd(0.2, 0.8) * root.innerWidth, rnd(0.2, 0.7) * root.innerHeight, 0, 0);
      await nap(st, rnd(120, 420) * st.scale);
      // a click is the one part that cannot be shortened, so it goes before the scroll,
      // which simply takes fewer steps when little time is left; with a click planned the
      // first wander is a single glide, so the time is not spent before it gets its turn
      await wander(st, wantClick ? 1 : 0);
      if (wantClick && live(st, 1000 * st.scale)) await clickVisit(st);
      if (wantScroll && live(st, 2000 * st.scale)) await scrollVisit(st);
      else if (live(st, 600) && Math.random() < 0.6) await wander(st);
    } catch (e) {
      out.error = String((e && e.message) || e).slice(0, 80);
    } finally {
      unwatch();
      if (root[RUN_KEY] && root[RUN_KEY].st === st) delete root[RUN_KEY];
    }
    return out;
  }

  /* Never rejects: the caller does not wait for it. */
  function run(cfg) {
    return visit(cfg).catch((e) => ({ error: String((e && e.message) || e).slice(0, 80) }));
  }

  root.LynchAct = { run, NOT_EMPTY, MODAL };
})(self);
