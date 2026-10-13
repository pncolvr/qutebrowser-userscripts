// ==UserScript==
// @name audo dismiss login window
// @author pncolvr
// @description automatically dismiss chatgpt login window
// @match https://*.chatgpt.com/*
// @match https://chatgpt.com/*
// @license MIT
// @grant none
// ==/UserScript==

// 

// function waitForDialog() {
//   return new Promise((resolve) => {
//     const existing = document.querySelector('div[role="dialog"]');
//     if (existing) {
//       return resolve(existing);
//     }

//     const observer = new MutationObserver(() => {
//       const dialog = document.querySelector('div[role="dialog"]');
//       if (dialog) {
//         observer.disconnect();
//         resolve(dialog);
//       }
//     });

//     observer.observe(document.body, {
//       childList: true,
//       subtree: true,
//     });
//   });
// }

// waitForDialog().then(dialog => {
//   console.log('Dialog found: dismissing');
//   document.querySelector("[data-testid='dismiss-welcome']").click();
// });