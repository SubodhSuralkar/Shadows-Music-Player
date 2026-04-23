/**
 * SONATA — Music Player  v3
 */

"use strict";

const SONGS_URL        = "songs.json";
const LS_SONG_KEY      = "sonata_last_song";
const LS_VOL_KEY       = "sonata_volume";
const LS_FAVORITES_KEY = "sonata_favorites";
const LS_AUTOPLAY_KEY  = "sonata_autoplay";
const LS_SHUFFLE_KEY   = "sonata_shuffle";

const FADE_DURATION_MS = 2000;
const SWIPE_THRESHOLD  = 50;
const SWIPE_VERT_MAX   = 75;

const FALLBACK_ART = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='512' height='512'%3E%3Crect width='512' height='512' fill='%23111'/%3E%3Ccircle cx='256' cy='256' r='80' fill='%23222'/%3E%3C/svg%3E";

let songs             = [];
let filteredSongs     = [];
let currentIndex      = -1;
let isPlaying         = false;

let favorites         = new Set();
let showFavoritesOnly = false;
let autoplayEnabled   = true;

let isShuffled    = false;
let shuffleQueue  = [];
let shufflePos    = -1;

let userVolume    = 0.8;
let fadeRafId     = null;

let hasReloadAttempted = false;

const audio              = document.getElementById("audio-player");
const vinylStage         = document.getElementById("vinyl-stage");
const vinyl              = document.getElementById("vinyl");
const coverArt           = document.getElementById("cover-art");
const trackTitle         = document.getElementById("track-title");
const trackArtist        = document.getElementById("track-artist");
const trackAlbum         = document.getElementById("track-album");
const progressFill       = document.getElementById("progress-fill");
const seekBar            = document.getElementById("seek-bar");
const timeCurrent        = document.getElementById("time-current");
const timeTotal          = document.getElementById("time-total");
const btnPlay            = document.getElementById("btn-play");
const btnPrev            = document.getElementById("btn-prev");
const btnNext            = document.getElementById("btn-next");
const btnShuffle         = document.getElementById("btn-shuffle");
const volumeBar          = document.getElementById("volume-bar");
const volumeFill         = document.getElementById("volume-fill");
const searchBar          = document.getElementById("search-bar");
const songListEl         = document.getElementById("song-list");
const emptyState         = document.getElementById("empty-state");
const emptyMessage       = document.getElementById("empty-message");
const playerPanel        = document.querySelector(".player-panel");
const iconPlay           = btnPlay.querySelector(".icon-play");
const iconPause          = btnPlay.querySelector(".icon-pause");
const playerHeartBtn     = document.getElementById("player-heart-btn");
const favoritesFilterBtn = document.getElementById("favorites-filter-btn");
const favCountBadge      = document.getElementById("fav-count-badge");
const autoplayToggle     = document.getElementById("autoplay-toggle");

