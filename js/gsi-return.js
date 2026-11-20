// ── GOOGLE SIGN-IN RETURN (1.18.4) ── Google redirects here with the ID token in
// the URL fragment. Check it answers the sign-in this browser started (state +
// nonce in localStorage, under 10 min old), park the token for the app, and
// go back to Settings. The fragment never reaches a server.
(function () {
  'use strict';
  var LS_OAUTH = 'mangoit.__sync.oauth', LS_TOKEN = 'mangoit.__sync.idtoken', LS_ACTIVE = 'mangoit.__sync.active';
  var msg = document.getElementById('msg'), back = document.getElementById('back');
  function fail(text) { msg.textContent = text; back.hidden = false; }
  function payloadOf(jwt) {
    try {
      var p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(p), function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')));
    } catch (e) { return null; }
  }
  var q = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);   // the token leaves the address bar at once
  var started = null;
  try { started = JSON.parse(localStorage.getItem(LS_OAUTH)); localStorage.removeItem(LS_OAUTH); } catch (e) { /* */ }
  if (q.get('error')) { fail(q.get('error') === 'access_denied' ? 'Sign-in cancelled.' : 'Google sign-in didn’t go through. Try again from Settings.'); return; }
  var token = q.get('id_token');
  if (!token) { fail('Nothing came back from Google. Try again from Settings.'); return; }
  if (!started || started.state !== q.get('state') || !(Date.now() - started.at < 10 * 60000)) { fail('That sign-in expired or was started somewhere else. Try again from Settings.'); return; }
  var p = payloadOf(token);
  if (!p || p.nonce !== started.nonce) { fail('Google’s reply didn’t match this sign-in. Try again from Settings.'); return; }
  try {
    localStorage.setItem(LS_TOKEN, JSON.stringify({ token: token, at: Date.now() }));
    localStorage.setItem(LS_ACTIVE, '1');
  } catch (e) { fail('This browser blocked saving the sign-in. Try again from Settings.'); return; }
  location.replace('/#settings');
})();
