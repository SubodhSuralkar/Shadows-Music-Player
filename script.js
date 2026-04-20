/**
 * SONATA — Music Player Script
 * Features:
 *   • Fetches song catalogue from songs.json
 *   • Full playback controls (play/pause/prev/next/seek/volume)
 *   • navigator.mediaSession API (Siri, Lock Screen, hardware keys)
 *   • localStorage persistence (last song index + volume)
 *   • Real-time search filtering
 *   • Spinning vinyl animation synced to playback state
 */

"use strict";

// ═══════════════════════════════════════════
//  CONSTANTS & STATE
// ═══════════════════════════════════════════

const SONGS_URL     = "songs.json";   // path to your JSON catalogue
const LS_SONG_KEY   = "sonata_last_song";
const LS_VOL_KEY    = "sonata_volume";
const FALLBACK_ART  = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='512' height='512'%3E%3Crect width='512' height='512' fill='%23111'/%3E%3Ccircle cx='256' cy='256' r='80' fill='%23222'/%3E%3C/svg%3E";

let songs        = [];     // full catalogue loaded from JSON
let filteredSongs = [];    // currently visible (after search)
let currentIndex = -1;     // index within filteredSongs
let isPlaying    = false;

// ═══════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════

const audio         = document.getElementById("audio-player");
const vinyl         = document.getElementById("vinyl");
const coverArt      = document.getElementById("cover-art");
const trackTitle    = document.getElementById("track-title");
const trackArtist   = document.getElementById("track-artist");
const trackAlbum    = document.getElementById("track-album");
const progressFill  = document.getElementById("progress-fill");
const seekBar       = document.getElementById("seek-bar");
const timeCurrent   = document.getElementById("time-current");
const timeTotal     = document.getElementById("time-total");
const btnPlay       = document.getElementById("btn-play");
const btnPrev       = document.getElementById("btn-prev");
const btnNext       = document.getElementById("btn-next");
const volumeBar     = document.getElementById("volume-bar");
const volumeFill    = document.getElementById("volume-fill");
const searchBar     = document.getElementById("search-bar");
const songListEl    = document.getElementById("song-list");
const emptyState    = document.getElementById("empty-state");
const playerPanel   = document.querySelector(".player-panel");
const iconPlay      = btnPlay.querySelector(".icon-play");
const iconPause     = btnPlay.querySelector(".icon-pause");

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

// ═══════════════════════════════════════════
//  BOOT — Load songs.json
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

  filteredSongs = [...songs];
  renderSongList(filteredSongs);
  restoreSession();
  setupMediaSession();
}

// ═══════════════════════════════════════════
//  RENDER SONG LIST
// ═══════════════════════════════════════════

