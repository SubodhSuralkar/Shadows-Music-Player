/**
 * SONATA — Music Player  v3
 * ─────────────────────────────────────────────────────────────────
 * New in v3:
 *   • Swipe gestures   — touch left/right on vinyl to skip tracks
 *   • True shuffle     — Fisher-Yates queue, persisted to localStorage
 *   • Deep linking     — ?track=ID auto-loads & plays on page open
 *   • Volume fade      — 2s rAF fade-in / fade-out on play/pause
 *
 * localStorage keys:
 *   sonata_last_song   → number   (original-catalogue index)
 *   sonata_volume      → number   (0–1, user's preferred volume)
 *   sonata_favorites   → JSON number[]
 *   sonata_autoplay    → "true"|"false"
 *   sonata_shuffle     → "true"|"false"    NEW
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

// ═══════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════

const SONGS_URL        = "songs.json";
const LS_SONG_KEY      = "sonata_last_song";
const LS_VOL_KEY       = "sonata_volume";
const LS_FAVORITES_KEY = "sonata_favorites";
const LS_AUTOPLAY_KEY  = "sonata_autoplay";
const LS_SHUFFLE_KEY   = "sonata_shuffle";   // NEW

const FADE_DURATION_MS = 2000;   // fade in/out duration
const SWIPE_THRESHOLD  = 50;     // px — minimum horizontal swipe distance
const SWIPE_VERT_MAX   = 75;     // px — maximum vertical drift before swipe is ignored

const FALLBACK_ART = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='512' height='512'%3E%3Crect width='512' height='512' fill='%23111'/%3E%3Ccircle cx='256' cy='256' r='80' fill='%23222'/%3E%3C/svg%3E";

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════

let songs             = [];
let filteredSongs     = [];
let currentIndex      = -1;
let isPlaying         = false;

let favorites         = new Set();
let showFavoritesOnly = false;
let autoplayEnabled   = true;

// ── Shuffle state ──────────────────────────────────────────────────
let isShuffled    = false;
/**
 * shuffleQueue: array of filteredSongs indices in Fisher-Yates order.
 * Example: [3, 0, 5, 1, 4, 2]  (indices into filteredSongs)
 */
let shuffleQueue  = [];
/**
 * shufflePos: our current position in shuffleQueue.
 * nextTrack advances it; prevTrack retreats it.
 */
let shufflePos    = -1;

// ── Volume fade state ─────────────────────────────────────────────
/**
 * userVolume: the volume the user has chosen with the slider.
 * audio.volume is allowed to differ temporarily during fades.
 * setVolume() always updates userVolume; fade functions target it.
 */
let userVolume    = 0.8;
/**
 * fadeRafId: the requestAnimationFrame id for any in-progress fade.
 * cancelFade() uses this to abort cleanly.
 */
let fadeRafId     = null;

// ═══════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════

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

  // Hydrate all persisted preferences before first render
  loadFavorites();
  loadAutoplayPreference();
  loadShufflePreference();

  filteredSongs = [...songs];
  renderSongList(filteredSongs);
  updateFavCountBadge();

  // Deep link takes priority over session restore
  const deepLinked = checkDeepLink();
  if (!deepLinked) restoreSession();

  setupMediaSession();
  bindFavoritesControls();
  bindAutoplayToggle();
  bindShuffleBtn();
  bindSwipeGestures();
}

// ═══════════════════════════════════════════
//  ─── FEATURE 3: DEEP LINKING ────────────
// ═══════════════════════════════════════════

/**
 * Checks the URL for a ?track=ID parameter.
 * If found, loads and autoplays that track, bypassing session restore.
 *
 * Usage:  https://yoursite.vercel.app/?track=3
 *   → finds the song with id === 3 and plays it immediately.
 *
 * @returns {boolean}  true if a valid deep link was found and acted on.
 */
