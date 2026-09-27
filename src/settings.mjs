import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Settings are deliberately limited to non-sensitive tuning values. Session tokens,
 * Authorization headers and room passwords are never accepted or persisted here.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  pollIntervalMs: 2_000,
  // After joining: a room below this population is left again once it stops growing. It is deliberately
  // not a condition for entering a room - the browser list is only a snapshot, and the target rooms sit
  // at 1/10 until their invitations are accepted.
  minPlayers: 5,
  // After joining: this many invitations with fewer than `minPlayers` players means the room is stuck.
  maxInvites: 50,
  // Rooms are conventionally named with markers like `10钢`; only matching names are attempted.
  nameKeywords: Object.freeze(["10刚", "10钢"]),
  // After joining: how long a room below the player floor may go without gaining a single player before
  // it is abandoned. 0 leaves such a room on the first check instead of waiting at all. Kept short: a
  // room that is not filling is not worth sitting in, and a long wait is indistinguishable from a stall.
  stallTimeoutMs: 30_000,
  // Which full theme (token set) the renderer paints with; "custom" pairs with accentColor below.
  themeId: "dark",
  // Purely cosmetic: the accent colour the renderer paints its controls with.
  accentColor: "#4cc2e0"
});

const LIMITS = Object.freeze({
  pollIntervalMs: { min: 500, max: 60_000 },
  minPlayers: { min: 0, max: 10 },
  maxInvites: { min: 0, max: 500 },
  stallTimeoutMs: { min: 0, max: 1_800_000 }
});

const FORBIDDEN = /token|password|authorization|secret/i;

/** Accepts an array or a comma/space separated string, capped so a stray paste cannot go wild. */
export function sanitizeKeywords(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、\s]+/) : [];
  return list
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0 && item.length <= 24)
    .slice(0, 12);
}

function coerce(value, { min, max }) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Drops unknown, forbidden and out-of-range values so a corrupt file cannot steer the search. */
export function sanitizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const [key, limits] of Object.entries(LIMITS)) {
    if (FORBIDDEN.test(key)) continue;
    const value = coerce(source[key], limits);
    if (value !== undefined) settings[key] = value;
  }
  settings.nameKeywords = source.nameKeywords === undefined
    ? [...DEFAULT_SETTINGS.nameKeywords]
    : sanitizeKeywords(source.nameKeywords);
  settings.accentColor = /^#[0-9a-f]{6}$/i.test(source.accentColor ?? "")
    ? source.accentColor.toLowerCase()
    : DEFAULT_SETTINGS.accentColor;
  settings.themeId = ["dark", "graphite", "cyber", "aurora", "mint", "butter", "sakura", "custom"]
    .includes(source.themeId) ? source.themeId : DEFAULT_SETTINGS.themeId;
  return settings;
}

/**
 * One-off fixes for values written by an older build.
 *
 * The stall timeout used to default to 180s and to mean "wait forever" at 0, which together made the
 * tool look stuck in a half-empty room. A stored 180s was almost always the untouched old default
 * rather than a deliberate choice, so it moves to the new default; any other value the user typed is
 * left exactly as it is. Applied only when reading from disk, so saving 180s later still sticks.
 */
function migrateLegacySettings(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (raw.stallTimeoutMs === 180_000) return { ...raw, stallTimeoutMs: DEFAULT_SETTINGS.stallTimeoutMs };
  return raw;
}

export class SettingsStore {
  #filePath;

  constructor(filePath) {
    this.#filePath = filePath;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  static at(userDataPath) {
    return new SettingsStore(path.join(userDataPath, "settings.json"));
  }

  /** A missing or unreadable file falls back to defaults instead of blocking startup. */
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.#filePath, "utf8"));
      this.settings = sanitizeSettings(migrateLegacySettings(raw));
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    return this.settings;
  }

  async update(partial) {
    this.settings = sanitizeSettings({ ...this.settings, ...(partial ?? {}) });
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
    return this.settings;
  }
}
