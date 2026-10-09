/* Grim Jukebox — Foundry VTT V13/V14
 * Shared turntable: YouTube links or local audio, playlists, fades, loops,
 * one simultaneous channel per playlist (e.g. Music + Ambience).
 */
const MOD = "grim-jukebox";

/* ------------------------------------------------------------------ utils */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => foundry.utils.randomID(10);
const now = () => game.time?.serverTime ?? Date.now();
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);
const route = (p) => (!p ? "" : /^(https?:|data:|blob:|\/\/)/i.test(p) ? p : foundry.utils.getRoute(p));
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, encodeURIComponent)}")`;
const isActiveGM = () => (game.users?.activeGM ? game.users.activeGM.isSelf : game.user.isGM);

function parseYouTubeId(input) {
  const s = String(input ?? "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12).match(/^[\w-]{11}$/)?.[0] ?? null;
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch (_) { /* not a URL */ }
  return null;
}

async function fetchYouTubeInfo(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: AbortSignal.timeout(4000) });
    if (r.status === 401 || r.status === 403) return { blocked: true };
    if (r.status === 404 || r.status === 400) return { missing: true };
    if (!r.ok) return {};
    return { title: (await r.json()).title || null };
  } catch (_) { return {}; }
}

function fileTitle(path) {
  let n = String(path).split("/").pop().replace(/\.[a-z0-9]+$/i, "");
  try { n = decodeURIComponent(n); } catch (_) { /* keep raw */ }
  return n || "Track";
}

/* ------------------------------------------------------------------ store */
let LIB = { playlists: [] };
let STATE = { paused: false, channels: {} };
let UIS = { x: null, y: null, mini: false, panel: true, scales: {}, collapsed: [] };

function normLib(v) {
  const lib = foundry.utils.deepClone(v ?? {});
  if (!Array.isArray(lib.playlists)) lib.playlists = [];
  for (const p of lib.playlists) if (!Array.isArray(p.tracks)) p.tracks = [];
  return lib;
}
function normState(v) {
  const s = foundry.utils.deepClone(v ?? {});
  if (!s.channels || typeof s.channels !== "object") s.channels = {};
  s.paused = !!s.paused;
  return s;
}
const findPlaylist = (plId) => LIB.playlists.find((p) => p.id === plId);
const findTrack = (plId, trId) => findPlaylist(plId)?.tracks.find((t) => t.id === trId);

async function mutateLibrary(fn) {
  if (!game.user.isGM) return;
  const lib = normLib(LIB);
  fn(lib);
  await game.settings.set(MOD, "library", lib);
}
async function mutateState(fn) {
  if (!game.user.isGM) return;
  const s = normState(STATE);
  fn(s);
  if (!Object.keys(s.channels).length) { s.paused = false; delete s.pausedAt; }
  await game.settings.set(MOD, "state", s);
}
const saveUI = () => game.settings.set(MOD, "ui", UIS);
let saveUITimer = null;
const saveUISoon = () => { clearTimeout(saveUITimer); saveUITimer = setTimeout(saveUI, 300); };

function globalVolume() {
  try { return clamp(num(game.settings.get("core", "globalPlaylistVolume"), 1)); } catch (_) { return 1; }
}

/* ----------------------------------------------------------- YouTube API */
let ytPromise = null;
function ytReady() {
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch (_) { /* ignore */ } resolve(); };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { ytPromise = null; reject(new Error("YouTube API could not be loaded")); };
      document.head.append(s);
    }
  });
  return ytPromise;
}

async function audioUnlocked() {
  try { await Promise.resolve(game.audio?.unlock); } catch (_) { /* play anyway */ }
}

/* ----------------------------------------------------------------- voices */
class Voice {
  constructor(plId, ch, track) {
    this.plId = plId;
    this.nonce = ch.nonce;
    this.startedAt = ch.startedAt;
    this.track = track;
    this.t0 = null;        // local time the sound actually started
    this.stopAt = null;    // local time a fade-out stop began
    this.dead = false;
    this.endedFired = false;
  }
  position() { return 0; }
  duration() { return 0; }
  setVolume(_v) { }
  expected() {
    let e = (now() - this.startedAt) / 1000;
    const d = this.duration();
    if (this.track.loop && d > 0) e %= d;
    return Math.max(0, e);
  }
  tick() {
    if (this.dead) return;
    if (!this.t0) return;
    const t = performance.now();
    const fi = num(this.track.fadeIn, 0), fo = num(this.track.fadeOut, 0);
    let g = fi > 0 ? clamp((t - this.t0) / fi) : 1;
    if (!this.track.loop && fo > 0) {
      const d = this.duration();
      if (d > 0) g *= clamp(((d - this.position()) * 1000) / fo);
    }
    if (this.stopAt) {
      const k = fo > 0 ? clamp(1 - (t - this.stopAt) / fo) : 0;
      if (k <= 0) return this.destroy();
      g *= k;
    }
    this.setVolume(g * Jukebox.level(this.plId, this.track));
  }
  stop() {
    if (this.stopAt || this.dead) return;
    if (!this.t0) return this.destroy();
    this.stopAt = performance.now();
  }
  ended() {
    if (this.endedFired || this.stopAt || this.dead) return;
    this.endedFired = true;
    Jukebox.onVoiceEnded(this);
  }
  destroy() { this.dead = true; Jukebox.removeVoice(this); }
}

