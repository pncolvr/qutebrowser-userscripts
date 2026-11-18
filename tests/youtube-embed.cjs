// Exercise YouTube embed rewriting and card fallback decisions without a browser.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../custom/js/youtube-embed-to-link.js'), 'utf8')
const hook = {}
vm.runInNewContext(source, {__quteEmbedTest: hook, URL, JSON})
const t = hook.exports
assert.ok(t, 'test hook must export helpers without touching the DOM')

const origin = 'https://example.org'
const rewrite = src => t.nocookieSrc(src, origin) && new URL(t.nocookieSrc(src, origin))

// Embeds move to the privacy-enhanced host, keep their parameters and gain the API.
let url = rewrite('https://www.youtube.com/embed/dQw4w9WgXcQ?start=30&rel=0')
assert.equal(url.host, 'www.youtube-nocookie.com')
assert.equal(url.pathname, '/embed/dQw4w9WgXcQ')
assert.equal(url.searchParams.get('start'), '30')
assert.equal(url.searchParams.get('rel'), '0')
assert.equal(url.searchParams.get('enablejsapi'), '1')
assert.equal(url.searchParams.get('origin'), origin)
url = rewrite('http://youtube.com/embed/dQw4w9WgXcQ')
assert.equal(url.protocol, 'https:')
assert.equal(url.host, 'www.youtube-nocookie.com')
url = rewrite('https://www.youtube.com/embed/dQw4w9WgXcQ?origin=https://other.example')
assert.equal(url.searchParams.get('origin'), 'https://other.example', 'an existing origin is kept')
assert.equal(t.nocookieSrc('https://www.youtube.com/embed/x', 'null'), 'https://www.youtube-nocookie.com/embed/x?enablejsapi=1',
  'opaque origins are not passed to the player')
console.log('PASS: YouTube embeds are rewritten to youtube-nocookie.com with their parameters')

// Already on the nocookie host: same URL apart from the API flag, so no reload loop.
const nocookie = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&origin=https%3A%2F%2Fexample.org'
assert.equal(t.nocookieSrc(nocookie, origin), nocookie, 'rewriting is idempotent')
assert.equal(t.nocookieSrc(t.nocookieSrc('https://www.youtube.com/embed/abc', origin), origin),
  t.nocookieSrc('https://www.youtube.com/embed/abc', origin))
console.log('PASS: rewriting is idempotent, so an embed is reloaded at most once')

// Non-embeds are never touched.
for (const src of [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://evil.example/embed/dQw4w9WgXcQ',
  'https://notyoutube.com/embed/dQw4w9WgXcQ',
  'about:blank',
  '',
]) assert.equal(t.nocookieSrc(src, origin), null, src)
console.log('PASS: only YouTube /embed/ frames are rewritten')

// Pages using YouTube's iframe API keep their player host.
assert.equal(t.pageControlsPlayer('https://www.youtube.com/embed/x?enablejsapi=1'), true)
assert.equal(t.pageControlsPlayer('https://www.youtube.com/embed/x'), false)
assert.equal(t.pageControlsPlayer('https://example.org/embed/x?enablejsapi=1'), false)
console.log('PASS: iframe-API embeds are observed, not rewritten')

// Cards link to the right YouTube page.
assert.equal(t.watchUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
assert.equal(t.watchUrl('https://www.youtube.com/embed/dQw4w9WgXcQ?list=PL1'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1')
assert.equal(t.watchUrl('https://www.youtube.com/embed/videoseries?list=PL1'), 'https://www.youtube.com/playlist?list=PL1')
assert.equal(t.watchUrl('https://www.youtube-nocookie.com/embed/live_stream?channel=UCabc'), 'https://www.youtube.com/channel/UCabc/live')
assert.equal(t.watchUrl('https://www.youtube.com/embed/videoseries'), 'https://www.youtube.com/')
assert.equal(t.watchUrl('https://www.youtube.com/embed/'), 'https://www.youtube.com/')
console.log('PASS: cards link to the video, playlist or live channel')

// Embedly wrappers still become cards, using the wrapped embed.
const wrapped = 'https://cdn.embedly.com/widgets/media.html?src=' +
  encodeURIComponent('https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed')
assert.equal(t.watchUrl(t.embedlySrc(wrapped)), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
assert.equal(t.embedlySrc('https://cdn.embedly.com/widgets/media.html?src=https://vimeo.com/1'), null)
console.log('PASS: Embedly-wrapped YouTube embeds still become cards')

// Card fallback only on player errors.
const msg = (event, info) => JSON.stringify({event, info})
assert.equal(t.embedFailed(msg('onError', 152)), true)
assert.equal(t.embedFailed(msg('onError', 150)), true)
assert.equal(t.embedFailed(msg('initialDelivery', {videoData: {video_id: 'live_stream', errorCode: 'auth'}})), true)
assert.equal(t.embedFailed(msg('initialDelivery', {playerState: 5, videoData: {video_id: 'abc', errorCode: null}})), false)
assert.equal(t.embedFailed(msg('infoDelivery', {currentTime: 3})), false)
assert.equal(t.embedFailed(msg('onStateChange', 1)), false)
assert.equal(t.embedFailed('not json'), false)
assert.equal(t.embedFailed({event: 'onError', info: 101}), true)
assert.equal(t.embedReady(msg('onReady')), true)
assert.equal(t.embedReady(msg('initialDelivery', {})), true)
assert.equal(t.embedReady(msg('infoDelivery', {})), false)
console.log('PASS: only player errors replace an embed with a card')
