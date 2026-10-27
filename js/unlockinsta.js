javascript: (() => {
  const profile = new URL(window.location.href).pathname.split("/").filter(Boolean)[0];
  window.location.assign(`https://instapeep.com/?u=${encodeURIComponent(profile)}`);
})();
'unlocked'
