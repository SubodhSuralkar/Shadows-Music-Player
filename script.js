/**
 * SONATA — Music Player  v2
 * ─────────────────────────────────────────────────────────────────
 * New in v2:
 *   • Favorites system  — heart icons, localStorage, filter pill
 *   • Autoplay toggle   — pill switch, localStorage persistence
 *
 * localStorage keys used:
 *   sonata_last_song   → number  (original-catalogue index of last played song)
 *   sonata_volume      → number  (0–1)
 *   sonata_favorites   → JSON array of song IDs  (e.g. [1, 4, 7])
 *   sonata_autoplay    → "true" | "false"
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

// ═══════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════

const SONGS_URL        = "songs.json";
const LS_SONG_KEY      = "sonata_last_song";
const LS_VOL_KEY       = "sonata_volume";
const LS_FAVORITES_KEY = "sonata_favorites";   // NEW
const LS_AUTOPLAY_KEY  = "sonata_autoplay";    // NEW
const FALLBACK_ART     = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='512' height='512'%3E%3Crect width='512' height='512' fill='%23111'/%3E%3Ccircle cx='256' cy='256' r='80' fill='%23222'/%3E%3C/svg%3E";

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════

let songs             = [];      // full catalogue from songs.json
let filteredSongs     = [];      // currently displayed (search + favorites filter)
let currentIndex      = -1;      // index within filteredSongs
let isPlaying         = false;

/**
 * favorites — a Set of song IDs (numbers).
 * Stored in localStorage as a JSON array; hydrated on init.
 * Using a Set gives O(1) has/add/delete operations.
 */
let favorites         = new Set();   // NEW

/**
 * showFavoritesOnly — boolean.
 * When true, the library shows only songs whose ID is in favorites.
 * Applies on top of any active text search (AND logic).
 */
let showFavoritesOnly = false;       // NEW

/**
 * autoplayEnabled — boolean.
 * When true, audio.ended triggers nextTrack().
 * When false, audio.ended stops playback.
 */
let autoplayEnabled   = true;        // NEW (default ON)

// ═══════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════

const audio             = document.getElementById("audio-player");
const vinyl             = document.getElementById("vinyl");
const coverArt          = document.getElementById("cover-art");
const trackTitle        = document.getElementById("track-title");
const trackArtist       = document.getElementById("track-artist");
const trackAlbum        = document.getElementById("track-album");
const progressFill      = document.getElementById("progress-fill");
const seekBar           = document.getElementById("seek-bar");
const timeCurrent       = document.getElementById("time-current");
const timeTotal         = document.getElementById("time-total");
const btnPlay           = document.getElementById("btn-play");
const btnPrev           = document.getElementById("btn-prev");
const btnNext           = document.getElementById("btn-next");
const volumeBar         = document.getElementById("volume-bar");
const volumeFill        = document.getElementById("volume-fill");
const searchBar         = document.getElementById("search-bar");
const songListEl        = document.getElementById("song-list");
const emptyState        = document.getElementById("empty-state");
const emptyMessage      = document.getElementById("empty-message");
const playerPanel       = document.querySelector(".player-panel");
const iconPlay          = btnPlay.querySelector(".icon-play");
const iconPause         = btnPlay.querySelector(".icon-pause");

// NEW refs
const playerHeartBtn    = document.getElementById("player-heart-btn");
const favoritesFilterBtn = document.getElementById("favorites-filter-btn");
const favCountBadge     = document.getElementById("fav-count-badge");
const autoplayToggle    = document.getElementById("autoplay-toggle");

// ═══════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════