class YTVoice extends Voice {
  async start() {
    try { await ytReady(); } catch (err) {
      console.warn(`${MOD} |`, err);
      Jukebox.onVoiceError(this, "api");
      return this.destroy();
    }
    if (this.dead) return;
    const f = document.createElement("iframe");
    const q = new URLSearchParams({ enablejsapi: "1", autoplay: "0", controls: "1", disablekb: "1", fs: "0", playsinline: "1", rel: "0", iv_load_policy: "3", origin: location.origin });
    f.src = `https://www.youtube.com/embed/${this.track.src}?${q}`;
    f.allow = "autoplay; encrypted-media";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.width = "320"; f.height = "180";
    f.title = this.track.name ?? "YouTube";
    UI.ytFrames.append(f);
    this.frame = f;
    this.player = new YT.Player(f, {
      events: {
        onReady: () => this.onReady(),
        onStateChange: (e) => this.onState(e),
        onError: (e) => Jukebox.onVoiceError(this, e.data)
      }
    });
  }
  onReady() {
    if (this.dead) return;
    this.ready = true;
    try {
      this.player.unMute();
      this.player.setVolume(0);
      const e = (now() - this.startedAt) / 1000;
      if (e > 2 && !this.track.loop) this.player.seekTo(e, true);
      this.player.playVideo();
    } catch (err) { console.warn(`${MOD} |`, err); }
  }
  onState(e) {
    if (this.dead) return;
    const S = YT.PlayerState;
    if (e.data === S.PLAYING) {
      const first = !this.t0;
      if (first) this.t0 = performance.now();
      if (first || !this.track.loop) this.sync();
      if (first) Jukebox.onMeta(this, this.player.getVideoData?.()?.title);
    } else if (e.data === S.ENDED) {
      if (this.track.loop && !this.stopAt) { this.player.seekTo(0, true); this.player.playVideo(); }
      else this.ended();
    }
  }
  /* pull this client back to the shared timeline (late join, buffering, ads) */
  sync() {
    const t = performance.now();
    if (this.lastSync && t - this.lastSync < 5000) return;
    const exp = this.expected();
    if (Math.abs(this.position() - exp) > 2) { this.lastSync = t; this.player.seekTo(exp, true); }
  }
  position() { try { return this.ready ? this.player.getCurrentTime() || 0 : 0; } catch (_) { return 0; } }
  duration() { try { return this.ready ? this.player.getDuration() || 0 : 0; } catch (_) { return 0; } }
  setVolume(v) {
    const iv = Math.round(clamp(v) * 100);
    if (iv === this.lastVol || !this.ready) return;
    this.lastVol = iv;
    try { this.player.setVolume(iv); } catch (_) { /* ignore */ }
  }
  destroy() {
    try { this.player?.destroy(); } catch (_) { /* ignore */ }
    this.frame?.remove();
    super.destroy();
  }
}

class FileVoice extends Voice {
  async start() {
    if (this.dead) return;
    const a = new Audio();
    this.audio = a;
    a.preload = "auto";
    a.loop = !!this.track.loop;
    a.volume = 0;
    a.addEventListener("loadedmetadata", () => {
      if (this.dead) return;
      const e = this.expected();
      if (!this.track.loop && Number.isFinite(a.duration) && e >= a.duration) return this.ended();
      if (e > 0.5) { try { a.currentTime = e; } catch (_) { /* unseekable stream */ } }
      a.play().then(() => { if (!this.t0) this.t0 = performance.now(); })
        .catch((err) => console.warn(`${MOD} | playback blocked`, err));
    });
    a.addEventListener("ended", () => this.ended());
    a.addEventListener("error", () => Jukebox.onVoiceError(this, "file"));
    a.src = route(this.track.src);
  }
  position() { return this.audio?.currentTime || 0; }
  duration() { const d = this.audio?.duration; return Number.isFinite(d) ? d : 0; }
  setVolume(v) { if (this.audio) this.audio.volume = clamp(v); }
  destroy() {
    if (this.audio) { try { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); } catch (_) { /* ignore */ } }
    super.destroy();
  }
}

