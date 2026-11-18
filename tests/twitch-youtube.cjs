// Exercise the Twitch YouTube switch's detection helpers without a browser.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'custom/js/twitch-youtube-switch.js'), 'utf8')
const hook = {}
vm.runInNewContext(source, {__quteTwitchYoutubeTest: hook, URL, JSON})
const t = hook.exports
assert.ok(t, 'test hook must export helpers without touching the DOM')

const UC = 'UC' + 'a'.repeat(21) + '_'

// Channel pages only.
assert.equal(t.loginFromPath('/SomeStreamer'), 'somestreamer')
assert.equal(t.loginFromPath('/somestreamer/'), 'somestreamer')
for (const route of ['/', '/directory', '/settings', '/somestreamer/videos', '/popout/x/chat', '/a']) {
  assert.equal(t.loginFromPath(route), null, route)
}
console.log('PASS: only Twitch channel pages select a streamer')

// Only real /channel/UC… links resolve; handles and other hosts do not.
assert.equal(t.channelIdFromUrl(`https://www.youtube.com/channel/${UC}`), UC)
assert.equal(t.channelIdFromUrl(`https://youtube.com/channel/${UC}/live`), UC)
assert.equal(t.channelIdFromUrl('https://www.youtube.com/@handle'), null)
assert.equal(t.channelIdFromUrl(`https://evil.example/channel/${UC}`), null)
assert.equal(t.channelIdFromUrl(`https://notyoutube.com/channel/${UC}`), null)
assert.equal(t.channelIdFromUrl('not a url ::'), null)
assert.equal(t.channelIdFromSocials([
  {name: 'twitter', url: 'https://x.com/a'},
  {name: 'youtube', url: 'https://www.youtube.com/@a'},
  {name: 'youtube', url: `https://www.youtube.com/channel/${UC}`},
]), UC)
assert.equal(t.channelIdFromSocials(null), null)
console.log('PASS: YouTube channel IDs come only from /channel/UC… links')

// Panels and free text below the video.
assert.equal(t.channelIdFromText(`Watch me on youtube.com/channel/${UC} too`), UC)
assert.equal(t.channelIdFromText(`https://m.youtube.com/channel/${UC}?sub=1`), UC)
assert.equal(t.channelIdFromText(`https://notyoutube.com/channel/${UC}`), null)
assert.equal(t.channelIdFromText(`youtube.com/channel/${UC}extra`), null, 'IDs must end at 24 characters')
assert.equal(t.channelIdFromText(null), null)
assert.equal(t.channelIdFromPanels([
  {linkURL: 'https://streamlabs.com/x', description: 'Donate!'},
  {linkURL: null, description: `[YouTube](https://www.youtube.com/channel/${UC})`},
]), UC)
assert.equal(t.channelIdFromPanels([{linkURL: `https://www.youtube.com/channel/${UC}`}]), UC)
assert.equal(t.channelIdFromPanels(undefined), null)
assert.equal(JSON.stringify(t.youtubeHandles([
  'https://www.youtube.com/@SomeStreamer',
  'Also youtube.com/@SomeStreamer and https://youtube.com/@Other.Name/live',
  null,
])), JSON.stringify(['@SomeStreamer', '@Other.Name']))
const anchor = blocked => ({closest: selector => blocked && selector.includes('.chat-line__message') ? {} : null})
assert.equal(t.pageLinkAllowed(anchor(false)), true)
assert.equal(t.pageLinkAllowed(anchor(true)), false, 'chat links are ignored')
console.log('PASS: panel links and text below the video yield channel IDs; handles are reported')