function formatTime(secs) {
  if (isNaN(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════

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

  // Hydrate persisted state BEFORE first render
  loadFavorites();
  loadAutoplayPreference();

  filteredSongs = [...songs];
  renderSongList(filteredSongs);
  updateFavCountBadge();
  restoreSession();
  setupMediaSession();
  bindFavoritesControls();
  bindAutoplayToggle();
}

// ═══════════════════════════════════════════
//  ─── FAVORITES SYSTEM ───────────────────
// ═══════════════════════════════════════════

/**
 * Hydrate the favorites Set from localStorage on page load.
 * Falls back to an empty Set if nothing is stored or JSON is invalid.
 */
function loadFavorites() {
  try {
    const raw = localStorage.getItem(LS_FAVORITES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    favorites = new Set(Array.isArray(arr) ? arr : []);
  } catch {
    favorites = new Set();
  }
}

/**
 * Persist the favorites Set to localStorage as a JSON array.
 * Called every time favorites changes.
 */
function saveFavorites() {
  localStorage.setItem(LS_FAVORITES_KEY, JSON.stringify([...favorites]));
}

/**
 * Toggle a song's favorite state.
 * Updates the Set, persists to localStorage, refreshes all hearts in the UI,
 * and updates the count badge.
 *
 * @param {number|string} songId  — the song's id field from songs.json
 * @param {boolean} triggerPop   — whether to fire the pop animation (true when
 *                                  called from a user click, false on init refresh)
 */
function toggleFavorite(songId, triggerPop = true) {
  const id = Number(songId);
  const isAdding = !favorites.has(id);

  if (isAdding) {
    favorites.add(id);
  } else {
    favorites.delete(id);
  }

  saveFavorites();
  updateAllHeartIcons(id, isAdding, triggerPop && isAdding);
  updateFavCountBadge();

  // If "Liked" filter is active and we just un-liked this song,
  // re-apply filters so the song disappears from the list.
  if (showFavoritesOnly) {
    applyFilters();
  }
}

/**
 * Update every heart icon in the UI that corresponds to a given songId.
 * This covers both the player-panel heart and any row hearts.
 * Called from toggleFavorite() to keep everything in sync atomically.
 *
 * @param {number}  songId
 * @param {boolean} isFav      — new state (true = favorited)
 * @param {boolean} doPop      — play burst animation on the filled heart
 */
function updateAllHeartIcons(songId, isFav, doPop = false) {
  const id = Number(songId);

  // ── Player heart ────────────────────────
  const currentSong = filteredSongs[currentIndex];
  if (currentSong && Number(currentSong.id) === id) {
    setHeartState(playerHeartBtn, isFav, doPop);
    playerHeartBtn.setAttribute(
      "aria-label",
      isFav ? "Remove from favorites" : "Add to favorites"
    );
  }

  // ── Row hearts ──────────────────────────
  // querySelectorAll finds all row hearts with the matching data-song-id
  document.querySelectorAll(`.row-heart[data-song-id="${id}"]`).forEach(btn => {
    setHeartState(btn, isFav, doPop);
  });
}

/**
 * Apply .is-favorite and optionally .heart-pop to a heart button.
 * The pop animation class is removed automatically on animationend.
 *
 * @param {HTMLElement} btn
 * @param {boolean}     isFav
 * @param {boolean}     doPop
 */
function setHeartState(btn, isFav, doPop = false) {
  btn.classList.toggle("is-favorite", isFav);

  if (doPop && isFav) {
    // Remove first in case animation is still running from a rapid double-click
    btn.classList.remove("heart-pop");
    // Force reflow so removing+re-adding actually restarts the animation
    void btn.offsetWidth;
    btn.classList.add("heart-pop");
    btn.addEventListener(
      "animationend",
      () => btn.classList.remove("heart-pop"),
      { once: true }
    );
  }
}

/**
 * Refresh ALL heart icons in the current rendered list to match favorites state.
 * Called after renderSongList() so rows always show correct initial state.
 */
function syncAllHeartStates() {
  filteredSongs.forEach(song => {
    const isFav = favorites.has(Number(song.id));
    document.querySelectorAll(`.row-heart[data-song-id="${song.id}"]`)
      .forEach(btn => setHeartState(btn, isFav, false));
  });

  // Also sync player heart
  const currentSong = filteredSongs[currentIndex];
  if (currentSong) {
    const isFav = favorites.has(Number(currentSong.id));
    setHeartState(playerHeartBtn, isFav, false);
  }
}

/**
 * Update the numeric badge on the "Liked" filter button.
 */
function updateFavCountBadge() {
  const count = favorites.size;
  favCountBadge.textContent = count;
  favCountBadge.setAttribute("data-count", count);
}

/**
 * Wire up the player-panel heart button and the favorites filter pill.
 */
function bindFavoritesControls() {
  // Player heart — toggles favorite for the currently playing song
  playerHeartBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const currentSong = filteredSongs[currentIndex];
    if (!currentSong) return;
    toggleFavorite(currentSong.id, true);
  });

  // Favorites filter pill — toggles showFavoritesOnly
  favoritesFilterBtn.addEventListener("click", () => {
    showFavoritesOnly = !showFavoritesOnly;
    favoritesFilterBtn.classList.toggle("active", showFavoritesOnly);
    favoritesFilterBtn.setAttribute("aria-pressed", showFavoritesOnly);
    applyFilters();
  });
}

// ═══════════════════════════════════════════
//  ─── AUTOPLAY TOGGLE ────────────────────
// ═══════════════════════════════════════════

/**
 * Read persisted autoplay preference.
 * Default is ON (true) if nothing is stored yet.
 */
function loadAutoplayPreference() {
  const stored = localStorage.getItem(LS_AUTOPLAY_KEY);
  // stored is "true", "false", or null (first visit)
  autoplayEnabled = stored === null ? true : stored === "true";
  autoplayToggle.checked = autoplayEnabled;
}

/**
 * Persist autoplay preference and update state.
 */
function saveAutoplayPreference(value) {
  autoplayEnabled = value;
  localStorage.setItem(LS_AUTOPLAY_KEY, value);
}

/**
 * Wire the toggle checkbox.
 * 'change' fires when the user clicks the pill switch.
 */
function bindAutoplayToggle() {
  autoplayToggle.addEventListener("change", () => {
    saveAutoplayPreference(autoplayToggle.checked);
  });
}

// ═══════════════════════════════════════════
//  SEARCH & FILTER (unified)
// ═══════════════════════════════════════════

/**
 * Single source of truth for which songs are visible.
 * Applies text search AND favorites filter simultaneously (AND logic):
 *   — if showFavoritesOnly is true, only liked songs pass through
 *   — then the text query further narrows that result
 *
 * This replaces the old "two separate filter paths" approach.
 */
function applyFilters() {
  const q = searchBar.value.trim().toLowerCase();

  let result = songs;

  // 1. Favorites filter
  if (showFavoritesOnly) {
    result = result.filter(s => favorites.has(Number(s.id)));
  }

  // 2. Text search
  if (q) {
    result = result.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      (s.album && s.album.toLowerCase().includes(q))
    );
  }

  filteredSongs = result;

  // Reset active index — the currently playing song may or may not be in view
  currentIndex = -1;
  renderSongList(filteredSongs);
  reAttachActiveAfterFilter();

  // Contextual empty state message
  if (result.length === 0) {
    if (showFavoritesOnly && !q) {
      emptyMessage.textContent = "No liked tracks yet — tap ♡ to save one";
    } else if (showFavoritesOnly && q) {
      emptyMessage.textContent = "No liked tracks match your search";
    } else {
      emptyMessage.textContent = "No tracks found";
    }
  }
}

