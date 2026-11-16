/* ==================================================================
 *  Globule — logique du site de visionnage
 *  ----------------------------------------------------------------
 *  100 % statique : aucune dépendance, aucune compilation.
 *  Hébergeable tel quel sur GitHub Pages.
 *
 *  Correctif de l'écran figé : le voile d'attente ne se lève
 *  QUE lorsque la vidéo lit réellement des images (événement
 *  « playing » + filet de sécurité qui vérifie l'état de la
 *  lecture quatre fois par seconde).
 * ================================================================== */

'use strict';

/* ------------------------------------------------------------------ */
/* Réglages (précédence : lien > réglage local > config.js du site)    */
/* ------------------------------------------------------------------ */

const STORE_KEY = 'globule.viewer.settings.v1';
const qs = new URLSearchParams(location.search);

const CONFIG = Object.assign({
  DEFAULT_SERVER_URL: '',
  ICE_SERVERS: [{ urls: 'stun:stun.l.google.com:19302' }],
  TAGLINE: 'Votre écran, chez elle, en direct.'
}, window.GLOBULE_CONFIG || {});

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  return {
    serverUrl: normalizeServerUrl(qs.get('server') || saved.serverUrl || CONFIG.DEFAULT_SERVER_URL || '')
  };
}

function normalizeServerUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (/^https:\/\//i.test(u)) u = 'wss' + u.slice(4);
  else if (/^http:\/\//i.test(u)) u = 'ws' + u.slice(4);
  else if (!/^wss?:\/\//i.test(u)) u = 'wss://' + u;
  return u.replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* Raccourcis DOM                                                      */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const els = {
  home: $('home'), watch: $('watch'),
  code: $('code'), joinForm: $('join-form'), homeError: $('home-error'),
  serverBanner: $('server-banner'),
  video: $('video'),
  veil: $('veil'), veilText: $('veil-text'), veilTip: $('veil-tip'),
  btnForcePlay: $('btn-force-play'), chipSound: $('chip-sound'),
  watchStatus: $('watch-status'), liveDot: $('live-dot'),
  controls: $('controls'),
  btnMute: $('btn-mute'), icVol: $('ic-vol'), icMuted: $('ic-muted'), volume: $('volume'),
  btnStats: $('btn-stats'), btnFullscreen: $('btn-fullscreen'), btnQuit: $('btn-quit'),
  stats: $('stats'),
  stRes: $('st-res'), stFps: $('st-fps'), stBitrate: $('st-bitrate'),
  stRtt: $('st-rtt'), stLoss: $('st-loss'), stState: $('st-state'),
  modalSettings: $('modal-settings'),
  inpServer: $('inp-server'), btnServerSave: $('btn-server-save'),
  btnServerReset: $('btn-server-reset'), btnSettingsClose: $('btn-settings-close'),
  btnSettings: $('btn-settings'), btnWatchSettings: $('btn-watch-settings'),
  heroTagline: $('hero-tagline'),
  toast: $('toast')
};

const settings = loadSettings();

/* ------------------------------------------------------------------ */
/* Petites aides                                                       */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* État de la séance                                                   */
/* ------------------------------------------------------------------ */

const state = {
  code: '',
  joined: false,
  streamerOnline: false,
  ws: null,
  wsAlive: false,
  pc: null,
  reconnectDelay: 1000,
  reconnectTimer: null,
  pingTimer: null,
  statsTimer: null,
  veilTimer: null,
  lastBytes: 0,
  lastStatsAt: 0,
  autoBlocked: false,
  leaving: false
};

/* ------------------------------------------------------------------ */
/* Voile d'attente — LE correctif du bug « écran figé »                */
/* ------------------------------------------------------------------ */

function showVeil(text) {
  els.veilText.textContent = text;
  els.veil.classList.remove('leaving');
  els.veil.hidden = false;
  clearTimeout(state.veilTimer);
  state.veilTimer = setTimeout(() => { els.veilTip.hidden = false; }, 30000);
  els.veilTip.hidden = true;
}

function hideVeil() {
  clearTimeout(state.veilTimer);
  els.veilTip.hidden = true;
  els.veil.classList.add('leaving');
  setTimeout(() => { els.veil.hidden = true; els.veil.classList.remove('leaving'); }, 520);
}

function setStatus(text, mode) {
  els.watchStatus.textContent = text;
  els.liveDot.className = 'dot ' + (mode === 'live' ? 'dot-live' : mode === 'off' ? 'dot-off' : 'dot-wait');
}

/**
 * Attache un flux à la vidéo puis tente la lecture.
 * Plusieurs signaux se croisent pour lever le voile :
 *   1. l'événement « playing » du <video>,
 *   2. un contrôle toutes les 400 ms (readyState, taille, pause),
 *   3. un bouton « Lancer la lecture » si le navigateur bloque.
 * Ainsi, même si un signal manque, l'écran d'attente ne peut plus
 * rester affiché par-dessus une vidéo qui tourne.
 */
function attachStream(stream) {
  els.video.srcObject = stream;
  tryPlay();
  armPlaybackWatchdog();
}

function tryPlay() {
  const p = els.video.play();
  if (p && p.catch) {
    p.catch((err) => {
      // Lecture automatique avec son refusée : on repart en sourdine,
      // puis on propose un bouton pour réactiver le son d'un clic.
      els.video.muted = true;
      state.autoBlocked = true;
      const retry = els.video.play();
      if (retry && retry.catch) retry.catch(() => showForcePlay());
      if (!els.video.paused) showSoundChip();
    });
  }
}

function armPlaybackWatchdog() {
  const t0 = performance.now();
  const video = els.video;
  if (state.watchdog) clearInterval(state.watchdog);

  const onPlaying = () => {
    clearInterval(state.watchdog);
    state.watchdog = null;
    hideVeil();
    hideForcePlay();
    if (state.autoBlocked && video.muted) showSoundChip();
    setStatus('En direct', 'live');
  };
  video.addEventListener('playing', onPlaying, { once: true });
  // image suivante reçue = la vidéo vit vraiment
  video.addEventListener('loadeddata', () => { if (!video.paused) onPlaying(); }, { once: true });

  state.watchdog = setInterval(() => {
    if (video.readyState >= 2 && video.videoWidth > 0) {
      if (!video.paused) { onPlaying(); return; }
      if (performance.now() - t0 > 3000) showForcePlay();
    }
  }, 400);
}

function showForcePlay() {
  els.btnForcePlay.hidden = false;
}

function hideForcePlay() {
  els.btnForcePlay.hidden = true;
}

function showSoundChip() {
  els.chipSound.hidden = false;
}

function hideSoundChip() {
  els.chipSound.hidden = true;
}

/* ------------------------------------------------------------------ */
/* WebSocket de signalisation (avec reconnexion automatique)           */
/* ------------------------------------------------------------------ */

function connectWebSocket() {
  if (!settings.serverUrl) {
    showVeil('Serveur de signalisation non configuré.');
    setStatus('Serveur manquant', 'off');
    return;
  }

  let ws;
  try {
    ws = new WebSocket(settings.serverUrl);
  } catch (e) {
    showVeil('Adresse de serveur invalide : ' + settings.serverUrl);
    setStatus('Serveur invalide', 'off');
    return;
  }
  state.ws = ws;
  state.wsAlive = false;

  ws.onopen = () => {
    state.wsAlive = true;
    state.reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'join', role: 'viewer', code: state.code }));
    showVeil('Connexion à la séance…');
    setStatus('Connexion à la séance…', 'wait');
    // Battements de cœur : maintiennent le lien (et réveillent
    // les hébergeurs gratuits qui s'endorment sans trafic).
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    }, 20000);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    state.wsAlive = false;
    clearInterval(state.pingTimer);
    if (state.leaving) return;
    setStatus('Reconnexion…', 'wait');
    if (state.joined) showVeil('Reconnexion au serveur…');
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose suivra */ };
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 10000);
    connectWebSocket();
  }, state.reconnectDelay);
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'joined':
      state.joined = true;
      state.streamerOnline = !!msg.streamerOnline;
      if (state.streamerOnline) {
        showVeil('Mise en place de la séance…');
        setStatus('Diffuseur connecté', 'wait');
      } else {
        showVeil('En attente du démarrage de la diffusion…');
        setStatus('En attente du diffuseur', 'wait');
      }
      break;

    case 'streamer-online':
      state.streamerOnline = true;
      showVeil('Le diffuseur arrive…');
      setStatus('Diffuseur connecté', 'wait');
      break;

    case 'streamer-offline':
      state.streamerOnline = false;
      closePeer();
      showVeil('La diffusion a été interrompue. Restez ici : elle reprendra automatiquement.');
      setStatus('Diffusion interrompue', 'off');
      break;

    case 'offer':
      createPeer();
      applyRemoteAndAnswer(msg.payload, msg.from);
      showVeil('Mise en place du flux vidéo…');
      setStatus('Flux en approche', 'wait');
      break;

    case 'answer':
      if (state.pc && msg.payload) {
        state.pc.setRemoteDescription(msg.payload).catch(() => {});
      }
      break;

    case 'ice':
      if (state.pc && msg.payload) {
        state.pc.addIceCandidate(msg.payload).catch(() => {});
      }
      break;

    case 'notice':
      if (msg.notice === 'broadcast-end') {
        closePeer();
        showVeil('La séance est terminée. À très vite pour le prochain film.');
        setStatus('Séance terminée', 'off');
      } else if (msg.notice === 'broadcast-start') {
        showVeil('La diffusion démarre…');
        setStatus('Démarrage', 'wait');
      }
      break;

    case 'error':
      setStatus('Erreur', 'off');
      showVeil(msg.message || 'Erreur côté serveur.');
      leave();
      toast(msg.message || 'Erreur côté serveur.');
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* WebRTC                                                              */
/* ------------------------------------------------------------------ */

