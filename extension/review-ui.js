/* Lynch Digitance — Auto Refresh: the review window and the Reviews tab (popup side).
 *
 * Everything the server returns goes into the page with textContent only, never as HTML. This script
 * talks to the background worker (review:* messages); the popup never holds the account token.
 * In the Advanced dashboard (same page, wide layout) there is no review UI, so this stays idle there.
 */
(function () {
  'use strict';

  if (document.documentElement.classList.contains('adv')) {
    window.LynchReviewsUI = { opened: function () {}, maybePrompt: function () {} };
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var send = function (m) { return chrome.runtime.sendMessage(m); };
  var LABELS = ['', 'Poor', 'Could be better', 'Okay', 'Good', 'Excellent'];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // five stars: n bright ones, the rest dim
  function stars(n) {
    var s = el('span', 'rvstars', '★★★★★'.slice(0, n));
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', n + ' out of 5 stars');
    if (n < 5) s.appendChild(el('i', '', '★★★★★'.slice(0, 5 - n)));
    return s;
  }

  function when(at) {
    try { return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  /* ---------- the review window ---------- */

  var rating = 0;
  var prompting = false;   // opened by itself (true) or from the Reviews tab (false)
  var hasMine = false;
  var busy = false;
  var lastMine = null;
  var picks = [].slice.call(document.querySelectorAll('#rvPick button'));

  function paintPick(upTo, hover) {
    picks.forEach(function (b) {
      var v = Number(b.dataset.v);
      b.classList.toggle('on', !hover && v <= upTo);
      b.classList.toggle('hov', !!hover && v <= upTo);
      b.setAttribute('aria-checked', String(!hover && v === upTo));
    });
    $('rvPickLabel').textContent = upTo ? LABELS[upTo] : 'Tap a star';
  }

  function setRating(n) {
    rating = n;
    paintPick(n, false);
    $('rvSubmit').disabled = !n || busy;
  }

  picks.forEach(function (b) {
    b.addEventListener('click', function () { setRating(Number(b.dataset.v)); });
    b.addEventListener('mouseenter', function () { paintPick(Number(b.dataset.v), true); });
  });
  $('rvPick').addEventListener('mouseleave', function () { paintPick(rating, false); });
  $('rvPick').addEventListener('keydown', function (e) {
    var step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    var n = Math.min(5, Math.max(1, (rating || (step > 0 ? 0 : 6)) + step));
    setRating(n);
    picks[n - 1].focus();
  });

  $('rvText').addEventListener('input', function () { $('rvLen').textContent = $('rvText').value.length; });

  function showErr(text) {
    $('rvErr').textContent = text || '';
    $('rvErr').className = 'acct__msg' + (text ? ' acct__msg--err' : '');
    $('rvErr').hidden = !text;
  }

  async function openModal(o) {
    prompting = !!o.prompt;
    var mine = o.mine || null;
    hasMine = !!mine;
    var signedIn = o.signedIn;
    if (signedIn === undefined) {
      try { signedIn = !!((await send({ type: 'acct:status' })) || {}).signedIn; } catch (e) { signedIn = false; }
    }
    $('rvTitle').textContent = mine ? 'Your review' : prompting ? 'How is Auto Refresh working for you?' : 'Write a review';
    $('rvSub').textContent = mine ? 'You can change it any time.' : 'Your review helps other people decide, and helps us make it better.';
    $('rvText').value = mine && mine.text ? mine.text : '';
    $('rvLen').textContent = $('rvText').value.length;
    $('rvFine').textContent = signedIn
      ? 'Shown publicly in the extension and on our website, with a short name made from your account email. Nothing else is shared.'
      : 'Shown publicly in the extension and on our website as "Auto Refresh user", because you are not logged in. Log in first and it uses a short name made from your account email. Nothing else is shared.';
    busy = false;
    showErr('');
    $('rvSubmit').textContent = mine ? 'Save changes' : 'Send review';
    setRating(mine ? mine.rating : 0);
    $('rvLinks').hidden = !prompting;
    $('rvCancelRow').hidden = prompting;
    $('rvForm').hidden = false;
    $('rvThanks').hidden = true;
    $('rvModal').hidden = false;
    $('rvBox').focus(); // into the window (Tab then reaches the stars); a ring on star 1 would look like a 1-star choice
  }

  function closeModal() {
    if (busy) return;
    $('rvModal').hidden = true;
  }

  async function submit() {
    if (busy || !rating) return;
    busy = true;
    $('rvSubmit').disabled = true;
    $('rvSubmit').textContent = 'Sending…';
    showErr('');
    var r = null;
    try { r = await send({ type: 'review:submit', rating: rating, text: $('rvText').value }); } catch (e) {}
    busy = false;
    if (!r || !r.ok) {
      showErr((r && r.error) || 'Could not send your review. Try again.');
      $('rvSubmit').textContent = hasMine ? 'Save changes' : 'Send review';
      $('rvSubmit').disabled = !rating;
      return;
    }
    $('rvForm').hidden = true;
    $('rvThanks').hidden = false;
    $('rvThanksText').textContent = (r.created === false ? 'Your review was updated. ' : 'Your review was sent. ') +
      'It shows in the Reviews tab and on our website' + (r.name ? ' as ' + r.name : '') + '.';
    if (!$('viewReviews').hidden) load();
  }

  $('rvSubmit').addEventListener('click', submit);
  $('rvThanksBtn').addEventListener('click', closeModal);
  $('rvCancel').addEventListener('click', closeModal);
  $('rvLater').addEventListener('click', async function () {
    try { await send({ type: 'review:later' }); } catch (e) {}
    closeModal();
  });
  $('rvNever').addEventListener('click', async function () {
    try { await send({ type: 'review:never' }); } catch (e) {}
    closeModal();
  });
  $('rvModal').addEventListener('click', function (e) { if (e.target === $('rvModal')) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('rvModal').hidden) closeModal();
  });

  /* ---------- the Reviews tab ---------- */

  var seq = 0;

  function say(text, kind) {
    $('rvMsg').textContent = text || '';
    $('rvMsg').className = 'acct__msg' + (kind ? ' acct__msg--' + kind : '');
    $('rvMsg').hidden = !text;
  }

  function item(r, tag) {
    var box = el('div', 'rvitem');
    var top = el('div', 'rvitem__top');
    top.appendChild(stars(r.rating));
    if (r.at) top.appendChild(el('span', 'rvitem__date', when(r.at)));
    box.appendChild(top);
    var who = el('div', 'rvitem__name', r.name || 'Auto Refresh user');
    if (tag) { who.appendChild(document.createTextNode(' ')); who.appendChild(el('span', 'rvtag', tag)); }
    box.appendChild(who);
    if (r.text) box.appendChild(el('p', 'rvitem__text', r.text));
    return box;
  }

  async function load() {
    var mySeq = ++seq;
    say('');
    $('rvCount').textContent = 'Loading…';
    var r = null;
    try { r = await send({ type: 'review:list' }); } catch (e) {}
    if (mySeq !== seq) return;          // a newer load is already running
    var list = $('rvList');
    list.textContent = '';
    if (!r || !r.ok) {
      $('rvAvg').textContent = '–';
      $('rvAvgStars').textContent = '';
      $('rvCount').textContent = '';
      say((r && r.error) || "Couldn't load the reviews. Check your connection and try again.", 'err');
      return;
    }
    lastMine = r.mine || null;
    $('rvAvg').textContent = r.count ? Number(r.average).toFixed(1) : '–';
    $('rvAvgStars').textContent = '';
    if (r.count) $('rvAvgStars').appendChild(stars(Math.round(r.average)));
    $('rvCount').textContent = r.count ? r.count + (r.count === 1 ? ' review' : ' reviews') : 'No reviews yet';
    $('rvWrite').textContent = lastMine ? 'Edit your review' : 'Write a review';

    // this person's own review comes first and is marked, even if the owner has hidden it from everyone else
    if (lastMine) {
      var mineBox = item({ rating: lastMine.rating, name: lastMine.name, text: lastMine.text }, 'your review');
      mineBox.classList.add('rvitem--mine');
      list.appendChild(mineBox);
    }
    var others = (r.reviews || []).filter(function (x) { return !(lastMine && lastMine.id && x.id === lastMine.id); });
    others.forEach(function (x) { list.appendChild(item(x)); });
    if (!others.length && !lastMine) list.appendChild(el('div', 'rvempty', 'No reviews yet. Be the first to write one.'));
  }

  $('rvWrite').addEventListener('click', function () { openModal({ prompt: false, mine: lastMine }); });

  /* ---------- hooks used by popup.js ---------- */

  window.LynchReviewsUI = {
    opened: load,
    // asked at every popup open: the background says whether it is time (3 days of use, or just updated)
    maybePrompt: async function () {
      var r = null;
      try { r = await send({ type: 'review:prompt' }); } catch (e) {}
      if (r && r.show) openModal({ prompt: true, mine: r.mine, signedIn: r.signedIn });
    }
  };
})();