function checkDeepLink() {
  const params  = new URLSearchParams(window.location.search);
  const trackId = params.get("track");
  if (!trackId) return false;

  const id  = parseInt(trackId, 10);
  if (isNaN(id)) {
    console.warn(`Deep link: invalid track id "${trackId}"`);
    return false;
  }

  // Search across the full catalogue, not just filteredSongs,
  // so the deep link works even when a search or favorites filter is active.
  const catalogueIdx = songs.findIndex(s => Number(s.id) === id);
  if (catalogueIdx === -1) {
    console.warn(`Deep link: no song with id=${id} found in catalogue`);
    return false;
  }

  // Ensure filteredSongs contains this track.
  // If it's currently hidden by search/favorites, reset filters first.
  const filteredIdx = filteredSongs.findIndex(s => Number(s.id) === id);
  if (filteredIdx === -1) {
    // Clear any active filters so the song is visible
    showFavoritesOnly = false;
    searchBar.value   = "";
    favoritesFilterBtn.classList.remove("active");
    favoritesFilterBtn.setAttribute("aria-pressed", "false");
    filteredSongs = [...songs];
    renderSongList(filteredSongs);
  }

  const resolvedIdx = filteredSongs.findIndex(s => Number(s.id) === id);
  if (resolvedIdx !== -1) {
    loadTrack(resolvedIdx, true);  // autoplay = true
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════
//  ─── FEATURE 2: SHUFFLE (Fisher-Yates) ──
// ═══════════════════════════════════════════

function loadShufflePreference() {
  const stored   = localStorage.getItem(LS_SHUFFLE_KEY);
  isShuffled     = stored === "true";
  btnShuffle.classList.toggle("active", isShuffled);
  btnShuffle.setAttribute("aria-pressed", isShuffled);
  if (isShuffled && filteredSongs.length > 0) buildShuffleQueue();
}

/**
 * Fisher-Yates shuffle of an array (in-place).
 * Guaranteed uniform distribution — every permutation equally likely.
 * Time complexity: O(n).
 *
 * @param {any[]} arr  Array to shuffle in-place.
 * @returns {any[]}    The same array, now shuffled.
 */
function fisherYatesShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // Destructured swap — no temp variable needed
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build a new shuffleQueue from the current filteredSongs indices.
 *
 * Strategy: if a song is currently playing, move it to position 0
 * so it sits at the "start" of history. The next call to nextTrack()
 * will advance to position 1 (the first truly random song).
 * This avoids the common UX annoyance of replaying the current song
 * immediately after toggling shuffle.
 */
function buildShuffleQueue() {
  const indices = filteredSongs.map((_, i) => i);
  fisherYatesShuffle(indices);

  if (currentIndex >= 0) {
    // Move currentIndex to front so history navigation makes sense
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

    // Pop animation
    btnShuffle.classList.remove("shuffle-pop");
    void btnShuffle.offsetWidth;  // force reflow to restart animation
    btnShuffle.classList.add("shuffle-pop");
    btnShuffle.addEventListener("animationend",
      () => btnShuffle.classList.remove("shuffle-pop"), { once: true });

    if (isShuffled) buildShuffleQueue();
  });
}

// ═══════════════════════════════════════════
//  ─── FEATURE 4: VOLUME FADE ─────────────
// ═══════════════════════════════════════════

/**
 * Cancel any in-flight fade animation immediately.
 * Does NOT touch audio.volume — the caller is responsible for restoring
 * audio.volume to a sane value after cancelling.
 */
function cancelFade() {
  if (fadeRafId !== null) {
    cancelAnimationFrame(fadeRafId);
    fadeRafId = null;
  }
}

/**
 * Fade audio.volume from 0 → userVolume over FADE_DURATION_MS,
 * starting audio playback at volume 0 then ramping up.
 *
 * The ramp uses a cubic easing curve for a natural acoustic feel:
 *   volume = (t/duration)^2 × userVolume
 */
function fadeIn() {
  cancelFade();
  audio.volume = 0;

  audio.play().catch(err => {
    console.warn("Playback blocked:", err);
    setPlayingState(false);
    audio.volume = userVolume;
    return;
  });

  const target    = userVolume;
  const startTime = performance.now();

  function tick(now) {
    const elapsed  = now - startTime;
    const progress = Math.min(elapsed / FADE_DURATION_MS, 1);
    // Ease-in quadratic: starts slow, ramps up
    audio.volume = Math.pow(progress, 2) * target;

    if (progress < 1) {
      fadeRafId = requestAnimationFrame(tick);
    } else {
      audio.volume = target;  // snap to exact target at end
      fadeRafId    = null;
    }
  }

  fadeRafId = requestAnimationFrame(tick);
}

/**
 * Fade audio.volume from its current value → 0 over FADE_DURATION_MS,
 * then pause and restore audio.volume to userVolume.
 *
 * The ramp uses ease-out quadratic: starts fast, slows to silence.
 * An optional callback fires after the pause completes.
 *
 * @param {Function|null} callback  Optional function to call after pause.
 */
function fadeOut(callback = null) {
  cancelFade();

  const startVol  = audio.volume > 0 ? audio.volume : userVolume;
  const startTime = performance.now();

  function tick(now) {
    const elapsed  = now - startTime;
    const progress = Math.min(elapsed / FADE_DURATION_MS, 1);
    // Ease-out quadratic: fast start, gentle silence
    audio.volume = startVol * Math.pow(1 - progress, 2);

    if (progress < 1) {
      fadeRafId = requestAnimationFrame(tick);
    } else {
      audio.volume = 0;
      fadeRafId    = null;
      audio.pause();
      // Restore userVolume so next play() starts the fade from the right target
      audio.volume = userVolume;
      if (callback) callback();
    }
  }

  fadeRafId = requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════
//  ─── FEATURE 1: SWIPE GESTURES ──────────
// ═══════════════════════════════════════════

/**
 * Attach touch listeners to the vinyl stage.
 *
 * - touchstart: record the finger's starting position.
 * - touchend:   measure the delta; fire skip if threshold crossed.
 * - Vertical drift guard: if |deltaY| > SWIPE_VERT_MAX, reject the swipe
 *   so the user can scroll the page without accidentally skipping.
 * - { passive: true } on both listeners so the browser doesn't wait for
 *   JS before deciding whether to scroll — keeps 60fps on iOS Safari.
 *
 * Visual feedback:
 *   .swipe-left / .swipe-right CSS classes trigger the tilt animation.
 *   They are removed automatically on animationend.
 *
 * Hint arrows:
 *   On the very first touch, .show-hint class briefly reveals the arrow
 *   chevrons so the user discovers the feature. After 1.5s the class
 *   is removed and never shown again (tracked with a flag).
 */
function bindSwipeGestures() {
  let touchStartX = 0;
  let touchStartY = 0;
  let hintShown   = false;

  vinylStage.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;

    // Show hint arrows exactly once
    if (!hintShown) {
      hintShown = true;
      vinylStage.classList.add("show-hint");
      setTimeout(() => vinylStage.classList.remove("show-hint"), 1500);
    }
  }, { passive: true });

  vinylStage.addEventListener("touchend", (e) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;

    // Ignore if mostly vertical (user was probably scrolling)
    if (Math.abs(deltaY) > SWIPE_VERT_MAX) return;
    // Ignore if too short to be intentional
    if (Math.abs(deltaX) < SWIPE_THRESHOLD) return;

    const direction = deltaX < 0 ? "swipe-left" : "swipe-right";

    // Tilt animation — removed on animationend
    vinyl.classList.remove("swipe-left", "swipe-right");
    void vinyl.offsetWidth;  // force reflow so removing then re-adding works
    vinyl.classList.add(direction);
    vinyl.addEventListener("animationend",
      () => vinyl.classList.remove("swipe-left", "swipe-right"),
      { once: true }
    );

    if (deltaX < 0) {
      nextTrack();   // swipe left → next
    } else {
      prevTrack();   // swipe right → previous
    }
  }, { passive: true });
}

