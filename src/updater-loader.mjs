/**
 * Resolves `autoUpdater` out of a loaded `electron-updater` module.
 *
 * electron-updater is CommonJS, and under ESM its named exports are not dependable: `import("electron-updater")`
 * exposes `default`, `AppUpdater`, `NsisUpdater`, … but **not** `autoUpdater`. Destructuring that missing
 * name yields `undefined` without throwing, which then blows up one line later as
 * "Cannot set properties of undefined" - and in the 0.1.1 build that exception aborted the whole startup
 * chain before any IPC handler was registered, leaving a window that could do nothing at all.
 *
 * Both shapes are accepted here, and the caller is expected to treat `undefined` as "no updater" rather
 * than as an error.
 */
export function resolveAutoUpdater(loaded) {
  return loaded?.autoUpdater ?? loaded?.default?.autoUpdater ?? undefined;
}
