javascript: (() => {
  const url = new URL(window.location.href);
  window.open(
    `https://imginn.com/${url.pathname.replaceAll("/", "")}`,
    "_self"
  );
  history.replaceState({}, "", location.href);
})();
'unlocked'