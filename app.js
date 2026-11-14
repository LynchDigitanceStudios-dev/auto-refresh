/* Lynch Digitance Studios — landing page interactions */
(function () {
  'use strict';

  /* Animated countdown inside the popup mockup ------------------------- */
  var num = document.getElementById('mockCountdown');
  var ring = document.getElementById('ringProgress');
  var hits = document.getElementById('mockRefreshes');
  if (!num || !ring) return;

  var TOTAL = 30;                 // matches the "30s" preset shown as active
  var CIRC = 2 * Math.PI * 26;    // r=26 in the SVG
  var left = TOTAL;
  var count = hits ? parseInt(hits.textContent, 10) || 12 : 12;
  var timer = null;

  ring.style.strokeDasharray = CIRC.toFixed(2);

  function paint() {
    num.textContent = left;
    ring.style.strokeDashoffset = (CIRC * (1 - left / TOTAL)).toFixed(2);
  }

  function tick() {
    left -= 1;
    if (left < 0) {
      left = TOTAL;
      count += 1;
      if (hits) hits.textContent = count;
      // snap the ring back without a visible rewind
      ring.style.transition = 'none';
      paint();
      void ring.offsetWidth;
      ring.style.transition = '';
      return;
    }
    paint();
  }

  function start() {
    if (timer === null) timer = setInterval(tick, 1000);
  }
  function stop() {
    if (timer !== null) { clearInterval(timer); timer = null; }
  }

  paint();

  var reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  // Only run while the tab is visible, so it never spins in the background.
  document.addEventListener('visibilitychange', function () {
    document.hidden ? stop() : start();
  });
  if (!document.hidden) start();
})();
