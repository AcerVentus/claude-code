/* InSys - the one-time set-up page for a device on the office network.
   Shown to a browser that arrives without encryption (it then moves the
   browser to the encrypted address as soon as the device trusts it), and as
   a guide from Admin, System. It never handles any InSys data. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }

  var host = location.hostname;
  var onHostComputer = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  var encrypted = location.protocol === 'https:';
  var guideOnly = encrypted || onHostComputer;
  var path = location.pathname === '/connect' ? '/' : location.pathname;
  var secureAddress = 'https://' + location.host + path + location.search + location.hash;

  // Open the instructions that match this device.
  var agent = navigator.userAgent || '';
  var device = 'linux';
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && 'ontouchend' in document)) device = 'ios';
  else if (/Android/.test(agent)) device = 'android';
  else if (/Windows/.test(agent)) device = 'windows';
  else if (/Mac OS X|Macintosh/.test(agent)) device = 'mac';
  var blocks = document.querySelectorAll('details.device');
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].getAttribute('data-device') === device) blocks[i].open = true;
  }
  if (device === 'ios') {
    // An iPhone offers to install the certificate only when it is opened, not saved.
    $('download').removeAttribute('download');
  }

  if (guideOnly) {
    $('steps-title').textContent = 'Setting a device up for InSys';
    show('steps-lead', false);
    show('guide-lead', true);
    $('continue').textContent = 'Back to InSys';
    show('bookmark-tip', false);
    return;
  }

  $('open-link').href = secureAddress;
  $('anyway').href = secureAddress;

  /** Resolves true if this device already trusts InSys's encrypted address. */
  function trusted() {
    if (!window.fetch) return Promise.resolve(false);
    var options = { mode: 'no-cors', cache: 'no-store', credentials: 'omit' };
    var timer = null;
    if (window.AbortController) {
      var stop = new AbortController();
      options.signal = stop.signal;
      timer = setTimeout(function () { stop.abort(); }, 8000);
    }
    return fetch('https://' + location.host + '/favicon.svg?check=' + Date.now(), options).then(
      function () { clearTimeout(timer); return true; },
      function () { clearTimeout(timer); return false; });
  }

  function go() {
    show('steps', false);
    show('checking', false);
    show('ready', true);
    location.replace(secureAddress);
  }

  show('steps', false);
  show('checking', true);
  trusted().then(function (yes) {
    if (yes) return go();
    show('checking', false);
    show('steps', true);
  });

  $('continue').addEventListener('click', function (event) {
    event.preventDefault();
    show('not-yet', false);
    trusted().then(function (yes) {
      if (yes) return go();
      show('not-yet', true);
      show('anyway-line', true);
    });
  });
}());
