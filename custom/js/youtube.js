// ==UserScript==
// @name         YouTube auto cinema mode
// @namespace    http://youtube.com/
// @version      0.1
// @description  YouTube auto cinema mode and auto mute ads
// @author       pncolvr
// @match        https://*.youtube.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

if (document.cookie.indexOf("wide=1") === -1) {
    document.cookie="wide=1;domain=.youtube.com"
    location.reload();
}


// taken from https://github.com/SebastianSimon/youtube-save-time-stamp/blob/master/YouTube%3A%20Remember%20current%20time%20stamp.user.js
addEventListener("pause", () => {
  if(location.pathname.includes("/watch")){
    const url = new URL(location),
      [
        currentTime,
        totalTime
      ] = [
          ".ytp-time-current",
          ".ytp-time-duration"
        ].map((selector) => {
          const timeStamp = document.querySelector(selector)?.textContent;
          
          if(timeStamp){
            const time = timeStamp.split(":").map(Number);
            
            if(time.length === 4){
              time[1] += 24 * time[0];
              time.shift();
            }
            
            const {
                timeParam,
                totalSeconds
              } = time.reduceRight((aggregator, measure) => {
                  const unit = aggregator.timeUnits.shift(),
                    scalar = aggregator.timeScalars.shift();
                  
                  if(measure){
                    aggregator.timeParam = `${measure}${unit}${aggregator.timeParam}`;
                    aggregator.totalSeconds += scalar * measure;
                  }
                  
                  return aggregator;
                }, {
                  timeParam: "",
                  totalSeconds: 0,
                  timeUnits: [
                    "s",
                    "m",
                    "h"
                  ],
                  timeScalars: [
                    1,
                    60,
                    60 * 60
                  ]
                });
            
            return {
              timeParam,
              totalSeconds
            };
          }
          
          return null;
        });
    
    if(currentTime){
      if(currentTime.timeParam && currentTime.totalSeconds <= totalTime.totalSeconds - 5){
        if(currentTime.timeParam !== url.searchParams.get("t")){
          url.searchParams.set("t", currentTime.timeParam);
          history.replaceState(history.state, "", url);
        }
      }
      else{
        url.searchParams.delete("t");
        history.replaceState(history.state, "", url);
      }
    }
  }
}, {
  capture: true
});


const adSelectors = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-module',
    '.ytp-ad-text',
    '.video-ads',
    '.ytp-ad-image-overlay',
    '.ad-interrupting'
];

let wasMutedByScript = false;
let userOverrode = false;

const video = document.querySelector('video');

const attachUserListener = () => {
    const v = document.querySelector('video');
    if (!v) return;

    v.addEventListener('volumechange', () => {
        if (wasMutedByScript && !userOverrode && isAdPresent()) {
            console.log("User manually unmuted during ad: respecting");
            userOverrode = true;
        }
    });
};

const isAdPresent = () => {
    return adSelectors.some(selector => {
        const el = document.querySelector(selector);
        return el && el.offsetHeight > 0;
    });
};

const toggleMute = (shouldMute) => {
    const video = document.querySelector('video');
    if (!video) return;

    if (shouldMute) {
        if (!video.muted && !userOverrode) {
            console.log("Ad detected: muting");
            // video.muted = true;
            const btn = document.querySelector('.ytp-mute-button');
            if (btn && !video.muted) btn.click();
            wasMutedByScript = true;
        }
    } else {
        userOverrode = false;

        if (wasMutedByScript) {
            console.log("Ad ended: unmuting");
            // video.muted = false;
            const btn = document.querySelector('.ytp-mute-button');
            if (btn && video.muted) btn.click();
            wasMutedByScript = false;
        }
    }
};

const observer = new MutationObserver(() => {
    toggleMute(isAdPresent());
    attachUserListener();
});

observer.observe(document.body, { childList: true, subtree: true });