function formatTime(secs) {
  if (isNaN(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function init() {
  try {
    const res = await fetch(SONGS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    songs = await res.json();
  } catch (err) {
    console.error("Could not load songs.json:", err);
    songListEl.innerHTML = `
      <li style="padding:40px;text-align:center;color:#7a7568;letter-spacing:.08em;">
        ⚠ Could not load songs.json — check the file path and your links.
      </li>`;
    return;
  }

  loadFavorites();
  loadAutoplayPreference();
  loadShufflePreference();

  filteredSongs = [...songs];
  renderSongList(filteredSongs);
  updateFavCountBadge();

  const deepLinked = checkDeepLink();
  if (!deepLinked) restoreSession();

  setupMediaSession();
  bindFavoritesControls();
  bindAutoplayToggle();
  bindShuffleBtn();
  bindSwipeGestures();
}

function checkDeepLink() {
  const params  = new URLSearchParams(window.location.search);
  const trackId = params.get("track");
  if (!trackId) return false;

  const id  = parseInt(trackId, 10);
  if (isNaN(id)) return false;

  const catalogueIdx = songs.findIndex(s => Number(s.id) === id);
  if (catalogueIdx === -1) return false;

  const filteredIdx = filteredSongs.findIndex(s => Number(s.id) === id);
  if (filteredIdx === -1) {
    showFavoritesOnly = false;
    searchBar.value   = "";
    favoritesFilterBtn.classList.remove("active");
    favoritesFilterBtn.setAttribute("aria-pressed", "false");
    filteredSongs = [...songs];
    renderSongList(filteredSongs);
  }

  const resolvedIdx = filteredSongs.findIndex(s => Number(s.id) === id);
  if (resolvedIdx !== -1) {
    loadTrack(resolvedIdx, true);
    return true;
  }

  return false;
}

function loadShufflePreference() {
  const stored   = localStorage.getItem(LS_SHUFFLE_KEY);
  isShuffled     = stored === "true";
  btnShuffle.classList.toggle("active", isShuffled);
  btnShuffle.setAttribute("aria-pressed", isShuffled);
  if (isShuffled && filteredSongs.length > 0) buildShuffleQueue();
}

function fisherYatesShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildShuffleQueue() {
  const indices = filteredSongs.map((_, i) => i);
  fisherYatesShuffle(indices);

  if (currentIndex >= 0) {
    const pos = indices.indexOf(currentIndex);
    if (pos > 0) [indices[0], indices[pos]] = [indices[pos], indices[0]];
    shufflePos = 0;
  } else {
    shufflePos = -1;
  }

  shuffleQueue = indices;
}

function bindShuffleBtn() {
  btnShuffle.addEventListener("click", () => {
    isShuffled = !isShuffled;
    localStorage.setItem(LS_SHUFFLE_KEY, isShuffled);

    btnShuffle.classList.toggle("active", isShuffled);
    btnShuffle.setAttribute("aria-pressed", isShuffled);

    btnShuffle.classList.remove("shuffle-pop");
    void btnShuffle.offsetWidth;
    btnShuffle.classList.add("shuffle-pop");
    btnShuffle.addEventListener("animationend",
      () => btnShuffle.classList.remove("shuffle-pop"), { once: true });

    if (isShuffled) buildShuffleQueue();
  });
}

function cancelFade() {
  if (fadeRafId !== null) {
    cancelAnimationFrame(fadeRafId);
    fadeRafId = null;
  }
}

function reloadAndPlay() {
  const song = filteredSongs[currentIndex];
  if (!song) return;

  console.info(`[Sonata] Source stale or exhausted — reloading "${song.title}"`);

  cancelFade();
  audio.volume = 0;

  audio.src = song.src;
  audio.load();

  audio.addEventListener("canplay", () => {
    fadeIn();
  }, { once: true });
}

function fadeIn() {
  cancelFade();

  if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && !hasReloadAttempted) {
    hasReloadAttempted = true;
    reloadAndPlay();
    return;
  }

  audio.volume = 0;

  audio.play().catch(err => {
    console.warn("[Sonata] Playback blocked:", err);
    setPlayingState(false);
    audio.volume = userVolume;
  });

  const target    = userVolume;
  const startTime = performance.now();

  function tick(now) {
    const elapsed  = now - startTime;
    const progress = Math.min(elapsed / FADE_DURATION_MS, 1);
    audio.volume = Math.pow(progress, 2) * target;

    if (progress < 1) {
      fadeRafId = requestAnimationFrame(tick);
    } else {
      audio.volume = target;
      fadeRafId    = null;
    }
  }

  fadeRafId = requestAnimationFrame(tick);
}

function fadeOut(callback = null) {
  cancelFade();

  const startVol  = audio.volume > 0 ? audio.volume : userVolume;
  const startTime = performance.now();

  function tick(now) {
    const elapsed  = now - startTime;
    const progress = Math.min(elapsed / FADE_DURATION_MS, 1);
    audio.volume = startVol * Math.pow(1 - progress, 2);

    if (progress < 1) {
      fadeRafId = requestAnimationFrame(tick);
    } else {
      audio.volume = 0;
      fadeRafId    = null;
      audio.pause();
      audio.volume = userVolume;
      if (callback) callback();
    }
  }

  fadeRafId = requestAnimationFrame(tick);
}

function bindSwipeGestures() {
  let touchStartX = 0;
  let touchStartY = 0;
  let hintShown   = false;

  vinylStage.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;

    if (!hintShown) {
      hintShown = true;
      vinylStage.classList.add("show-hint");
      setTimeout(() => vinylStage.classList.remove("show-hint"), 1500);
    }
  }, { passive: true });

  vinylStage.addEventListener("touchend", (e) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;

    if (Math.abs(deltaY) > SWIPE_VERT_MAX) return;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD) return;

    const direction = deltaX < 0 ? "swipe-left" : "swipe-right";

    vinyl.classList.remove("swipe-left", "swipe-right");
    void vinyl.offsetWidth;
    vinyl.classList.add(direction);
    vinyl.addEventListener("animationend",
      () => vinyl.classList.remove("swipe-left", "swipe-right"),
      { once: true }
    );

    if (deltaX < 0) {
      nextTrack();
    } else {
      prevTrack();
    }
  }, { passive: true });
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(LS_FAVORITES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    favorites = new Set(Array.isArray(arr) ? arr : []);
  } catch { favorites = new Set(); }
}

