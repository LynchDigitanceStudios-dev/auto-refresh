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

/* Reviews: filled from the accounts server (public list, hidden ones are never sent).
   The section stays hidden until there is at least one review; if the server cannot be reached
   nothing changes on the page. Everything is built with textContent, never innerHTML. */
(function () {
  'use strict';
  var sec = document.getElementById('reviews');
  if (!sec || !window.fetch) return;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function stars(n) {
    var s = el('span', 'revcard__stars', '★★★★★'.slice(0, n));
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', n + ' out of 5 stars');
    if (n < 5) s.appendChild(el('i', '', '★★★★★'.slice(0, 5 - n)));
    return s;
  }

  fetch('https://autorefresh-accounts.lynchdigitancestudios.workers.dev/reviews?limit=12')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.count || !d.reviews || !d.reviews.length) return;
      var sum = document.getElementById('revSummary');
      var grid = document.getElementById('revGrid');
      sum.textContent = '';
      var avg = el('span', 'revavg');
      avg.appendChild(el('strong', '', Number(d.average).toFixed(1)));
      avg.appendChild(stars(Math.round(d.average)));
      avg.appendChild(el('span', '', 'from ' + d.count + (d.count === 1 ? ' review' : ' reviews')));
      sum.appendChild(avg);
      grid.textContent = '';
      d.reviews.forEach(function (r) {
        var card = el('article', 'revcard');
        var top = el('div', 'revcard__top');
        top.appendChild(stars(r.rating));
        top.appendChild(el('span', 'revcard__date', new Date(r.at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })));
        card.appendChild(top);
        if (r.text) card.appendChild(el('p', 'revcard__text', r.text));
        card.appendChild(el('div', 'revcard__name', r.name));
        grid.appendChild(card);
      });
      sec.hidden = false;
    })
    .catch(function () { /* offline or blocked: the page simply has no reviews section */ });
})();