/* ---------------------------------------------------------------- jukebox */
const Jukebox = {
  voices: new Map(),
  dying: new Set(),
  warned: new Set(),

  /* what a listener hears for this channel, 0..1 */
  level(plId, track) {
    const scale = num(UIS.scales?.[plId], 1);
    return clamp((num(track.volume, 100) / 100) * scale) * globalVolume();
  },
  /* slider position 0..100 for this channel on this client */
  sliderValue(plId, track) {
    return Math.round(clamp((num(track.volume, 100) / 100) * num(UIS.scales?.[plId], 1)) * 100);
  },
  setSlider(plId, track, value) {
    const base = Math.max(1, num(track.volume, 100));
    UIS.scales = UIS.scales ?? {};
    UIS.scales[plId] = clamp(value, 0, 100) / base;
  },

  /* reconcile local playback with the shared state */
  apply() {
    for (const [plId, v] of [...this.voices]) {
      const ch = STATE.channels[plId];
      if (STATE.paused || !ch || ch.nonce !== v.nonce) {
        this.voices.delete(plId);
        this.dying.add(v);
        v.stop();
      }
    }
    if (!STATE.paused) {
      for (const [plId, ch] of Object.entries(STATE.channels)) {
        if (this.voices.has(plId)) continue;
        const track = findTrack(plId, ch.trackId);
        if (!track) continue;
        const v = track.type === "file" ? new FileVoice(plId, ch, track) : new YTVoice(plId, ch, track);
        this.voices.set(plId, v);
        this.launch(v);
      }
    }
    UI.update();
  },
  async launch(v) {
    await audioUnlocked();
    if (v.dead || v.stopAt) return v.destroy();
    v.start();
  },
  removeVoice(v) {
    this.dying.delete(v);
    if (this.voices.get(v.plId) === v) this.voices.delete(v.plId);
  },
  refreshTracks() {
    for (const v of this.voices.values()) {
      const t = findTrack(v.plId, v.track.id);
      if (!t) continue;
      v.track = t;
      if (v.audio) v.audio.loop = !!t.loop;
    }
  },
  tick() {
    for (const v of [...this.voices.values(), ...this.dying]) v.tick();
  },

  /* ---- GM actions ---- */
  _resume(s) {
    if (!s.paused) return;
    const d = now() - num(s.pausedAt, now());
    for (const ch of Object.values(s.channels)) ch.startedAt += d;
    s.paused = false;
    delete s.pausedAt;
  },
  play(plId, trackId, played) {
    if (!findTrack(plId, trackId)) return;
    return mutateState((s) => {
      this._resume(s);
      s.channels[plId] = { trackId, startedAt: now(), nonce: uid(), played: played ?? [trackId] };
    });
  },
  stop(plId) { return mutateState((s) => { delete s.channels[plId]; }); },
  stopAll() { return mutateState((s) => { s.channels = {}; }); },
  toggleNeedle() {
    if (!game.user.isGM) return;
    if (!Object.keys(STATE.channels).length) {
      ui.notifications?.info("Grim Jukebox: pick a track from a playlist first.");
      return;
    }
    return mutateState((s) => {
      if (s.paused) this._resume(s);
      else { s.paused = true; s.pausedAt = now(); }
    });
  },
  advance(plId) {
    const pl = findPlaylist(plId), ch = STATE.channels[plId];
    if (!pl || !ch) return this.stop(plId);
    const ids = pl.tracks.map((t) => t.id);
    if (!ids.length) return this.stop(plId);
    if (pl.mode === "shuffle") {
      let played = (ch.played ?? []).filter((id) => ids.includes(id));
      let pool = ids.filter((id) => !played.includes(id));
      if (!pool.length) {
        if (!pl.loop) return this.stop(plId);
        played = [];
        pool = ids.length > 1 ? ids.filter((id) => id !== ch.trackId) : ids;
      }
      const next = pool[Math.floor(Math.random() * pool.length)];
      return this.play(plId, next, [...played, next]);
    }
    const i = ids.indexOf(ch.trackId) + 1;
    if (i < ids.length) return this.play(plId, ids[i]);
    return pl.loop ? this.play(plId, ids[0]) : this.stop(plId);
  },

  /* ---- voice callbacks ---- */
  onVoiceEnded(v) {
    if (!isActiveGM()) return;
    if (STATE.channels[v.plId]?.nonce !== v.nonce) return;
    this.advance(v.plId);
  },
  onMeta(v, title) {
    if (!isActiveGM() || !title || !v.track.autoName || v.track.name === title) return;
    const { plId } = v, trId = v.track.id;
    mutateLibrary((lib) => {
      const t = lib.playlists.find((p) => p.id === plId)?.tracks.find((x) => x.id === trId);
      if (t) t.name = title;
    });
  },
  onVoiceError(v, code) {
    console.warn(`${MOD} | playback error`, code, v.track);
    if (!game.user.isGM) return;
    const name = v.track.name ?? "track";
    const why = {
      2: "the YouTube link is invalid",
      5: "YouTube could not play it in this browser",
      100: "the video is private or was removed",
      101: "its owner does not allow playing it outside YouTube",
      150: "its owner does not allow playing it outside YouTube",
      153: "YouTube rejected the embedded player (missing referrer)",
      api: "the YouTube player could not be loaded (blocked or offline)",
      file: "the audio file could not be loaded"
    }[code] ?? `error ${code}`;
    const key = `${v.nonce}:${code}`;
    if (!this.warned.has(key)) { this.warned.add(key); ui.notifications?.warn(`Grim Jukebox: "${name}" cannot play — ${why}.`); }
    if (isActiveGM() && STATE.channels[v.plId]?.nonce === v.nonce) this.stop(v.plId);
  }
};

/* --------------------------------------------------------------------- UI */
const ARM_SVG = `<svg viewBox="0 0 60 200" aria-hidden="true">
  <rect class="a-weight" x="21" y="3" width="18" height="24" rx="3"/>
  <line class="a-tube" x1="30" y1="26" x2="30" y2="170"/>
  <circle class="a-cap" cx="30" cy="40" r="9"/><circle class="a-capdot" cx="30" cy="40" r="3"/>
  <g transform="rotate(18 30 168)">
    <rect class="a-head" x="22" y="164" width="16" height="27" rx="2.5"/>
    <line class="a-lift" x1="38" y1="171" x2="48" y2="167"/>
    <rect class="a-stylus" x="26" y="185" width="8" height="4" rx="1"/>
  </g></svg>`;