// Cache: found IDs last a week, misses a day, corrupt entries are ignored.
const store = new Map()
const storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)}
const day = 24 * 3600 * 1000
assert.equal(t.readCache(storage, 'a', 0), undefined)
t.writeCache(storage, 'a', UC, 0)
assert.equal(t.readCache(storage, 'a', 6 * day), UC)
assert.equal(t.readCache(storage, 'a', 8 * day), undefined)
t.writeCache(storage, 'b', null, 0)
assert.equal(t.readCache(storage, 'b', day / 2), null)
assert.equal(t.readCache(storage, 'b', 2 * day), undefined)
store.set('qute-twitch-youtube:c', '{broken')
assert.equal(t.readCache(storage, 'c', 0), undefined)
t.writeCache({setItem() { throw new Error('quota') }}, 'd', UC, 0)
console.log('PASS: channel lookups are cached with separate hit/miss lifetimes')

// Probe: shapes captured from real live_stream embeds (2026-11-18).
const msg = (event, info) => JSON.stringify({event, info})
const liveData = {video_id: '1xO4ZbgNZtQ', title: 'LIVE', isPlayable: true, errorCode: null, isLive: false}
const offlineData = {video_id: 'live_stream', title: '', isPlayable: false, errorCode: 'auth', isLive: false}
let state = {}
assert.equal(t.probeStep(state, msg('initialDelivery', {playerState: 5, videoData: liveData})), 'live',
  'a live broadcast reports isLive:false before playback, so its real video ID decides')
assert.equal(state.videoData.video_id, '1xO4ZbgNZtQ')
assert.equal(state.videoData.title, 'LIVE')

state = {}
assert.equal(t.probeStep(state, msg('initialDelivery', {playerState: -1, videoData: offlineData})), 'unavailable')
state = {}
assert.equal(t.probeStep(state, msg('initialDelivery', {videoData: {...offlineData, errorCode: null}})), null,
  'the 11-character placeholder "live_stream" is never a live video')
state = {}
assert.equal(t.probeStep(state, msg('onError', 150)), 'unavailable')
state = {}
assert.equal(t.probeStep(state, msg('onReady', {})), null)
assert.equal(t.probeStep(state, msg('initialDelivery', {videoData: {video_id: 'abcdefghijk'}})), null,
  'wait until the player says the video is playable')
assert.equal(t.probeStep(state, msg('infoDelivery', {videoData: {isPlayable: true}})), 'live')
state = {}
assert.equal(t.probeStep(state, msg('infoDelivery', {videoData: {...liveData, video_id: 'short'}})), null)
assert.equal(t.probeStep(state, 'not json'), null)
state = {}
assert.equal(t.probeStep(state, {event: 'infoDelivery', info: {videoData: liveData}}), 'live',
  'object messages are accepted as well as JSON strings')
console.log('PASS: the probe reports live only for playable live embeds')

// The embed-to-link replacer must leave the switch's iframes alone.
const embedSource = fs.readFileSync(path.join(root, 'custom/js/youtube-embed-to-link.js'), 'utf8')
assert.match(embedSource, /iframe:not\(\[data-qute-keep-embed\]\)/)
assert.match(source, /dataset\.quteKeepEmbed = ''[\s\S]*dataset\.quteKeepEmbed = ''/,
  'both the probe and the player iframe opt out of link cards')
console.log('PASS: switch iframes opt out of YouTube link cards')

// twitch-ads keeps ad audio muted while the YouTube stream is showing.
let poll
const html = {dataset: {quteYoutubeSwitch: 'active'}}
const mainVideo = {muted: false, volume: 0.5}
const miniVideo = {muted: false, volume: 1}
const badges = new Set()
vm.runInNewContext(fs.readFileSync(path.join(root, 'custom/js/twitch-ads.js'), 'utf8'), {
  console: {info() {}},
  document: {
    documentElement: html,
    body: {appendChild: e => badges.add(e)},
    createElement: () => ({style: {}, setAttribute() {}, remove() { badges.delete(this) }}),
    querySelector: s => s === 'div.video-ref video' ? mainVideo
      : {className: 'picture-by-picture-player', querySelector: () => miniVideo},
  },
  setInterval: cb => { poll = cb },
})
poll()
assert.equal(miniVideo.muted, true)
assert.equal(mainVideo.muted, true)
assert.equal(badges.size, 0, 'no ad badge over the YouTube stream')
console.log('PASS: Twitch ads stay silent while the YouTube stream is shown')