function renderSongList(list) {
  songListEl.innerHTML = "";
  emptyState.style.display = list.length === 0 ? "block" : "none";

  list.forEach((song, idx) => {
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
      <span class="song-duration-text">${escapeHTML(song.duration || "—")}</span>
    `;

    li.addEventListener("click", () => {
      if (currentIndex === idx && audio.src) {
        togglePlay();
      } else {
        loadTrack(idx, true);
      }
    });

    songListEl.appendChild(li);
  });

  // Re-highlight active row after re-render
  highlightActiveRow();
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════
//  LOAD & PLAY A TRACK
// ═══════════════════════════════════════════

function loadTrack(idx, autoPlay = false) {
  if (idx < 0 || idx >= filteredSongs.length) return;

  currentIndex = idx;
  const song = filteredSongs[idx];

  // Set audio source
  audio.src = song.src;
  audio.load();

  // Update UI
  trackTitle.textContent  = song.title;
  trackArtist.textContent = song.artist;
  trackAlbum.textContent  = song.album || "—";
  coverArt.src            = song.cover || FALLBACK_ART;

  // Reset progress
  progressFill.style.width = "0%";
  seekBar.value            = 0;
  timeCurrent.textContent  = "0:00";
  timeTotal.textContent    = song.duration || "0:00";

  // Persist
  localStorage.setItem(LS_SONG_KEY, findOriginalIndex(song));

  // Highlight list
  highlightActiveRow();

  // Media Session metadata
  updateMediaSession(song);

  if (autoPlay) {
    audio.play().then(() => {
      setPlayingState(true);
    }).catch(err => {
      console.warn("Playback blocked:", err);
      setPlayingState(false);
    });
  } else {
    setPlayingState(false);
  }
}

/**
 * Find the original index of a song in the full catalogue
 * so we can restore the correct track across searches.
 */
function findOriginalIndex(song) {
  return songs.findIndex(s => s.id === song.id);
}

// ═══════════════════════════════════════════
//  PLAY / PAUSE TOGGLE
// ═══════════════════════════════════════════

function togglePlay() {
  if (!audio.src || currentIndex === -1) {
    // Nothing loaded — play first track
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

  iconPlay.style.display  = playing ? "none" : "block";
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

  // Reflect on active list item
  const activeEl = songListEl.querySelector(".song-item.active");
  if (activeEl) {
    if (playing) {
      activeEl.classList.remove("paused-indicator");
    } else {
      activeEl.classList.add("paused-indicator");
    }
  }
}

// ═══════════════════════════════════════════
//  SKIP PREV / NEXT
// ═══════════════════════════════════════════

function prevTrack() {
  // If more than 3s in, restart; else go to previous
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const newIdx = currentIndex <= 0 ? filteredSongs.length - 1 : currentIndex - 1;
  loadTrack(newIdx, isPlaying);
}

function nextTrack() {
  const newIdx = (currentIndex + 1) % filteredSongs.length;
  loadTrack(newIdx, isPlaying);
}

// ═══════════════════════════════════════════
//  PROGRESS BAR
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
  const time = (seekBar.value / 100) * audio.duration;
  audio.currentTime = time;
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
//  AUDIO EVENTS
// ═══════════════════════════════════════════

audio.addEventListener("play",  () => setPlayingState(true));
audio.addEventListener("pause", () => setPlayingState(false));
audio.addEventListener("ended", () => nextTrack());

audio.addEventListener("error", (e) => {
  console.error("Audio error:", e);
  setPlayingState(false);
  trackTitle.textContent = "⚠ Could not load track";
});

// ═══════════════════════════════════════════
//  CONTROLS — Event Listeners
// ═══════════════════════════════════════════

btnPlay.addEventListener("click", togglePlay);
btnPrev.addEventListener("click", prevTrack);
btnNext.addEventListener("click", nextTrack);

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  // Don't hijack input/search focus
  if (e.target.tagName === "INPUT") return;

  switch (e.code) {
    case "Space":      e.preventDefault(); togglePlay(); break;
    case "ArrowRight": e.preventDefault(); audio.currentTime = Math.min(audio.currentTime + 10, audio.duration || 0); break;
    case "ArrowLeft":  e.preventDefault(); audio.currentTime = Math.max(audio.currentTime - 10, 0); break;
    case "ArrowUp":    e.preventDefault(); setVolume(audio.volume + 0.1); break;
    case "ArrowDown":  e.preventDefault(); setVolume(audio.volume - 0.1); break;
    case "KeyN":       nextTrack(); break;
    case "KeyP":       prevTrack(); break;
  }
});

// ═══════════════════════════════════════════
//  SEARCH
// ═══════════════════════════════════════════

searchBar.addEventListener("input", () => {
  const q = searchBar.value.trim().toLowerCase();
  if (!q) {
    filteredSongs = [...songs];
  } else {
    filteredSongs = songs.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      (s.album && s.album.toLowerCase().includes(q))
    );
  }
  // When filtering, currentIndex might become invalid — reset it
  // but keep the audio playing if something is already active
  currentIndex = -1;
  renderSongList(filteredSongs);
  reAttachActiveAfterSearch();
});

/**
 * After search re-render, find if the currently playing song
 * is still in the filtered list and re-highlight it.
 */
function reAttachActiveAfterSearch() {
  if (!audio.src) return;
  const playingSong = songs[parseInt(localStorage.getItem(LS_SONG_KEY) || "-1")];
  if (!playingSong) return;

  const newIdx = filteredSongs.findIndex(s => s.id === playingSong.id);
  if (newIdx !== -1) {
    currentIndex = newIdx;
    highlightActiveRow();
  }
}

// ═══════════════════════════════════════════
//  HIGHLIGHT ACTIVE ROW
// ═══════════════════════════════════════════

function highlightActiveRow() {
  document.querySelectorAll(".song-item").forEach(el => {
    el.classList.remove("active", "paused-indicator");
  });

  if (currentIndex < 0) return;

  const rows = songListEl.querySelectorAll(".song-item");
  const target = rows[currentIndex];
  if (target) {
    target.classList.add("active");
    if (!isPlaying) target.classList.add("paused-indicator");
    // Scroll into view smoothly
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ═══════════════════════════════════════════
//  RESTORE LAST SESSION FROM localStorage
// ═══════════════════════════════════════════

function restoreSession() {
  // Restore volume
  const savedVol = localStorage.getItem(LS_VOL_KEY);
  setVolume(savedVol !== null ? parseFloat(savedVol) : 0.8);

  // Restore last song (load but don't autoplay — user must click)
  const savedIdx = parseInt(localStorage.getItem(LS_SONG_KEY) || "-1");
  if (savedIdx >= 0 && savedIdx < songs.length) {
    const song = songs[savedIdx];
    // Find this song in the current filteredSongs (same as full songs on init)
    const filteredIdx = filteredSongs.findIndex(s => s.id === song.id);
    if (filteredIdx !== -1) {
      loadTrack(filteredIdx, false); // load metadata, don't play
    }
  }
}

// ═══════════════════════════════════════════
//  navigator.mediaSession API
//  Enables: Siri commands, iPhone Lock Screen controls,
//  AirPods hardware buttons, Control Center
// ═══════════════════════════════════════════

function setupMediaSession() {
  if (!("mediaSession" in navigator)) {
    console.info("mediaSession API not supported in this browser.");
    return;
  }

  // Wire transport actions to our player functions
  navigator.mediaSession.setActionHandler("play",          () => { audio.play(); });
  navigator.mediaSession.setActionHandler("pause",         () => { audio.pause(); });
  navigator.mediaSession.setActionHandler("previoustrack", () => { prevTrack(); });
  navigator.mediaSession.setActionHandler("nexttrack",     () => { nextTrack(); });
  navigator.mediaSession.setActionHandler("seekto",        (details) => {
    if (details.seekTime !== undefined) {
      audio.currentTime = details.seekTime;
    }
  });
  navigator.mediaSession.setActionHandler("seekbackward",  (details) => {
    audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
  });
  navigator.mediaSession.setActionHandler("seekforward",   (details) => {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 10));
  });

  // Sync position state for Lock Screen scrubber
  audio.addEventListener("timeupdate", updatePositionState);
}

/**
 * Push metadata for the current song to the OS media session.
 * This is what Siri reads aloud and what appears on the Lock Screen.
 */
function updateMediaSession(song) {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  song.title,
    artist: song.artist,
    album:  song.album || "",
    artwork: song.cover
      ? [
          { src: song.cover, sizes: "512x512", type: "image/jpeg" },
          { src: song.cover, sizes: "256x256", type: "image/jpeg" },
          { src: song.cover, sizes: "128x128", type: "image/jpeg" }
        ]
      : []
  });
}

function updatePositionState() {
  if (!("mediaSession" in navigator)) return;
  if (!audio.duration || isNaN(audio.duration)) return;

  try {
    navigator.mediaSession.setPositionState({
      duration:     audio.duration,
      playbackRate: audio.playbackRate,
      position:     audio.currentTime
    });
  } catch (_) {
    // setPositionState may throw on some browsers — silently ignore
  }
}

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════

init();
