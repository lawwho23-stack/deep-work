'use strict'

/**
 * Deep Work — main process.
 *
 * THE ONE RULE IN THIS FILE: the main process owns the clock, the phase, and the
 * teardown of the break screen. The HTML pages only draw what they are told.
 *
 * WHY: the break screen is a black window sitting at macOS `screen-saver` level
 * across every display and every Space. If the "the break is over" decision lived
 * in that page and the page crashed, the black window would stay up forever and the
 * machine would be unusable behind it. Renderers are allowed to be display surfaces
 * and nothing more.
 */

const { app, BrowserWindow, Menu, screen, globalShortcut, powerMonitor, ipcMain } = require('electron')
const path = require('node:path')

// --- config ------------------------------------------------------------------
// Env-overridable so a full work -> break -> work cycle can be verified in seconds.
// Hardcoding 90 minutes means every end-to-end test is a 90-minute wait, which means
// the test never actually gets run.
const WORK_MS = Number(process.env.DEEPWORK_WORK_MS) || 90 * 60 * 1000
const BREAK_MS = Number(process.env.DEEPWORK_BREAK_MS) || 5 * 60 * 1000
const ESC_HOLD_MS = Number(process.env.DEEPWORK_ESC_HOLD_MS) || 5 * 1000
const KILL_ACCELERATOR = 'Command+Control+Alt+Q'
const AUTOSTART = process.env.DEEPWORK_AUTOSTART === '1' // test seam: skip the Start click
const VERIFY = process.env.DEEPWORK_VERIFY || '' // test seam, see verify.js
const TICK_MS = 250

// --- state -------------------------------------------------------------------
/** @type {'IDLE'|'WORK'|'BREAK'} */
let phase = 'IDLE'
let target = 0 // absolute epoch ms, never an accumulated counter
let workWin = null
let overlays = []
let ticker = null
let escTimer = null
let escStartedAt = 0
let exiting = false // set by a real exit path, so teardown only runs once

const log = (...a) => console.log('[deep-work]', ...a)

// --- clock -------------------------------------------------------------------

/**
 * Remaining time is always `target - now`, recomputed from scratch.
 * A counter incremented by setInterval stalls while the Mac sleeps, so a 90-minute
 * block would silently become "however long the lid was open".
 */
function remaining() {
  return Math.max(0, target - Date.now())
}

function broadcast() {
  const payload = {
    phase,
    remaining: remaining(),
    total: phase === 'BREAK' ? BREAK_MS : WORK_MS,
    workMs: WORK_MS,
    breakMs: BREAK_MS,
    escHoldMs: ESC_HOLD_MS,
  }
  for (const w of [workWin, ...overlays]) {
    if (w && !w.isDestroyed()) w.webContents.send('deepwork:tick', payload)
  }
}

function tick() {
  if (phase !== 'IDLE' && remaining() <= 0) {
    if (phase === 'WORK') return startBreak()
    if (phase === 'BREAK') return startWork()
  }
  broadcast()
}

function startTicker() {
  if (ticker) return
  ticker = setInterval(tick, TICK_MS)
}

function stopTicker() {
  if (ticker) clearInterval(ticker)
  ticker = null
}

// --- phases ------------------------------------------------------------------

function startWork() {
  phase = 'WORK'
  setMenuFor('WORK')
  target = Date.now() + WORK_MS
  closeOverlays()
  if (workWin && !workWin.isDestroyed()) workWin.showInactive()
  log('WORK started, ends', new Date(target).toLocaleTimeString())
  startTicker()
  broadcast()
}

function startBreak() {
  phase = 'BREAK'
  setMenuFor('BREAK')
  target = Date.now() + BREAK_MS
  log('BREAK started, ends', new Date(target).toLocaleTimeString())
  openOverlays()
  startTicker()
  broadcast()
}

function stopAll() {
  // Only reachable from the work window. There is deliberately no way to reach
  // this during a break.
  phase = 'IDLE'
  setMenuFor('IDLE')
  target = 0
  stopTicker()
  closeOverlays()
  broadcast()
  log('stopped')
}

// --- the break screen ---------------------------------------------------------

function openOverlays() {
  closeOverlays()
  for (const display of screen.getAllDisplays()) {
    const { x, y, width, height } = display.bounds // bounds, NOT workArea: this
    // includes the menu bar and dock strip, so both get covered.
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      backgroundColor: '#000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      fullscreenable: false,
      // Without this, macOS refuses to place a window over the menu bar and quietly
      // shoves it down by the menu bar height — leaving a live, clickable menu bar
      // strip across the top of the "black" screen. Verified: requested @0,0, got @0,34.
      enableLargerThanScreen: true,
      // Deliberately NOT `fullscreen: true` — native fullscreen puts the window on
      // its own Space, which is exactly the thing you can swipe away from.
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    })

    win.setAlwaysOnTop(true, 'screen-saver', 1)
    wireEmergencyExit(win)
    win.loadFile('break.html')
    win.once('ready-to-show', () => {
      win.show()
      win.setBounds({ x, y, width, height }) // re-assert after show; the constructor
      // bounds are still constrained on macOS.
      // This MUST come after show(): set before the window exists on screen, macOS
      // drops the collection behaviour and the overlay never reaches the Space of an
      // app running in native fullscreen. Verified — it was silently absent there.
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      win.focus()
      if (VERIFY && overlays[0] === win) require('./verify.js').onFirstOverlayShown(win, log)
    })
    log('overlay', `${width}x${height}@${x},${y}`, 'level=screen-saver')
    overlays.push(win)
  }
  app.focus({ steal: true })
}

