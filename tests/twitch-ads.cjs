// Exercise ad transitions without a browser or live media.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../custom/js/twitch-ads.js'), 'utf8')

function player(muted, volume) {
  let poll
  let miniVideo = null
  let containerPresent = true
  let mainPresent = true
  const badges = new Set()
  function parent() {
    return {
      children: [],
      appendChild(child) {
        assert.ok(child)
        if (child.parentElement) {
          const siblings = child.parentElement.children
          siblings.splice(siblings.indexOf(child), 1)
        }
        this.children.push(child)
        child.parentElement = this
      },
      querySelector(tag) { return this.children.find(child => child.tagName === tag) || null }
    }
  }
  const mainVideo = { tagName: 'video', muted, volume }
  const controls = { tagName: 'div' }
  const overlay = { tagName: 'div' }
  const mainParent = parent()
  for (const child of [mainVideo, controls, overlay]) mainParent.appendChild(child)
  const container = parent()
  container.className = 'picture-by-picture-player--collapsed'
  vm.runInNewContext(source, {
    document: {
      body: { appendChild: element => badges.add(element) },
      createElement: () => ({
        style: {},
        setAttribute() {},
        remove() { badges.delete(this) }
      }),
      querySelector: selector => selector === 'div.video-ref video'
        ? (mainPresent ? mainVideo : null)
        : (containerPresent ? container : null)
    },
    setInterval(callback, interval) {
      assert.equal(interval, 500)
      poll = callback
    }
  })
  return {
    mainVideo, container, poll, badges,
    startAd() {
      container.className = 'picture-by-picture-player'
      if (miniVideo) container.children.splice(container.children.indexOf(miniVideo), 1)
      miniVideo = { tagName: 'video', muted: false, volume: 1 }
      container.appendChild(miniVideo)
      const video = miniVideo
      poll()
      return video
    },
    assertPlayerLayout() {
      assert.deepEqual(mainParent.children, [mainVideo, controls, overlay], 'player controls must keep their order')
      assert.equal(mainVideo.parentElement, mainParent)
      assert.equal(miniVideo.parentElement, container, 'mini-video must stay in Twitch’s mini-player')
      assert.equal(container.querySelector('video'), miniVideo)
    },
    removeContainer() { containerPresent = false },
    setMainPresent(value) { mainPresent = value }
  }
}

for (const muted of [false, true]) {
  for (const volume of [0, 0.17, 0.63, 1]) {
    const p = player(muted, volume)
    p.poll()
    assert.equal(p.badges.size, 0)
    assert.equal(p.mainVideo.muted, muted)
    const mini = p.startAd()
    p.assertPlayerLayout()
    assert.equal(p.badges.size, 1)
    assert.equal([...p.badges][0].textContent, 'Ad playing · audio muted')
    assert.equal(p.mainVideo.muted, true)
    assert.equal(mini.muted, muted)
    assert.equal(mini.volume, volume)
    p.poll()
    p.poll()
    p.assertPlayerLayout()
    assert.equal(p.badges.size, 1)
    // A replacement mini-player must use the original settings too.
    const replacement = p.startAd()
    p.assertPlayerLayout()
    assert.equal(replacement.muted, muted)
    assert.equal(replacement.volume, volume)
    p.mainVideo.volume = 0.9
    p.container.className = 'picture-by-picture-player--collapsed'
    p.poll()
    assert.equal(p.badges.size, 0)
    p.assertPlayerLayout()
    assert.equal(p.mainVideo.muted, muted)
    assert.equal(p.mainVideo.volume, volume)
    // A later ad break must capture fresh user settings.
    p.mainVideo.muted = !muted
    p.mainVideo.volume = 0.42
    p.startAd()
    p.setMainPresent(false)
    p.poll()
    assert.equal(p.badges.size, 0)
    p.removeContainer()
    p.poll()
    p.setMainPresent(true)
    p.poll()
    assert.equal(p.mainVideo.muted, !muted)
    assert.equal(p.mainVideo.volume, 0.42)
    // Once restored, normal user changes must survive subsequent polls.
    p.mainVideo.muted = muted
    p.mainVideo.volume = 0.23
    p.poll()
    assert.equal(p.mainVideo.muted, muted)
    assert.equal(p.mainVideo.volume, 0.23)
  }
}
console.log('PASS: audio restored and player controls left in place across ad polls, replacements and repeated breaks')
