/* popup.html is two things: the small popup, and (opened with ?view=advanced in its own browser tab)
   the Advanced settings dashboard. This runs first, in <head>, so the right layout is chosen before
   anything is painted. The same page and the same script serve both; CSS decides what each one shows. */
(function () {
  'use strict';
  var adv = /(?:^|[?&])view=advanced(?:&|$)/.test(location.search);
  if (adv) {
    document.documentElement.classList.add('adv');
    document.title = 'Auto Refresh · Advanced settings';
  }
})();