searchBar.addEventListener("input", applyFilters);

// ═══════════════════════════════════════════
//  RENDER SONG LIST
// ═══════════════════════════════════════════

function renderSongList(list) {
  songListEl.innerHTML = "";
  emptyState.style.display = list.length === 0 ? "flex" : "none";

  list.forEach((song, idx) => {
    const isFav = favorites.has(Number(song.id));
    const li = document.createElement("li");
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
        <!--
          ROW HEART BUTTON
          data-song-id links it to the song for updateAllHeartIcons()
          stopPropagation prevents the click from also triggering loadTrack()
        -->
        <button
          class="heart-btn row-heart ${isFav ? "is-favorite" : ""}"
          data-song-id="${song.id}"
          aria-label="${isFav ? "Remove from favorites" : "Add to favorites"}"
          title="${isFav ? "Unlike" : "Like"}"
        >
          <svg class="heart-icon heart-outline" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06
                     a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78
                     1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          <svg class="heart-icon heart-filled" viewBox="0 0 24 24"
               fill="currentColor" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06
                     a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78
                     1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
      </div>

      <span class="song-duration-text">${escapeHTML(song.duration || "—")}</span>
    `;

    // ── Row click: play the song ──────────────────
    li.addEventListener("click", () => {
      if (currentIndex === idx && audio.src) {
        togglePlay();
      } else {
        loadTrack(idx, true);
      }
    });

    // ── Row heart click: toggle favorite ─────────
    const rowHeart = li.querySelector(".row-heart");
    rowHeart.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger row click → loadTrack
      toggleFavorite(song.id, true);
      // Update aria-label on this specific button
      const nowFav = favorites.has(Number(song.id));
      rowHeart.setAttribute("aria-label", nowFav ? "Remove from favorites" : "Add to favorites");
      rowHeart.setAttribute("title", nowFav ? "Unlike" : "Like");
    });

    songListEl.appendChild(li);
  });

  highlightActiveRow();
}

// ═══════════════════════════════════════════
//  LOAD & PLAY A TRACK
// ═══════════════════════════════════════════

function loadTrack(idx, autoPlay = false) {
  if (idx < 0 || idx >= filteredSongs.length) return;

  currentIndex = idx;
  const song   = filteredSongs[idx];

  audio.src = song.src;
  audio.load();

  // Update player panel info
  trackTitle.textContent  = song.title;
  trackArtist.textContent = song.artist;
  trackAlbum.textContent  = song.album || "—";
  coverArt.src            = song.cover || FALLBACK_ART;

  // Reset progress
  progressFill.style.width = "0%";
  seekBar.value            = 0;
  timeCurrent.textContent  = "0:00";
  timeTotal.textContent    = song.duration || "0:00";

  // Persist last-played song (original-catalogue index)
  localStorage.setItem(LS_SONG_KEY, findOriginalIndex(song));

  // Show player heart and set correct state for this song
  playerHeartBtn.classList.add("visible");
  const isFav = favorites.has(Number(song.id));
  setHeartState(playerHeartBtn, isFav, false);
  playerHeartBtn.setAttribute(
    "aria-label",
    isFav ? "Remove from favorites" : "Add to favorites"
  );

  highlightActiveRow();
  updateMediaSession(song);

  if (autoPlay) {
    audio.play()
      .then(() => setPlayingState(true))
      .catch(err => { console.warn("Playback blocked:", err); setPlayingState(false); });
  } else {
    setPlayingState(false);
  }
}

function findOriginalIndex(song) {
  return songs.findIndex(s => s.id === song.id);
}

// ═══════════════════════════════════════════
//  PLAY / PAUSE
// ═══════════════════════════════════════════

function togglePlay() {
  if (!audio.src || currentIndex === -1) {
    if (filteredSongs.length > 0) loadTrack(0, true);
    return;
  }
  if (isPlaying) {
    audio.pause();
  } else {
    audio.play().catch(err => console.warn("Playback error:", err));
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
  if (activeEl) {
    activeEl.classList.toggle("paused-indicator", !playing);
  }
}

// ═══════════════════════════════════════════
//  SKIP
// ═══════════════════════════════════════════

function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const newIdx = currentIndex <= 0 ? filteredSongs.length - 1 : currentIndex - 1;
  loadTrack(newIdx, isPlaying);
}

function nextTrack() {
  const newIdx = (currentIndex + 1) % filteredSongs.length;
  loadTrack(newIdx, isPlaying);
}

// ═══════════════════════════════════════════
//  AUDIO EVENTS
// ═══════════════════════════════════════════

audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  progressFill.style.width = `${pct}%`;
  seekBar.value = pct;
  timeCurrent.textContent = formatTime(audio.currentTime);
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

/**
 * AUTOPLAY LOGIC
 * ─────────────────────────────────────────
 * This is the core of the autoplay feature.
 * The 'ended' event fires naturally when a track finishes.
 *
 * Decision tree:
 *   autoplayEnabled = true  → nextTrack() continues playback seamlessly
 *   autoplayEnabled = false → stop: reset vinyl, update UI to paused state
 */
audio.addEventListener("ended", () => {
  if (autoplayEnabled) {
    nextTrack();
  } else {
    // Stop cleanly — do NOT load a new track, just reflect stopped state
    setPlayingState(false);
    progressFill.style.width = "100%"; // keep progress bar full so user sees it finished
  }
});

audio.addEventListener("error", () => {
  console.error("Audio failed to load:", audio.src);
  setPlayingState(false);
  trackTitle.textContent = "⚠ Could not load track";
});

// ═══════════════════════════════════════════
//  CONTROLS
// ═══════════════════════════════════════════

btnPlay.addEventListener("click", togglePlay);
btnPrev.addEventListener("click", prevTrack);
btnNext.addEventListener("click", nextTrack);

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  switch (e.code) {
    case "Space":      e.preventDefault(); togglePlay(); break;
    case "ArrowRight": e.preventDefault(); audio.currentTime = Math.min(audio.currentTime + 10, audio.duration || 0); break;
    case "ArrowLeft":  e.preventDefault(); audio.currentTime = Math.max(audio.currentTime - 10, 0); break;
    case "ArrowUp":    e.preventDefault(); setVolume(audio.volume + 0.1); break;
    case "ArrowDown":  e.preventDefault(); setVolume(audio.volume - 0.1); break;
    case "KeyN":       nextTrack(); break;
    case "KeyP":       prevTrack(); break;
    case "KeyL":       // NEW: L = Like/Unlike current song
      if (filteredSongs[currentIndex]) toggleFavorite(filteredSongs[currentIndex].id, true);
      break;
  }
});

// ═══════════════════════════════════════════
//  VOLUME
// ═══════════════════════════════════════════

function setVolume(val) {
  const v = clamp(parseFloat(val), 0, 1);
  audio.volume = v;
  volumeFill.style.width = `${v * 100}%`;
  volumeBar.value = v;
  localStorage.setItem(LS_VOL_KEY, v);
}
volumeBar.addEventListener("input", () => setVolume(volumeBar.value));

// ═══════════════════════════════════════════
//  HIGHLIGHT ACTIVE ROW
// ═══════════════════════════════════════════

function highlightActiveRow() {
  document.querySelectorAll(".song-item").forEach(el => {
    el.classList.remove("active", "paused-indicator");
  });
  if (currentIndex < 0) return;

  const rows   = songListEl.querySelectorAll(".song-item");
  const target = rows[currentIndex];
  if (target) {
    target.classList.add("active");
    if (!isPlaying) target.classList.add("paused-indicator");
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

/**
 * After applyFilters() re-renders the list, find out if the currently
 * playing song survived the filter and, if so, re-set currentIndex so
 * prev/next/highlight all work correctly.
 */
function reAttachActiveAfterFilter() {
  if (!audio.src) return;
  const savedOrigIdx = parseInt(localStorage.getItem(LS_SONG_KEY) || "-1");
  if (savedOrigIdx < 0) return;
  const playingSong  = songs[savedOrigIdx];
  if (!playingSong) return;

  const newIdx = filteredSongs.findIndex(s => s.id === playingSong.id);
  if (newIdx !== -1) {
    currentIndex = newIdx;
    highlightActiveRow();
  }
}

// ═══════════════════════════════════════════
//  RESTORE SESSION
// ═══════════════════════════════════════════

function restoreSession() {
  // Volume
  const savedVol = localStorage.getItem(LS_VOL_KEY);
  setVolume(savedVol !== null ? parseFloat(savedVol) : 0.8);

  // Last played song (load metadata, don't autoplay)
  const savedIdx = parseInt(localStorage.getItem(LS_SONG_KEY) || "-1");
  if (savedIdx >= 0 && savedIdx < songs.length) {
    const song       = songs[savedIdx];
    const filteredIdx = filteredSongs.findIndex(s => s.id === song.id);
    if (filteredIdx !== -1) {
      loadTrack(filteredIdx, false);
    }
  }
}

// ═══════════════════════════════════════════
//  MEDIA SESSION API
// ═══════════════════════════════════════════

function setupMediaSession() {
  if (!("mediaSession" in navigator)) {
    console.info("mediaSession API not supported.");
    return;
  }
  navigator.mediaSession.setActionHandler("play",          () => audio.play());
  navigator.mediaSession.setActionHandler("pause",         () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
  navigator.mediaSession.setActionHandler("nexttrack",     nextTrack);
  navigator.mediaSession.setActionHandler("seekto", (d) => {
    if (d.seekTime !== undefined) audio.currentTime = d.seekTime;
  });
  navigator.mediaSession.setActionHandler("seekbackward", (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
  });
  navigator.mediaSession.setActionHandler("seekforward", (d) => {
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
  } catch (_) { /* silently ignore — some browsers don't support setPositionState */ }
}

// ═══════════════════════════════════════════
//  GO
// ═══════════════════════════════════════════

init();