// ═══════════════════════════════════════════
//  FAVORITES
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
//  AUTOPLAY TOGGLE
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
//  SEARCH & FILTER
// ═══════════════════════════════════════════

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

  // Rebuild shuffle queue if shuffle is active — new filter changes the pool
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

// ═══════════════════════════════════════════
//  RENDER SONG LIST
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
//  LOAD TRACK
// ═══════════════════════════════════════════

function loadTrack(idx, autoPlay = false) {
  if (idx < 0 || idx >= filteredSongs.length) return;

  // ── Critical: cancel any fade before switching tracks ──────────────
  // Without this, a fade-out from a previous pause could be mid-animation
  // when we call loadTrack. The audio.volume would be wrong for the new track.
  cancelFade();
  audio.volume = userVolume;

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

  // Update shuffle position to match the newly loaded track
  if (isShuffled) {
    const posInQueue = shuffleQueue.indexOf(idx);
    if (posInQueue !== -1) shufflePos = posInQueue;
  }

  highlightActiveRow();
  updateMediaSession(song);

  if (autoPlay) {
    // Use fadeIn so even track switches get the smooth ramp
    fadeIn();
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

/**
 * togglePlay — entry point for all play/pause actions.
 * Routes through fadeIn / fadeOut instead of calling audio.play/pause directly.
 */
function togglePlay() {
  if (!audio.src || currentIndex === -1) {
    if (filteredSongs.length > 0) loadTrack(0, true);
    return;
  }

  if (isPlaying) {
    fadeOut();    // ramps volume to 0, then pauses
  } else {
    fadeIn();     // sets volume 0, calls play(), ramps to userVolume
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

// ═══════════════════════════════════════════
//  SKIP — respects shuffle queue
// ═══════════════════════════════════════════

function prevTrack() {
  if (filteredSongs.length === 0) return;

  // If more than 3 seconds in: restart current track
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }

  if (isShuffled && shuffleQueue.length > 0) {
    // Walk backwards through shuffle history
    shufflePos = shufflePos <= 0 ? shuffleQueue.length - 1 : shufflePos - 1;
    loadTrack(shuffleQueue[shufflePos], isPlaying);
  } else {
    loadTrack(currentIndex <= 0 ? filteredSongs.length - 1 : currentIndex - 1, isPlaying);
  }
}

function nextTrack() {
  if (filteredSongs.length === 0) return;

  if (isShuffled && shuffleQueue.length > 0) {
    shufflePos++;
    // If we've exhausted the queue, rebuild a fresh shuffle
    if (shufflePos >= shuffleQueue.length) {
      buildShuffleQueue();
      shufflePos = 0;
    }
    loadTrack(shuffleQueue[shufflePos], isPlaying);
  } else {
    loadTrack((currentIndex + 1) % filteredSongs.length, isPlaying);
  }
}

// ═══════════════════════════════════════════
//  AUDIO EVENTS
// ═══════════════════════════════════════════

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

/**
 * AUTOPLAY / SHUFFLE END-OF-TRACK LOGIC
 *
 * When autoplay is ON:
 *   nextTrack() handles both shuffled and sequential modes correctly.
 *
 * When autoplay is OFF:
 *   Stop cleanly. Restore progress bar to 100% so user sees track finished.
 */
audio.addEventListener("ended", () => {
  if (autoplayEnabled) {
    nextTrack();
  } else {
    setPlayingState(false);
    progressFill.style.width = "100%";
  }
});

audio.addEventListener("error", () => {
  console.error("Audio failed:", audio.src);
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
    case "Space":      e.preventDefault(); togglePlay();  break;
    case "ArrowRight": e.preventDefault(); audio.currentTime = Math.min(audio.currentTime + 10, audio.duration || 0); break;
    case "ArrowLeft":  e.preventDefault(); audio.currentTime = Math.max(audio.currentTime - 10, 0); break;
    case "ArrowUp":    e.preventDefault(); setVolume(userVolume + 0.1); break;
    case "ArrowDown":  e.preventDefault(); setVolume(userVolume - 0.1); break;
    case "KeyN":       nextTrack();        break;
    case "KeyP":       prevTrack();        break;
    case "KeyS":       btnShuffle.click(); break;   // S = toggle shuffle
    case "KeyL":
      if (filteredSongs[currentIndex]) toggleFavorite(filteredSongs[currentIndex].id, true);
      break;
  }
});

// ═══════════════════════════════════════════
//  VOLUME
// ═══════════════════════════════════════════

/**
 * setVolume — the only function that should update userVolume.
 * If a fade is in progress, we update userVolume (the target) but
 * leave audio.volume to the fade animation — the ramp will naturally
 * converge to the new target on its next tick.
 */
function setVolume(val) {
  const v  = clamp(parseFloat(val), 0, 1);
  userVolume = v;
  // Only directly set audio.volume if no fade is running
  if (fadeRafId === null) audio.volume = v;
  volumeFill.style.width = `${v * 100}%`;
  volumeBar.value = v;
  localStorage.setItem(LS_VOL_KEY, v);
}

volumeBar.addEventListener("input", () => setVolume(volumeBar.value));

// ═══════════════════════════════════════════
//  HIGHLIGHT ACTIVE ROW
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
//  RESTORE SESSION
// ═══════════════════════════════════════════

function restoreSession() {
  const savedVol = localStorage.getItem(LS_VOL_KEY);
  setVolume(savedVol !== null ? parseFloat(savedVol) : 0.8);

  const savedIdx = parseInt(localStorage.getItem(LS_SONG_KEY) || "-1");
  if (savedIdx >= 0 && savedIdx < songs.length) {
    const song        = songs[savedIdx];
    const filteredIdx = filteredSongs.findIndex(s => s.id === song.id);
    if (filteredIdx !== -1) loadTrack(filteredIdx, false);  // load, no autoplay
  }
}

// ═══════════════════════════════════════════
//  MEDIA SESSION API (Siri / Lock Screen)
// ═══════════════════════════════════════════

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  // Wire transport actions — these must call our wrapper functions,
  // not audio.play/pause directly, so fades and shuffle routing apply.
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
  } catch (_) { /* not all browsers support setPositionState */ }
}

// ═══════════════════════════════════════════
//  GO
// ═══════════════════════════════════════════

init();