function saveFavorites() {
  localStorage.setItem(LS_FAVORITES_KEY, JSON.stringify([...favorites]));
}

function toggleFavorite(songId, triggerPop = true) {
  const id      = Number(songId);
  const isAdding = !favorites.has(id);
  isAdding ? favorites.add(id) : favorites.delete(id);
  saveFavorites();
  updateAllHeartIcons(id, isAdding, triggerPop && isAdding);
  updateFavCountBadge();
  if (showFavoritesOnly) applyFilters();
}

function updateAllHeartIcons(songId, isFav, doPop = false) {
  const id          = Number(songId);
  const currentSong = filteredSongs[currentIndex];
  if (currentSong && Number(currentSong.id) === id) {
    setHeartState(playerHeartBtn, isFav, doPop);
    playerHeartBtn.setAttribute("aria-label",
      isFav ? "Remove from favorites" : "Add to favorites");
  }
  document.querySelectorAll(`.row-heart[data-song-id="${id}"]`)
    .forEach(btn => setHeartState(btn, isFav, doPop));
}

function setHeartState(btn, isFav, doPop = false) {
  btn.classList.toggle("is-favorite", isFav);
  if (doPop && isFav) {
    btn.classList.remove("heart-pop");
    void btn.offsetWidth;
    btn.classList.add("heart-pop");
    btn.addEventListener("animationend",
      () => btn.classList.remove("heart-pop"), { once: true });
  }
}

function updateFavCountBadge() {
  const count = favorites.size;
  favCountBadge.textContent = count;
  favCountBadge.setAttribute("data-count", count);
}

function bindFavoritesControls() {
  playerHeartBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const s = filteredSongs[currentIndex];
    if (!s) return;
    toggleFavorite(s.id, true);
  });

  favoritesFilterBtn.addEventListener("click", () => {
    showFavoritesOnly = !showFavoritesOnly;
    favoritesFilterBtn.classList.toggle("active", showFavoritesOnly);
    favoritesFilterBtn.setAttribute("aria-pressed", showFavoritesOnly);
    applyFilters();
  });
}

function loadAutoplayPreference() {
  const stored    = localStorage.getItem(LS_AUTOPLAY_KEY);
  autoplayEnabled = stored === null ? true : stored === "true";
  autoplayToggle.checked = autoplayEnabled;
}

function bindAutoplayToggle() {
  autoplayToggle.addEventListener("change", () => {
    autoplayEnabled = autoplayToggle.checked;
    localStorage.setItem(LS_AUTOPLAY_KEY, autoplayEnabled);
  });
}

function applyFilters() {
  const q = searchBar.value.trim().toLowerCase();
  let result = songs;
  if (showFavoritesOnly) result = result.filter(s => favorites.has(Number(s.id)));
  if (q) result = result.filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.artist.toLowerCase().includes(q) ||
    (s.album && s.album.toLowerCase().includes(q))
  );

  filteredSongs = result;
  currentIndex  = -1;
  renderSongList(filteredSongs);
  reAttachActiveAfterFilter();

  if (isShuffled) buildShuffleQueue();

  if (result.length === 0) {
    emptyMessage.textContent = showFavoritesOnly && !q
      ? "No liked tracks yet — tap ♡ to save one"
      : showFavoritesOnly && q
      ? "No liked tracks match your search"
      : "No tracks found";
  }
}