const discHTML = () => `<div class="gjb-platter"><div class="gjb-record"><div class="gjb-cover"></div><div class="gjb-label"><i class="fa-solid fa-music"></i></div><div class="gjb-grooves"></div><div class="gjb-spindle"></div></div><div class="gjb-sheen"></div></div>`;

const UI = {
  root: null, ytHost: null, ytFrames: null, focusPl: null, dragging: false,

  build() {
    const gm = game.user.isGM;
    const root = document.createElement("div");
    root.id = "gjb";
    root.className = `gjb ${gm ? "is-gm" : "is-player"}`;
    root.innerHTML = `
      <div class="gjb-mini" data-drag title="Grim Jukebox — click to open">${discHTML()}</div>
      <div class="gjb-deck">
        <div class="gjb-plinth" data-drag>
          <i class="gjb-screw s1"></i><i class="gjb-screw s2"></i><i class="gjb-screw s3"></i><i class="gjb-screw s4"></i>
          ${discHTML()}
          <div class="gjb-armbase"></div>
          <button type="button" class="gjb-arm" data-action="needle" title="${gm ? "Drop / lift the needle — plays or stops for everyone" : "Only the DM can move the needle"}">${ARM_SVG}</button>
          <div class="gjb-brand">Grim Jukebox</div>
          <div class="gjb-knobs">
            <button type="button" data-action="peek" title="Show the YouTube players (skip an ad, check a video)"><i class="fa-brands fa-youtube"></i></button>
            ${gm ? `<button type="button" data-action="panel" title="Playlists"><i class="fa-solid fa-list"></i></button>` : ""}
            <button type="button" data-action="mini" title="Minimise"><i class="fa-solid fa-minus"></i></button>
          </div>
        </div>
        <div class="gjb-now"><i class="fa-solid fa-compact-disc"></i><span class="gjb-now-text"></span></div>
        <div class="gjb-channels"></div>
      </div>
      ${gm ? `<div class="gjb-panel"></div>` : ""}`;
    document.body.append(root);
    this.root = root;

    const yt = document.createElement("div");
    yt.id = "gjb-yt";
    yt.innerHTML = `<div class="gjb-yt-head"><span><i class="fa-brands fa-youtube"></i> YouTube players</span><button type="button" title="Hide"><i class="fa-solid fa-xmark"></i></button></div><div class="gjb-yt-frames"></div><div class="gjb-yt-empty">Nothing is playing from YouTube.</div>`;
    yt.querySelector("button").addEventListener("click", () => yt.classList.remove("is-open"));
    document.body.append(yt);
    this.ytHost = yt;
    this.ytFrames = yt.querySelector(".gjb-yt-frames");

    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("input", (e) => this.onSlider(e, false));
    root.addEventListener("change", (e) => this.onSlider(e, true));
    for (const h of root.querySelectorAll("[data-drag]")) h.addEventListener("pointerdown", (e) => this.onDragStart(e));
    window.addEventListener("resize", () => this.place());

    this.applyTheme();
    this.update();
    this.place();
  },

  applyTheme() {
    let theme = "crimson";
    try { theme = game.settings.get(MOD, "theme"); } catch (_) { /* default */ }
    for (const el of [this.root, this.ytHost, document.getElementById("gjb-modal")]) if (el) el.dataset.gjbTheme = theme;
  },

  place() {
    const r = this.root;
    if (!r) return;
    r.classList.toggle("is-mini", !!UIS.mini);
    r.classList.toggle("panel-open", !!UIS.panel && game.user.isGM);
    const w = r.offsetWidth || 320, h = r.offsetHeight || 380;
    let x = UIS.x ?? 16, y = UIS.y ?? window.innerHeight - h - 90;
    x = clamp(x, 4, Math.max(4, window.innerWidth - w - 4));
    y = clamp(y, 4, Math.max(4, window.innerHeight - h - 4));
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
  },

  onDragStart(e) {
    if (e.button !== 0 || e.target.closest("button, input, .gjb-arm")) return;
    const r = this.root, box = r.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, ox = box.left, oy = box.top;
    const isMini = !!e.currentTarget.classList.contains("gjb-mini");
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      r.classList.add("is-dragging");
      UIS.x = ox + dx; UIS.y = oy + dy;
      this.place();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      r.classList.remove("is-dragging");
      if (moved) { const b = r.getBoundingClientRect(); UIS.x = b.left; UIS.y = b.top; saveUI(); }
      else if (isMini) { UIS.mini = false; this.place(); saveUI(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },

  displayed() {
    const entries = Object.entries(STATE.channels).filter(([plId, ch]) => findTrack(plId, ch.trackId));
    if (!entries.length) return null;
    const hit = entries.find(([plId]) => plId === this.focusPl) ?? entries.sort((a, b) => b[1].startedAt - a[1].startedAt)[0];
    return { plId: hit[0], track: findTrack(hit[0], hit[1].trackId) };
  },

  update() {
    const r = this.root;
    if (!r) return;
    const entries = Object.entries(STATE.channels).filter(([plId, ch]) => findTrack(plId, ch.trackId));
    const playing = entries.length > 0 && !STATE.paused;
    const shown = this.displayed();
    r.classList.toggle("is-spinning", playing);
    r.classList.toggle("is-paused", entries.length > 0 && STATE.paused);
    r.classList.toggle("is-empty", !entries.length);

    // cover art
    let cover = "", kind = "none";
    if (shown?.track.cover) { cover = cssUrl(route(shown.track.cover)); kind = "img"; }
    else if (shown?.track.type === "youtube") { cover = cssUrl(`https://i.ytimg.com/vi/${shown.track.src}/hqdefault.jpg`); kind = "yt"; }
    for (const rec of r.querySelectorAll(".gjb-record")) {
      rec.dataset.cover = kind;
      rec.querySelector(".gjb-cover").style.backgroundImage = cover || "none";
    }

    // now playing
    const txt = r.querySelector(".gjb-now-text");
    txt.textContent = !shown ? "Silence" : STATE.paused ? `Needle lifted — ${shown.track.name}` : shown.track.name;
    txt.title = txt.textContent;

    // volume bars — one per sounding channel
    const box = r.querySelector(".gjb-channels");
    const active = document.activeElement;
    if (!(active && box.contains(active) && active.matches("input[type=range]") && box.dataset.sig === this.channelSig(entries))) {
      box.dataset.sig = this.channelSig(entries);
      box.innerHTML = entries.length ? entries.map(([plId, ch]) => {
        const pl = findPlaylist(plId), t = findTrack(plId, ch.trackId), v = Jukebox.sliderValue(plId, t);
        return `<div class="gjb-ch ${shown?.plId === plId ? "is-shown" : ""}" data-pl="${esc(plId)}">
          <button type="button" class="gjb-ch-name" data-action="focus" title="${esc(pl.name)} — ${esc(t.name)}\nClick to show this cover on the record"><b>${esc(pl.name)}</b><span>${esc(t.name)}</span></button>
          <div class="gjb-ch-bar"><i class="fa-solid fa-volume-low"></i><input type="range" min="0" max="100" step="1" value="${v}" style="--v:${v}%" aria-label="Volume: ${esc(pl.name)}"><output>${v}</output></div>
        </div>`;
      }).join("") : `<div class="gjb-ch-empty"><div class="gjb-ch-bar"><i class="fa-solid fa-volume-off"></i><input type="range" min="0" max="100" value="0" style="--v:0%" disabled><output>–</output></div></div>`;
    }
    this.ytHost?.classList.toggle("has-frames", [...Jukebox.voices.values()].some((v) => v instanceof YTVoice));
    if (game.user.isGM) this.renderPanel();
    this.place();
  },
  channelSig(entries) {
    return entries.map(([plId, ch]) => { const t = findTrack(plId, ch.trackId); return `${plId}:${ch.nonce}:${t.volume}:${t.name}:${findPlaylist(plId).name}`; }).join("|") + `|${this.focusPl}`;
  },

  renderPanel() {
    const panel = this.root.querySelector(".gjb-panel");
    if (!panel) return;
    const scroll = panel.querySelector(".gjb-pls")?.scrollTop ?? 0;
    const collapsed = new Set(UIS.collapsed ?? []);
    const pls = LIB.playlists.map((pl) => {
      const ch = STATE.channels[pl.id];
      const tracks = pl.tracks.map((t) => {
        const on = ch?.trackId === t.id;
        return `<li class="gjb-tr ${on ? "is-on" : ""}" data-tr="${esc(t.id)}">
          <button type="button" class="gjb-tr-play" data-action="${on ? "stop-pl" : "play"}" title="${on ? "Stop" : "Play for everyone"}"><i class="fa-solid ${on ? "fa-stop" : "fa-play"}"></i></button>
          <i class="gjb-tr-type ${t.type === "file" ? "fa-solid fa-file-audio" : "fa-brands fa-youtube"}" title="${t.type === "file" ? "Local file" : "YouTube"}"></i>
          <span class="gjb-tr-name" title="${esc(t.name)}">${esc(t.name)}</span>
          <span class="gjb-tr-vol">${num(t.volume, 100)}%</span>
          <button type="button" class="${t.loop ? "is-active" : ""}" data-action="tr-loop" title="Loop this track"><i class="fa-solid fa-repeat"></i></button>
          <button type="button" data-action="tr-edit" title="Edit track"><i class="fa-solid fa-pen"></i></button>
        </li>`;
      }).join("");
      return `<section class="gjb-pl ${collapsed.has(pl.id) ? "is-collapsed" : ""} ${ch ? "is-on" : ""}" data-pl="${esc(pl.id)}">
        <header>
          <button type="button" class="gjb-pl-fold" data-action="fold" title="Fold / unfold"><i class="fa-solid fa-chevron-down"></i></button>
          <span class="gjb-pl-name" title="${esc(pl.name)}">${esc(pl.name)}</span>
          <button type="button" class="${pl.mode === "shuffle" ? "is-active" : ""}" data-action="pl-shuffle" title="Shuffle"><i class="fa-solid fa-shuffle"></i></button>
          <button type="button" class="${pl.loop ? "is-active" : ""}" data-action="pl-loop" title="Repeat the whole playlist"><i class="fa-solid fa-arrows-rotate"></i></button>
          <button type="button" data-action="pl-edit" title="Edit playlist"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="gjb-add" data-action="tr-add" title="Add a track"><i class="fa-solid fa-plus"></i></button>
        </header>
        <ul>${tracks || `<li class="gjb-tr-empty">No tracks yet — press <i class="fa-solid fa-plus"></i></li>`}</ul>
      </section>`;
    }).join("");
    panel.innerHTML = `
      <div class="gjb-panel-head"><span>Playlists</span><button type="button" data-action="stop-all" title="Stop everything"><i class="fa-solid fa-stop"></i> Stop all</button></div>
      <div class="gjb-pls">${pls || `<div class="gjb-pls-empty">Create a playlist for each layer you want to run at once — for example <b>Music</b> and <b>Ambience</b>.</div>`}</div>
      <button type="button" class="gjb-newpl" data-action="pl-add"><i class="fa-solid fa-plus"></i> New playlist</button>`;
    const box = panel.querySelector(".gjb-pls");
    if (box) box.scrollTop = scroll;
  },

  onSlider(e, commit) {
    const input = e.target.closest(".gjb-ch input[type=range]");
    if (!input) return;
    const plId = input.closest(".gjb-ch").dataset.pl;
    const track = findTrack(plId, STATE.channels[plId]?.trackId);
    if (!track) return;
    const v = num(input.value, 0);
    Jukebox.setSlider(plId, track, v);
    input.style.setProperty("--v", `${v}%`);
    input.parentElement.querySelector("output").textContent = v;
    if (commit) { saveUI(); input.blur(); } else saveUISoon();
  },

  onClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el || !this.root.contains(el)) return;
    const action = el.dataset.action;
    const plId = el.closest("[data-pl]")?.dataset.pl;
    const trId = el.closest("[data-tr]")?.dataset.tr;
    const gm = game.user.isGM;
    switch (action) {
      case "mini": UIS.mini = true; this.place(); saveUI(); return;
      case "peek": this.ytHost.classList.toggle("is-open"); return;
      case "focus": this.focusPl = plId; this.update(); return;
    }
    if (!gm) return;
    switch (action) {
      case "needle": return Jukebox.toggleNeedle();
      case "panel": UIS.panel = !UIS.panel; this.place(); saveUI(); return;
      case "play": this.focusPl = plId; return Jukebox.play(plId, trId);
      case "stop-pl": return Jukebox.stop(plId);
      case "stop-all": return Jukebox.stopAll();
      case "fold": {
        const set = new Set(UIS.collapsed ?? []);
        set.has(plId) ? set.delete(plId) : set.add(plId);
        UIS.collapsed = [...set]; saveUI(); this.renderPanel(); return;
      }
      case "pl-shuffle": return mutateLibrary((lib) => { const p = lib.playlists.find((x) => x.id === plId); if (p) p.mode = p.mode === "shuffle" ? "sequential" : "shuffle"; });
      case "pl-loop": return mutateLibrary((lib) => { const p = lib.playlists.find((x) => x.id === plId); if (p) p.loop = !p.loop; });
      case "tr-loop": return mutateLibrary((lib) => { const t = lib.playlists.find((x) => x.id === plId)?.tracks.find((x) => x.id === trId); if (t) t.loop = !t.loop; });
      case "pl-add": return Forms.playlist(null);
      case "pl-edit": return Forms.playlist(plId);
      case "tr-add": return Forms.track(plId, null);
      case "tr-edit": return Forms.track(plId, trId);
    }
  }
};