function createPeer() {
  closePeer();
  const pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
  state.pc = pc;

  pc.ontrack = (ev) => {
    attachStream(ev.streams[0] || new MediaStream([ev.track]));
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) wsSend({ type: 'ice', to: state.streamerId, payload: ev.candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      setStatus('En direct', 'live');
    } else if (s === 'disconnected') {
      setStatus('Connexion instable…', 'wait');
    } else if (s === 'failed') {
      showVeil('Connexion réseau perdue. Elle devrait se rétablir — sinon, actualisez la page.');
      setStatus('Connexion perdue', 'off');
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('En direct', 'live');
  };

  return pc;
}

async function applyRemoteAndAnswer(desc, streamerId) {
  state.streamerId = streamerId;
  try {
    await state.pc.setRemoteDescription(desc);
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    wsSend({ type: 'answer', to: streamerId, payload: answer });
  } catch (e) {
    showVeil('Impossible de négocier le flux. Actualisez la page.');
  }
}

function closePeer() {
  if (state.pc) {
    try { state.pc.close(); } catch (e) {}
    state.pc = null;
  }
  clearInterval(state.watchdog);
  state.watchdog = null;
  state.streamerId = null;
  hideSoundChip();
  hideForcePlay();
}

/* ------------------------------------------------------------------ */
/* Statistiques du flux                                                */
/* ------------------------------------------------------------------ */

function startStats() {
  clearInterval(state.statsTimer);
  state.lastBytes = 0;
  state.lastStatsAt = performance.now();
  state.statsTimer = setInterval(async () => {
    if (!state.pc) { resetStats(); return; }
    let raw;
    try { raw = await state.pc.getStats(); } catch (e) { return; }
    const now = performance.now();
    const dt = (now - state.lastStatsAt) / 1000;
    if (dt <= 0) return;

    let bytes = 0, fps = null, res = null, lost = 0, received = 0, rtt = null, state4 = '—';

    raw.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
        bytes += r.bytesReceived || 0;
        if (r.framesPerSecond) fps = Math.round(r.framesPerSecond);
        if (r.frameWidth && r.frameHeight) res = r.frameWidth + ' × ' + r.frameHeight;
        lost = r.packetsLost || 0;
        received = r.packetsReceived || 0;
        state4 = r.decoderImplementation ? 'Décodeur : ' + r.decoderImplementation : 'Flux actif';
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected !== false)) {
        if (typeof r.currentRoundTripTime === 'number') rtt = Math.round(r.currentRoundTripTime * 1000);
      }
    });

    const bitrate = (bytes - state.lastBytes) * 8 / dt / 1e6;
    if (state.lastBytes > 0 && bitrate >= 0) {
      els.stBitrate.textContent = bitrate.toFixed(bitrate < 10 ? 2 : 1) + ' Mb/s';
    }
    if (fps) els.stFps.textContent = fps + ' i/s';
    if (res) els.stRes.textContent = res;
    if (rtt !== null) els.stRtt.textContent = rtt + ' ms';
    if (received + lost > 0) {
      els.stLoss.textContent = ((lost / (received + lost)) * 100).toFixed(1) + ' %';
    }
    if (state4 !== '—') els.stState.textContent = state4;
    els.stRes.textContent = els.stRes.textContent === '—' && els.video.videoWidth
      ? els.video.videoWidth + ' × ' + els.video.videoHeight
      : els.stRes.textContent;

    state.lastBytes = bytes;
    state.lastStatsAt = now;
  }, 1000);
}

