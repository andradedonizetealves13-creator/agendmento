/* Primstav - tela de abertura (splash) + registro do service worker */
(function () {
  'use strict';
  var MSGS = ['Preparando sua agenda…', 'Sincronizando horários…', 'Organizando os atendimentos…', 'Quase pronto…'];
  var MIN_MS = 1300, MAX_MS = 9000, started = Date.now();

  try { if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); }); } catch (e) {}

  var seen = false;
  try { seen = sessionStorage.getItem('px_splash') === '1'; } catch (e) {}
  if (seen) return;                       // só na abertura do app/sessão, não a cada página
  try { sessionStorage.setItem('px_splash', '1'); } catch (e) {}

  var css = '' +
  '#px-splash{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  'background:radial-gradient(120% 90% at 50% 30%,#34383d 0%,#26292d 45%,#17191c 100%);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
  'transition:opacity .55s ease,transform .55s ease,visibility .55s;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}' +
  '#px-splash.px-out{opacity:0;transform:scale(1.04);visibility:hidden;pointer-events:none}' +
  '#px-splash .px-glow{position:absolute;width:420px;height:420px;max-width:90vw;max-height:90vw;border-radius:50%;background:radial-gradient(circle,rgba(255,99,20,.28),rgba(255,99,20,0) 65%);animation:pxGlow 3.2s ease-in-out infinite}' +
  '#px-splash .px-mark{position:relative;width:132px;height:132px;display:flex;align-items:center;justify-content:center}' +
  '#px-splash .px-mark img{width:84px;height:84px;object-fit:contain;animation:pxPop .9s cubic-bezier(.2,1.3,.4,1) both,pxFloat 3s ease-in-out .9s infinite;filter:drop-shadow(0 6px 22px rgba(255,99,20,.45))}' +
  '#px-splash .px-ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(255,99,20,0) 0deg,rgba(255,99,20,0) 90deg,#ff6314 330deg,rgba(255,99,20,0) 360deg);' +
  '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px));mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px));animation:pxSpin 1.15s linear infinite}' +
  '#px-splash .px-track{position:absolute;inset:0;border-radius:50%;border:3px solid rgba(255,255,255,.07)}' +
  '#px-splash .px-name{margin-top:26px;font-size:15px;font-weight:800;letter-spacing:.34em;text-indent:.34em;text-transform:uppercase;color:#fff;opacity:0;animation:pxFade .7s ease .35s forwards}' +
  '#px-splash .px-msg{margin-top:10px;height:20px;font-size:13px;font-weight:500;color:rgba(255,255,255,.62);opacity:0;animation:pxFade .7s ease .55s forwards;transition:opacity .25s}' +
  '#px-splash .px-bar{margin-top:22px;width:150px;height:4px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden;opacity:0;animation:pxFade .7s ease .7s forwards}' +
  '#px-splash .px-bar i{display:block;height:100%;width:40%;border-radius:99px;background:linear-gradient(90deg,#ff6314,#ff9a5c);animation:pxBar 1.4s ease-in-out infinite}' +
  '@keyframes pxSpin{to{transform:rotate(360deg)}}' +
  '@keyframes pxPop{from{opacity:0;transform:scale(.5) rotate(-8deg)}to{opacity:1;transform:scale(1) rotate(0)}}' +
  '@keyframes pxFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}' +
  '@keyframes pxGlow{0%,100%{opacity:.55;transform:scale(.92)}50%{opacity:1;transform:scale(1.08)}}' +
  '@keyframes pxFade{to{opacity:1}}' +
  '@keyframes pxBar{0%{transform:translateX(-110%)}100%{transform:translateX(280%)}}' +
  '@media (prefers-reduced-motion:reduce){#px-splash *{animation-duration:.01ms!important;animation-iteration-count:1!important}}';

  var st = document.createElement('style'); st.id = 'px-splash-css'; st.textContent = css;
  var box = document.createElement('div'); box.id = 'px-splash'; box.setAttribute('role', 'status'); box.setAttribute('aria-label', 'Carregando');
  box.innerHTML = '<div class="px-glow"></div><div class="px-mark"><div class="px-track"></div><div class="px-ring"></div><img src="/logo.png" alt="Primstav"></div>' +
    '<div class="px-name">Primstav</div><div class="px-msg" id="px-splash-msg">' + MSGS[0] + '</div><div class="px-bar"><i></i></div>';

  function mount() {
    if (document.getElementById('px-splash')) return;
    (document.head || document.documentElement).appendChild(st);
    (document.body || document.documentElement).appendChild(box);
  }
  if (document.body) mount(); else { document.documentElement.appendChild(st); document.documentElement.appendChild(box); }

  var i = 0, msgEl;
  var rot = setInterval(function () {
    msgEl = msgEl || document.getElementById('px-splash-msg'); if (!msgEl) return;
    msgEl.style.opacity = 0;
    setTimeout(function () { i = (i + 1) % MSGS.length; msgEl.textContent = MSGS[i]; msgEl.style.opacity = 1; }, 250);
  }, 2000);

  var loaded = document.readyState === 'complete';
  window.addEventListener('load', function () { loaded = true; });

  function appReady() {
    var app = document.getElementById('app');
    if (!app) return true;
    if (app.querySelector('.px-loader, .animate-spin')) return false;
    return app.children.length > 0;
  }
  function hide() {
    clearInterval(rot); clearInterval(poll);
    box.classList.add('px-out');
    setTimeout(function () { try { box.remove(); st.remove(); } catch (e) {} }, 700);
  }
  var poll = setInterval(function () {
    var el = Date.now() - started;
    if (el >= MAX_MS || (el >= MIN_MS && loaded && appReady())) hide();
  }, 120);
})();