/* ------------------------------------------------------------------ forms */
function pickFile(type, current, cb) {
  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  if (!FP) return ui.notifications?.warn("Grim Jukebox: the file browser is not available.");
  new FP({ type, current: current || "", callback: (path) => cb(path) }).render(true);
}

const Forms = {
  close() { document.getElementById("gjb-modal")?.remove(); },

  open({ title, body, submitLabel = "Save", onSubmit, onDelete, deleteLabel = "Delete" }) {
    this.close();
    const wrap = document.createElement("div");
    wrap.id = "gjb-modal";
    wrap.innerHTML = `<form class="gjb-form" novalidate>
      <h3>${esc(title)}</h3>
      <div class="gjb-form-body">${body}</div>
      <p class="gjb-form-error" hidden></p>
      <footer>
        ${onDelete ? `<button type="button" class="gjb-btn danger" data-act="delete"><i class="fa-solid fa-trash"></i> ${esc(deleteLabel)}</button>` : ""}
        <span class="gjb-spacer"></span>
        <button type="button" class="gjb-btn ghost" data-act="cancel">Cancel</button>
        <button type="submit" class="gjb-btn primary">${esc(submitLabel)}</button>
      </footer></form>`;
    document.body.append(wrap);
    UI.applyTheme();
    const form = wrap.querySelector("form"), err = wrap.querySelector(".gjb-form-error");
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) this.close(); });
    wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") this.close(); });
    form.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") this.close();
      if (act === "delete") {
        const b = e.target.closest("button");
        if (b.dataset.armed) { await onDelete(); this.close(); }
        else { b.dataset.armed = "1"; b.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Click again to delete`; }
      }
      const browse = e.target.closest("[data-browse]");
      if (browse) {
        const input = form.elements[browse.dataset.target];
        pickFile(browse.dataset.browse, input.value, (path) => { input.value = path; input.dispatchEvent(new Event("input", { bubbles: true })); });
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const res = await onSubmit(Object.fromEntries(new FormData(form)), form);
        if (typeof res === "string") fail(res); else this.close();
      } catch (ex) { console.error(`${MOD} |`, ex); fail("Something went wrong — see the console (F12)."); }
      btn.disabled = false;
    });
    setTimeout(() => form.querySelector("input[type=text], input:not([type])")?.focus(), 30);
    return form;
  },

  playlist(plId) {
    const pl = plId ? findPlaylist(plId) : null;
    if (plId && !pl) return;
    const mode = pl?.mode ?? "sequential";
    this.open({
      title: pl ? "Edit playlist" : "New playlist",
      body: `
        <label class="gjb-f">Name<input type="text" name="name" value="${esc(pl?.name ?? "")}" placeholder="Music, Ambience, Combat…" maxlength="60"></label>
        <div class="gjb-f">Play order
          <div class="gjb-seg">
            <label><input type="radio" name="mode" value="sequential" ${mode !== "shuffle" ? "checked" : ""}><span><i class="fa-solid fa-arrow-down-1-9"></i> In order</span></label>
            <label><input type="radio" name="mode" value="shuffle" ${mode === "shuffle" ? "checked" : ""}><span><i class="fa-solid fa-shuffle"></i> Shuffle</span></label>
          </div></div>
        <label class="gjb-check"><input type="checkbox" name="loop" ${pl?.loop ?? true ? "checked" : ""}><span>Repeat the playlist when it reaches the end</span></label>
        <p class="gjb-hint">Each playlist is its own channel: one track per playlist can play at the same time as tracks from other playlists.</p>`,
      submitLabel: pl ? "Save" : "Create",
      onSubmit: async (d) => {
        const name = String(d.name ?? "").trim() || `Playlist ${LIB.playlists.length + (pl ? 0 : 1)}`;
        await mutateLibrary((lib) => {
          let p = lib.playlists.find((x) => x.id === plId);
          if (!p) { p = { id: uid(), tracks: [] }; lib.playlists.push(p); }
          Object.assign(p, { name, mode: d.mode === "shuffle" ? "shuffle" : "sequential", loop: !!d.loop });
        });
      },
      deleteLabel: "Delete playlist",
      onDelete: pl ? async () => {
        if (STATE.channels[plId]) await Jukebox.stop(plId);
        await mutateLibrary((lib) => { lib.playlists = lib.playlists.filter((x) => x.id !== plId); });
      } : null
    });
  },

  track(plId, trId) {
    const pl = findPlaylist(plId);
    if (!pl) return;
    const tr = trId ? pl.tracks.find((t) => t.id === trId) : null;
    if (trId && !tr) return;
    const type = tr?.type ?? "youtube";
    const vol = num(tr?.volume, 100);
    const form = this.open({
      title: tr ? "Edit track" : `Add a track to “${pl.name}”`,
      body: `
        <div class="gjb-seg">
          <label><input type="radio" name="type" value="youtube" ${type === "youtube" ? "checked" : ""}><span><i class="fa-brands fa-youtube"></i> YouTube link</span></label>
          <label><input type="radio" name="type" value="file" ${type === "file" ? "checked" : ""}><span><i class="fa-solid fa-file-audio"></i> File on this server</span></label>
        </div>
        <label class="gjb-f" data-for="youtube">YouTube link<input type="text" name="url" value="${tr?.type === "youtube" ? `https://youtu.be/${esc(tr.src)}` : ""}" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"></label>
        <label class="gjb-f" data-for="file">Audio file
          <span class="gjb-row"><input type="text" name="src" value="${tr?.type === "file" ? esc(tr.src) : ""}" placeholder="music/tavern.ogg" autocomplete="off"><button type="button" class="gjb-btn ghost" data-browse="audio" data-target="src"><i class="fa-solid fa-folder-open"></i> Browse</button></span></label>
        <label class="gjb-f">Name<input type="text" name="name" value="${tr && !tr.autoName ? esc(tr.name) : ""}" placeholder="Empty = use the YouTube title / file name" maxlength="120" autocomplete="off"></label>
        <div class="gjb-grid2">
          <label class="gjb-f">Fade in (ms)<input type="number" name="fadeIn" value="${num(tr?.fadeIn, 1000)}" min="0" max="60000" step="100"></label>
          <label class="gjb-f">Fade out (ms)<input type="number" name="fadeOut" value="${num(tr?.fadeOut, 1000)}" min="0" max="60000" step="100"></label>
        </div>
        <label class="gjb-f"><span>Volume <output class="gjb-volout">${vol}%</output></span>
          <input type="range" name="volume" min="0" max="100" step="1" value="${vol}" style="--v:${vol}%"></label>
        <label class="gjb-check"><input type="checkbox" name="loop" ${tr?.loop ? "checked" : ""}><span>Loop this track until I change it</span></label>
        <label class="gjb-f">Record art <small>(optional — YouTube tracks use the video thumbnail)</small>
          <span class="gjb-row"><input type="text" name="cover" value="${esc(tr?.cover ?? "")}" placeholder="Image path" autocomplete="off"><button type="button" class="gjb-btn ghost" data-browse="image" data-target="cover"><i class="fa-solid fa-image"></i> Browse</button></span></label>`,
      submitLabel: tr ? "Save" : "Add track",
      onSubmit: async (d) => {
        const data = {
          type: d.type === "file" ? "file" : "youtube",
          loop: !!d.loop,
          fadeIn: clamp(Math.round(num(d.fadeIn, 1000)), 0, 60000),
          fadeOut: clamp(Math.round(num(d.fadeOut, 1000)), 0, 60000),
          volume: clamp(Math.round(num(d.volume, 100)), 0, 100),
          cover: String(d.cover ?? "").trim()
        };
        let name = String(d.name ?? "").trim();
        let warn = null;
        if (data.type === "youtube") {
          const id = parseYouTubeId(d.url);
          if (!id) return "That does not look like a YouTube link. Paste the full address of the video.";
          data.src = id;
          data.autoName = !name;
          if (!name) {
            if (tr?.type === "youtube" && tr.src === id && tr.autoName) name = tr.name;
            else {
              const info = await fetchYouTubeInfo(id);
              if (info.missing) return "YouTube says this video does not exist or is private.";
              if (info.blocked) warn = "this video's owner may not allow playing it outside YouTube — test it before the session.";
              name = info.title || `YouTube · ${id}`;
            }
          }
        } else {
          const src = String(d.src ?? "").trim();
          if (!src) return "Choose an audio file with Browse.";
          data.src = src;
          data.autoName = false;
          if (!name) name = fileTitle(src);
        }
        data.name = name;
        const changedSource = tr && (tr.type !== data.type || tr.src !== data.src);
        await mutateLibrary((lib) => {
          const p = lib.playlists.find((x) => x.id === plId);
          if (!p) return;
          let t = p.tracks.find((x) => x.id === trId);
          if (!t) { t = { id: uid() }; p.tracks.push(t); }
          Object.assign(t, data);
        });
        if (changedSource && STATE.channels[plId]?.trackId === trId) await Jukebox.play(plId, trId);
        if (warn) ui.notifications?.warn(`Grim Jukebox: "${name}" — ${warn}`);
      },
      deleteLabel: "Remove track",
      onDelete: tr ? async () => {
        if (STATE.channels[plId]?.trackId === trId) await Jukebox.stop(plId);
        await mutateLibrary((lib) => { const p = lib.playlists.find((x) => x.id === plId); if (p) p.tracks = p.tracks.filter((x) => x.id !== trId); });
      } : null
    });
    const syncType = () => { form.dataset.type = form.elements.type.value; };
    form.addEventListener("change", syncType);
    form.addEventListener("input", (e) => {
      if (e.target.name !== "volume") return;
      e.target.style.setProperty("--v", `${e.target.value}%`);
      form.querySelector(".gjb-volout").textContent = `${e.target.value}%`;
    });
    syncType();
  }
};

/* ------------------------------------------------------------------ hooks */
Hooks.once("init", () => {
  game.settings.register(MOD, "library", {
    scope: "world", config: false, type: Object, default: { playlists: [] },
    onChange: (v) => { LIB = normLib(v); Jukebox.refreshTracks(); Jukebox.apply(); }
  });
  game.settings.register(MOD, "state", {
    scope: "world", config: false, type: Object, default: { paused: false, channels: {} },
    onChange: (v) => { STATE = normState(v); Jukebox.apply(); }
  });
  game.settings.register(MOD, "ui", { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MOD, "theme", {
    name: "Colour theme",
    hint: "Set by the DM and applied to every player, like the other Grim modules.",
    scope: "world", config: true, type: String, default: "crimson",
    choices: { crimson: "Black & Red", ash: "Black, Grey & White", amethyst: "White & Purple", abyss: "Black & Blue" },
    onChange: () => UI.applyTheme()
  });
});

Hooks.once("ready", () => {
  LIB = normLib(game.settings.get(MOD, "library"));
  STATE = normState(game.settings.get(MOD, "state"));
  UIS = Object.assign(UIS, foundry.utils.deepClone(game.settings.get(MOD, "ui") ?? {}));
  UI.build();
  Jukebox.apply();
  setInterval(() => Jukebox.tick(), 50);

  const mod = game.modules?.get(MOD);
  if (mod) mod.api = {
    play: (plId, trId) => Jukebox.play(plId, trId),
    stop: (plId) => Jukebox.stop(plId),
    stopAll: () => Jukebox.stopAll(),
    toggleNeedle: () => Jukebox.toggleNeedle(),
    toggleWindow: () => { UIS.mini = !UIS.mini; UI.place(); saveUI(); },
    resetPosition: () => { UIS.x = null; UIS.y = null; UIS.mini = false; UI.place(); saveUI(); }
  };
});
