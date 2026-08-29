'use strict'

/**
 * The only bridge between the main process and the pages.
 * Note the direction: ticks and hold-to-exit state flow OUT to the page. The page
 * can start and stop a work block, and nothing else — it has no way to end a break.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deepwork', {
  onTick: (cb) => ipcRenderer.on('deepwork:tick', (_e, payload) => cb(payload)),
  onHold: (cb) => ipcRenderer.on('deepwork:hold', (_e, payload) => cb(payload)),
  start: () => ipcRenderer.send('deepwork:start'),
  stop: () => ipcRenderer.send('deepwork:stop'),
})
