'use strict'

/**
 * Verification scenarios — loaded ONLY when DEEPWORK_VERIFY is set.
 *
 * WHY THIS FILE EXISTS: the emergency exits are the safety-critical part of this
 * app, and they are the hardest part to test, because a genuinely *held* key cannot
 * be scripted (macOS blocks synthetic keystrokes without Accessibility permission).
 * These scenarios drive the real `before-input-event` handler in main.js with a
 * synthetic key source, so everything downstream of the keypress is genuinely
 * exercised. The physical 5-second hold is the only part left to a human.
 *
 * `sendInputEvent({ keyCode: ' ' })` arrives at the handler as
 * `{ key: ' ', code: 'Space' }` — measured, both fields are populated — so this
 * harness exercises exactly the same match a real spacebar takes.
 *
 * Usage:
 *   DEEPWORK_VERIFY=shot:/tmp/x.png        save the break screen's own render
 *   DEEPWORK_VERIFY=work-shot:/tmp/x.png   save the work window's own render
 *   DEEPWORK_VERIFY=space-hold        press-and-hold Space, never release   -> must quit
 *   DEEPWORK_VERIFY=space-cancel      press Space, release early            -> must NOT quit
 *   DEEPWORK_VERIFY=crash             kill the overlay's renderer           -> must quit
 */

const fs = require('node:fs')

function onWorkWindowShown(win, log) {
  const [name, arg] = (process.env.DEEPWORK_VERIFY || '').split(':')
  if (name !== 'work-shot' || !arg) return
  setTimeout(() => {
    win.webContents
      .capturePage()
      .then((img) => {
        fs.writeFileSync(arg, img.toPNG())
        log('VERIFY work-window shot written to', arg)
      })
      .catch((e) => log('VERIFY work shot failed:', e.message))
  }, 900)
}

function onFirstOverlayShown(win, log) {
  const spec = process.env.DEEPWORK_VERIFY || ''
  const [name, arg] = spec.split(':')
  const wc = win.webContents
  const space = (type) => wc.sendInputEvent({ type, keyCode: ' ' })

  setTimeout(() => {
    if (name === 'shot' && arg) {
      wc.capturePage()
        .then((img) => {
          fs.writeFileSync(arg, img.toPNG())
          log('VERIFY shot written to', arg)
        })
        .catch((e) => log('VERIFY shot failed:', e.message))
    } else if (name === 'space-hold') {
      log('VERIFY pressing Space and holding')
      space('keyDown')
    } else if (name === 'space-cancel') {
      log('VERIFY pressing Space, releasing after 300ms')
      space('keyDown')
      setTimeout(() => space('keyUp'), 300)
    } else if (name === 'crash') {
      log('VERIFY crashing the overlay renderer')
      wc.forcefullyCrashRenderer()
    }
  }, 700)
}

module.exports = { onFirstOverlayShown, onWorkWindowShown }