function resetStats() {
  ['stRes', 'stFps', 'stBitrate', 'stRtt', 'stLoss', 'stState'].forEach((k) => { els[k].textContent = '—'; });
  state.lastBytes = 0;
}

/* ------------------------------------------------------------------ */
/* Cycle de vie de la séance                                           */
/* ------------------------------------------------------------------ */

function enterWatch() {
  els.home.hidden = true;
  els.watch.hidden = false;
}

function backHome() {
  leave();
  els.watch.hidden = true;
  els.home.hidden = false;
  els.code.focus();
  setStatus('Connexion à la séance…', 'wait');
}

function join(code) {
  const clean = normalizeCode(code);
  if (clean.length < 3) {
    els.homeError.textContent = 'Le code de séance doit contenir au moins 3 caractères.';
    els.homeError.hidden = false;
    return;
  }
  els.homeError.hidden = true;
  state.code = clean;
  state.joined = false;
  state.leaving = false;
  enterWatch();
  showVeil('Connexion à la séance…');
  setStatus('Connexion à la séance…', 'wait');
  connectWebSocket();
  startStats();
}

function leave() {
  state.leaving = true;
  clearTimeout(state.reconnectTimer);
  clearInterval(state.pingTimer);
  clearInterval(state.statsTimer);
  closePeer();
  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }
  els.video.srcObject = null;
  hideVeil();
  hideForcePlay();
  hideSoundChip();
  resetStats();
  els.stats.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Interface                                                           */