searchBar.addEventListener("input", applyFilters);

function renderSongList(list) {
  songListEl.innerHTML = "";
  emptyState.style.display = list.length === 0 ? "flex" : "none";

  list.forEach((song, idx) => {
    const isFav = favorites.has(Number(song.id));
    const li    = document.createElement("li");
    li.className = "song-item";
    li.setAttribute("role", "option");
    li.dataset.idx = idx;

    li.innerHTML = `
      <div class="song-num">
        <span class="num-text">${idx + 1}</span>
        <div class="bar-visual">
          <span></span><span></span><span></span><span></span>
        </div>
      </div>
      <div class="song-title-col">
        <span class="song-title-text">${escapeHTML(song.title)}</span>
        <span class="song-artist-text">${escapeHTML(song.artist)}</span>
      </div>
      <span class="song-album-text">${escapeHTML(song.album || "—")}</span>
      <div class="song-like-cell">
        <button class="heart-btn row-heart ${isFav ? "is-favorite" : ""}"
                data-song-id="${song.id}"
                aria-label="${isFav ? "Remove from favorites" : "Add to favorites"}"
                title="${isFav ? "Unlike" : "Like"}">
          <svg class="heart-icon heart-outline" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          <svg class="heart-icon heart-filled" viewBox="0 0 24 24"
               fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
      </div>
      <span class="song-duration-text">${escapeHTML(song.duration || "—")}</span>
    `;

    li.addEventListener("click", () => {
      if (currentIndex === idx && audio.src) {
        togglePlay();
      } else {
        loadTrack(idx, true);
      }
    });

    const rowHeart = li.querySelector(".row-heart");
    rowHeart.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(song.id, true);
      const nowFav = favorites.has(Number(song.id));
      rowHeart.setAttribute("aria-label", nowFav ? "Remove from favorites" : "Add to favorites");
      rowHeart.setAttribute("title",      nowFav ? "Unlike" : "Like");
    });

    songListEl.appendChild(li);
  });

  highlightActiveRow();
}

function loadTrack(idx, autoPlay = false) {
  if (idx < 0 || idx >= filteredSongs.length) return;

  cancelFade();
  audio.volume = userVolume;

  hasReloadAttempted = false;

  currentIndex = idx;
  const song   = filteredSongs[idx];

  audio.src = song.src;
  audio.load();

  trackTitle.textContent  = song.title;
  trackArtist.textContent = song.artist;
  trackAlbum.textContent  = song.album || "—";
  coverArt.src            = song.cover || FALLBACK_ART;

  progressFill.style.width = "0%";
  seekBar.value            = 0;
  timeCurrent.textContent  = "0:00";
  timeTotal.textContent    = song.duration || "0:00";

  localStorage.setItem(LS_SONG_KEY, findOriginalIndex(song));

  playerHeartBtn.classList.add("visible");
  const isFav = favorites.has(Number(song.id));
  setHeartState(playerHeartBtn, isFav, false);
  playerHeartBtn.setAttribute("aria-label",
    isFav ? "Remove from favorites" : "Add to favorites");

  if (isShuffled) {
    const posInQueue = shuffleQueue.indexOf(idx);
    if (posInQueue !== -1) shufflePos = posInQueue;
  }

  highlightActiveRow();
  updateMediaSession(song);

  if (autoPlay) {
    // ─ FIX: Wait for the browser to buffer before attempting playback.
    // Calling fadeIn() directly after audio.load() means readyState=0
    // (HAVE_NOTHING), which caused the guard inside fadeIn() to fire
    // reloadAndPlay() on every track switch — wasteful and caused a
    // duplicate network request. canplay fires once the browser has
    // enough data to start; only then do we ramp volume and call play().
    //
    // updateMediaSession(song) is already called above this block,
    // so lock-screen / Siri metadata is updated before playback begins.
    //
    // { once: true } auto-removes the handler if the user skips again
    // before this track finishes buffering, so no stale listeners pile up.
    audio.addEventListener("canplay", () => {
      // Guard: if the user skipped to another track while we were
      // buffering, currentIndex no longer matches idx — abort silently.
      if (currentIndex !== idx) return;
      fadeIn();
    }, { once: true });
  } else {
    setPlayingState(false);
  }
}