function closeOverlays() {
  clearEscHold()
  for (const w of overlays) {
    if (w && !w.isDestroyed()) {
      w.setClosable(true)
      w.destroy()
    }
  }
  overlays = []
}

// --- emergency exits ----------------------------------------------------------
// Three layers, because an app that covers the whole screen and cannot be quit is
// a genuine foot-gun.

function clearEscHold() {
  if (escTimer) clearTimeout(escTimer)
  escTimer = null
  escStartedAt = 0
}

/**
 * Layer 1 — hold Escape.
 * `before-input-event` fires in the MAIN process, so a dead renderer does not take
 * the escape hatch down with it. A keydown listener inside the page would be gone
 * exactly when it is needed.
 */
function wireEmergencyExit(win) {
  const wc = win.webContents

  wc.on('before-input-event', (_event, input) => {
    if (input.key !== 'Escape') return
    if (input.type === 'keyDown') {
      if (escTimer) return // already counting; ignore auto-repeat
      escStartedAt = Date.now()
      escTimer = setTimeout(() => forceQuit('escape held'), ESC_HOLD_MS)
      sendEsc(true)
    } else if (input.type === 'keyUp') {
      clearEscHold()
      sendEsc(false)
    }
  })

  // Layer 3 — watchdog. If the overlay's page dies or wedges, tear everything down
  // rather than leave a black rectangle nobody can dismiss.
  wc.on('render-process-gone', (_e, details) => forceQuit(`overlay renderer gone: ${details.reason}`))
  win.on('unresponsive', () => forceQuit('overlay unresponsive'))
}

function sendEsc(holding) {
  for (const w of overlays) {
    if (w && !w.isDestroyed()) w.webContents.send('deepwork:esc', { holding, holdMs: ESC_HOLD_MS })
  }
}

function forceQuit(reason) {
  log('FORCE QUIT —', reason)
  exiting = true
  clearEscHold()
  stopTicker()
  closeOverlays()
  app.exit(0)
}

// --- menus --------------------------------------------------------------------
// WHY THE MENU AND NOT A QUIT GUARD: blocking `before-quit` during a break also
// swallows Ctrl+C, because Chromium handles SIGINT itself and routes it through the
// same quit path — Node's `process.on('SIGINT')` never gets a look in. Removing the
// Quit MENU ITEM instead disables Cmd+Q at the source (on macOS that key is bound to
// the menu item) while leaving every terminal signal free to kill the app.

function setMenuFor(nextPhase) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      nextPhase === 'BREAK'
        ? [{ label: 'Deep Work', submenu: [{ role: 'hide' }] }] // deliberately no Quit
        : [{ role: 'appMenu' }, { role: 'editMenu' }]
    )
  )
}

// --- app lifecycle ------------------------------------------------------------

function createWorkWindow() {
  workWin = new BrowserWindow({
    width: 440,
    height: 420,
    resizable: false,
    maximizable: false,
    backgroundColor: '#0b0b0d',
    title: 'Deep Work',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  workWin.loadFile('work.html')
  workWin.on('closed', () => {
    workWin = null
  })
  workWin.webContents.on('did-finish-load', () => {
    broadcast()
    if (VERIFY) require('./verify.js').onWorkWindowShown(workWin, log)
  })
}

app.whenReady().then(() => {
  createWorkWindow()

  // Layer 2 — the dead-man switch. Needs no window at all, so it still works if
  // every renderer in the app is gone.
  const ok = globalShortcut.register(KILL_ACCELERATOR, () => forceQuit('kill shortcut'))
  log(ok ? `kill switch armed: ${KILL_ACCELERATOR}` : `WARNING: could not register ${KILL_ACCELERATOR}`)

  // Waking from sleep: recompute immediately instead of waiting for the next tick.
  // If the work target passed while asleep, this goes straight to the break.
  powerMonitor.on('resume', () => {
    log('resumed from sleep')
    if (phase !== 'IDLE') tick()
  })

  app.on('activate', () => {
    if (!workWin) createWorkWindow()
  })

  if (AUTOSTART) startWork()
})

ipcMain.on('deepwork:start', () => {
  if (phase === 'IDLE') startWork()
})
ipcMain.on('deepwork:stop', () => {
  if (phase === 'WORK') stopAll()
})

// Ctrl+C in the terminal, and closing the terminal window (SIGHUP), must always kill
// the app — including mid-break. Without this, the break guard above swallows the
// signal and leaves an invisible process still blacking the screen every 90 minutes.
// A deliberate terminal signal is a conscious act, unlike the Cmd+Q the guard blocks.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => forceQuit(signal))
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopTicker()
})

app.on('window-all-closed', () => {
  if (phase !== 'BREAK') app.quit()
})
