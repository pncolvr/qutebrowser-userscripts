// ==UserScript==
// @name        Remove ads Twitch
// @namespace   https://greasyfork.org/fr/users/11667-hoax017
// @match       https://www.twitch.tv/*
// @grant       none
// @version     1.0
// @author      Hoax017
// @license MIT
// @description Continue to view twitch stream when ad
// @downloadURL https://update.greasyfork.org/scripts/512376/Remove%20ads%20Twitch.user.js
// @updateURL https://update.greasyfork.org/scripts/512376/Remove%20ads%20Twitch.meta.js
// ==/UserScript==
let audioBeforeAd = null
let adBadge = null

function showAdBadge(visible) {
  if (!visible) {
    if (adBadge) adBadge.remove()
    adBadge = null
    return
  }
  if (adBadge || !document.body) return
  adBadge = document.createElement("div")
  adBadge.textContent = "Ad playing · audio muted"
  adBadge.setAttribute("role", "status")
  adBadge.style.cssText = `
    position: fixed; top: 6px; right: 8px; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    box-sizing: border-box; min-width: 240px; height: 36px; padding: 0 16px; border-radius: 999px;
    background: #000000; color: #d32f2f;
    border: none;
    box-shadow: 0 0 16px 4px rgba(0, 0, 0, 0.75), 0 4px 12px rgba(0, 0, 0, 0.6);
    font: 700 12px/1 system-ui, sans-serif; letter-spacing: 0.2px;
    pointer-events: none; user-select: none;
  `
  document.body.appendChild(adBadge)
}

function antiAdd() {
  const miniVideoparent = document.querySelector("div.picture-by-picture-player")
  const mainVideo = document.querySelector("div.video-ref video")
  if (!mainVideo) {
    showAdBadge(false)
    return
  }
  const isOpen = miniVideoparent && !miniVideoparent.className.includes("picture-by-picture-player--collapsed")
  showAdBadge(Boolean(isOpen && audioBeforeAd))
  if (!isOpen) {
    if (audioBeforeAd) {
      mainVideo.volume = audioBeforeAd.volume
      mainVideo.muted = audioBeforeAd.muted
      audioBeforeAd = null
    }
    return;
  }
  const miniVideo = miniVideoparent.querySelector("video")
  if (!miniVideo) return
  if (!audioBeforeAd) {
    audioBeforeAd = { muted: mainVideo.muted, volume: mainVideo.volume }
  }
  // Keep Twitch's video and control elements in their original DOM positions.
  miniVideo.volume = audioBeforeAd.volume
  miniVideo.muted = audioBeforeAd.muted
  mainVideo.muted = true
  showAdBadge(true)
}
setInterval(antiAdd, 500)
console.info("[Twitch Ads] Enabled — watching for ads.")