function findOriginalIndex(song) {
  return songs.findIndex(s => s.id === song.id);
}

function togglePlay() {
  if (!audio.src || currentIndex === -1) {
    if (filteredSongs.length > 0) loadTrack(0, true);
    return;
  }

  if (isPlaying) {
    fadeOut();
  } else {
    fadeIn();
  }
}

function setPlayingState(playing) {
  isPlaying = playing;
  iconPlay.style.display  = playing ? "none"  : "block";
  iconPause.style.display = playing ? "block" : "none";

  if (playing) {
    vinyl.classList.add("spinning");
    vinyl.classList.remove("paused");
    playerPanel.classList.add("playing");
  } else {
    vinyl.classList.add("paused");
    vinyl.classList.remove("spinning");
    playerPanel.classList.remove("playing");
  }

  const activeEl = songListEl.querySelector(".song-item.active");
  if (activeEl) activeEl.classList.toggle("paused-indicator", !playing);
}

function prevTrack() {
  if (filteredSongs.length === 0) return;

  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }

  if (isShuffled && shuffleQueue.length > 0) {
    shufflePos = shufflePos <= 0 ? shuffleQueue.length - 1 : shufflePos - 1;
    loadTrack(shuffleQueue[shufflePos], isPlaying);
  } else {
    loadTrack(currentIndex <= 0 ? filteredSongs.length - 1 : currentIndex - 1, isPlaying);
  }
}

function nextTrack(forcePlay = false) {
  if (filteredSongs.length === 0) return;

  // forcePlay=true when called from ended handler (isPlaying is already false by then)
  const shouldPlay = forcePlay || isPlaying;

  if (isShuffled && shuffleQueue.length > 0) {
    shufflePos++;
    if (shufflePos >= shuffleQueue.length) {
      buildShuffleQueue();
      shufflePos = 0;
    }
    loadTrack(shuffleQueue[shufflePos], shouldPlay);
  } else {
    loadTrack((currentIndex + 1) % filteredSongs.length, shouldPlay);
  }
}

audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  progressFill.style.width = `${pct}%`;
  seekBar.value            = pct;
  timeCurrent.textContent  = formatTime(audio.currentTime);
});

audio.addEventListener("loadedmetadata", () => {
  timeTotal.textContent = formatTime(audio.duration);
});

seekBar.addEventListener("input", () => {
  if (!audio.duration) return;
  audio.currentTime = (seekBar.value / 100) * audio.duration;
});

audio.addEventListener("play",  () => setPlayingState(true));
audio.addEventListener("pause", () => setPlayingState(false));

audio.addEventListener("ended", () => {
  if (autoplayEnabled) {
    // ─ FIX: pass forcePlay=true.
    // The browser fires 'pause' before 'ended' on natural track end,
    // which sets isPlaying=false before we ever reach here.
    // nextTrack() was therefore calling loadTrack(idx, false) — next
    // song loaded but never played. Passing true bypasses the stale flag.
    nextTrack(true);
  } else {
    setPlayingState(false);
    progressFill.style.width = "100%";
  }
});

audio.addEventListener("error", () => {
  const err  = audio.error;
  const code = err ? err.code : 0;

  if (code === MediaError.MEDIA_ERR_ABORTED) return;

  console.warn(`[Sonata] Audio error — code ${code}:`, err ? err.message : "unknown");

  if (code === MediaError.MEDIA_ERR_NETWORK && !hasReloadAttempted) {
    hasReloadAttempted = true;
    console.info("[Sonata] Network error detected — attempting one automatic reload");
    reloadAndPlay();
    return;
  }

  console.error("[Sonata] Unrecoverable audio error — giving up");
  setPlayingState(false);
  cancelFade();
  audio.volume = userVolume;
  trackTitle.textContent = "⚠ Could not load track";
});