/* ------------------------------------------------------------------ */

els.heroTagline.textContent = CONFIG.TAGLINE || 'Votre écran, chez elle, en direct.';

if (!settings.serverUrl) {
  els.serverBanner.hidden = false;
}

// Code pré-rempli par le lien envoyé (…?code=AB3D9F&server=wss://…)
const preCode = normalizeCode(qs.get('code'));
if (preCode) {
  els.code.value = preCode;
  // Un code dans le lien = intention explicite de rejoindre.
  join(preCode);
}

els.joinForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  join(els.code.value);
});

els.code.addEventListener('input', () => {
  els.code.value = normalizeCode(els.code.value);
});

els.btnQuit.addEventListener('click', backHome);

/* --- Son --- */

function applyVolume(v) {
  els.video.volume = v / 100;
  els.video.muted = v === 0;
  els.icVol.style.display = v === 0 ? 'none' : 'block';
  els.icMuted.style.display = v === 0 ? 'block' : 'none';
  if (v > 0) { hideSoundChip(); state.autoBlocked = false; }
}

els.volume.addEventListener('input', () => applyVolume(parseInt(els.volume.value, 10)));
els.btnMute.addEventListener('click', () => {
  const muted = !els.video.muted;
  els.video.muted = muted;
  els.icVol.style.display = muted ? 'none' : 'block';
  els.icMuted.style.display = muted ? 'block' : 'none';
  if (!muted) { hideSoundChip(); state.autoBlocked = false; }
  els.volume.value = muted ? 0 : Math.round(els.video.volume * 100);
});

els.chipSound.addEventListener('click', () => {
  els.video.muted = false;
  state.autoBlocked = false;
  hideSoundChip();
  els.icVol.style.display = 'block';
  els.icMuted.style.display = 'none';
  if (els.video.paused) tryPlay();
});

/* --- Lecture forcée (secours anti-blocage) --- */

els.btnForcePlay.addEventListener('click', () => {
  els.video.muted = false; // ce clic EST le geste utilisateur attendu
  state.autoBlocked = false;
  tryPlay();
  hideForcePlay();
});

/* --- Plein écran --- */

els.btnFullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    els.watch.requestFullscreen().catch(() => toast('Plein écran refusé par le navigateur.'));
  }
});

document.addEventListener('fullscreenchange', () => {
  els.btnFullscreen.blur();
});

/* --- Statistiques --- */

els.btnStats.addEventListener('click', () => {
  els.stats.hidden = !els.stats.hidden;
});

/* --- Modale réglages --- */

function openSettings() {
  els.inpServer.value = settings.serverUrl || '';
  els.modalSettings.hidden = false;
  els.inpServer.focus();
}

function closeSettings() {
  els.modalSettings.hidden = true;
}

els.btnSettings.addEventListener('click', openSettings);
els.btnWatchSettings.addEventListener('click', openSettings);
els.btnSettingsClose.addEventListener('click', closeSettings);

els.modalSettings.addEventListener('click', (ev) => {
  if (ev.target === els.modalSettings) closeSettings();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !els.modalSettings.hidden) { closeSettings(); return; }
  if (els.watch.hidden || ev.target.tagName === 'INPUT') return;
  if (ev.key === 'f' || ev.key === 'F') els.btnFullscreen.click();
  if (ev.key === 'm' || ev.key === 'M') els.btnMute.click();
});

els.btnServerSave.addEventListener('click', () => {
  const url = normalizeServerUrl(els.inpServer.value);
  if (!url) { toast('Indiquez une adresse de serveur.'); return; }
  settings.serverUrl = url;
  localStorage.setItem(STORE_KEY, JSON.stringify({ serverUrl: url }));
  els.serverBanner.hidden = true;
  closeSettings();
  toast('Serveur enregistré.');
  if (!els.watch.hidden && state.code) {
    // on rebranche la séance sur le nouveau serveur
    leave();
    state.leaving = false;
    join(state.code);
  }
});

els.btnServerReset.addEventListener('click', () => {
  els.inpServer.value = CONFIG.DEFAULT_SERVER_URL || '';
});

/* --- Sortie de page propre --- */

window.addEventListener('beforeunload', () => { state.leaving = true; try { state.ws && state.ws.close(); } catch (e) {} });