btnPlay.addEventListener("click", togglePlay);
btnPrev.addEventListener("click", prevTrack);
btnNext.addEventListener("click", nextTrack);

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  switch (e.code) {
    case "Space":      e.preventDefault(); togglePlay();  break;
    case "ArrowRight": e.preventDefault(); audio.currentTime = Math.min(audio.currentTime + 10, audio.duration || 0); break;
    case "ArrowLeft":  e.preventDefault(); audio.currentTime = Math.max(audio.currentTime - 10, 0); break;
    case "ArrowUp":    e.preventDefault(); setVolume(userVolume + 0.1); break;
    case "ArrowDown":  e.preventDefault(); setVolume(userVolume - 0.1); break;
    case "KeyN":       nextTrack();        break;
    case "KeyP":       prevTrack();        break;
    case "KeyS":       btnShuffle.click(); break;
    case "KeyL":
      if (filteredSongs[currentIndex]) toggleFavorite(filteredSongs[currentIndex].id, true);
      break;
  }
});

function setVolume(val) {
  const v  = clamp(parseFloat(val), 0, 1);
  userVolume = v;
  if (fadeRafId === null) audio.volume = v;
  volumeFill.style.width = `${v * 100}%`;
  volumeBar.value = v;
  localStorage.setItem(LS_VOL_KEY, v);
}

volumeBar.addEventListener("input", () => setVolume(volumeBar.value));

function highlightActiveRow() {
  document.querySelectorAll(".song-item").forEach(el =>
    el.classList.remove("active", "paused-indicator"));
  if (currentIndex < 0) return;
  const rows   = songListEl.querySelectorAll(".song-item");
  const target = rows[currentIndex];
  if (target) {
    target.classList.add("active");
    if (!isPlaying) target.classList.add("paused-indicator");
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function reAttachActiveAfterFilter() {
  if (!audio.src) return;
  const savedOrigIdx = parseInt(localStorage.getItem(LS_SONG_KEY) || "-1");
  if (savedOrigIdx < 0 || savedOrigIdx >= songs.length) return;
  const playingSong = songs[savedOrigIdx];
  if (!playingSong) return;
  const newIdx = filteredSongs.findIndex(s => s.id === playingSong.id);
  if (newIdx !== -1) {
    currentIndex = newIdx;
    highlightActiveRow();
  }
}

function restoreSession() {
  const savedVol = localStorage.getItem(LS_VOL_KEY);
  setVolume(savedVol !== null ? parseFloat(savedVol) : 0.8);

  const savedIdx = parseInt(localStorage.getItem(LS_SONG_KEY) || "-1");
  if (savedIdx >= 0 && savedIdx < songs.length) {
    const song        = songs[savedIdx];
    const filteredIdx = filteredSongs.findIndex(s => s.id === song.id);
    if (filteredIdx !== -1) loadTrack(filteredIdx, false);
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.setActionHandler("play",          () => { if (!isPlaying) fadeIn(); });
  navigator.mediaSession.setActionHandler("pause",         () => { if (isPlaying)  fadeOut(); });
  navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
  navigator.mediaSession.setActionHandler("nexttrack",     nextTrack);
  navigator.mediaSession.setActionHandler("seekto",        (d) => {
    if (d.seekTime !== undefined) audio.currentTime = d.seekTime;
  });
  navigator.mediaSession.setActionHandler("seekbackward",  (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
  });
  navigator.mediaSession.setActionHandler("seekforward",   (d) => {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10));
  });

  audio.addEventListener("timeupdate", updatePositionState);
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title:   song.title,
    artist:  song.artist,
    album:   song.album || "",
    artwork: song.cover
      ? [
          { src: song.cover, sizes: "512x512", type: "image/jpeg" },
          { src: song.cover, sizes: "256x256", type: "image/jpeg" },
          { src: song.cover, sizes: "128x128", type: "image/jpeg" },
        ]
      : [],
  });
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !audio.duration || isNaN(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration:     audio.duration,
      playbackRate: audio.playbackRate,
      position:     audio.currentTime,
    });
  } catch (_) {}
}

init();
