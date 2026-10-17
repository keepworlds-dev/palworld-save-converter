/**
 * The converter page: co-op <-> dedicated-server save conversion. **Everything runs in the
 * browser**; no network request ever carries save bytes away.
 *
 * # Both directions share one set of steps
 *
 * The two flows have the same skeleton (pick world -> identify character -> decide target
 * ID -> convert and download); only the wording and step 3 differ. Moving to a server, the
 * new ID is assigned by that server and has to be obtained; moving back to co-op, the host
 * ID is always `...0001`, so step 3 becomes "create an empty co-op world to land in". So
 * there is one flow, and the mode is just a piece of state.
 *
 * # Why all four steps are always visible
 *
 * The steps depend on each other in order, but **cards do not appear as you progress**:
 * many readers have not yet decided to touch their save, and a single card cannot answer
 * "how many things will this ask me to do". Locked steps render as `todo`: title and hint
 * stay readable, only the controls are unavailable. `todo` uses `inert`, not just pointer
 * blocking, so keyboard users cannot tab into a step that looks greyed out.
 *
 * # State is cleared by replacing the worker, not by resetting fields one by one
 *
 * Redoing any step must clear everything after it. The real danger is not UI state but
 * **bytes**: convert world A, then pick world B, and if A's output is still around the
 * download would be B's directory wrapped around A's Level.sav, with A's self-check passing.
 * So every world read terminates the old client and creates a new one; the old worker and
 * its bytes disappear, and late replies from it can never land.
 */
import {
  COOP_HOST_GUID,
  createPalSaveClient,
  detectNewGuid,
  findWorlds,
  isAborted,
  type GuidCandidate,
  type LoadedWorld,
  type MigrateReport,
  type PalSaveClient,
  type WorldChoice,
  type WorldDescription,
} from "../core/index";
import { guid32 } from "../core/paths";
import { extractSteamId64, serverPlayerId, steamIdFromWorldDir } from "../core/player-id";
import { alertBox, copyButton, copyField, dropZone, h, setChildren, show, stepList } from "./dom";
import { HOSTED_URL, dateTime, en, num } from "./strings";
import "./style.css";

const t = en;
document.documentElement.lang = t.lang;

type Mode = "toServer" | "toCoop";
type Busy = "reading" | "converting" | "packing" | null;
type StepState = "todo" | "active" | "done";
/**
 * Errors carry the step they belong to. A read failure happens while the world is still
 * empty and step 4 is `todo`; rendering it there would hide "picked the wrong folder
 * level", the most common mistake.
 */
type StepError = { step: 1 | 4; message: string };

/**
 * The folder each direction's step 1 looks for. The co-op one uses the environment-variable
 * form: both the Windows file picker and Explorer's address bar expand it, so copy, paste,
 * Enter gets you there without showing hidden folders or clicking through AppData.
 */
const SAVE_PATHS = {
  toServer: "%LOCALAPPDATA%\\Pal\\Saved\\SaveGames",
  toCoop: "Pal/Saved/SaveGames/0",
} as const;

const SOURCE_URL = "https://github.com/keepworlds-dev/palworld-save-converter";

/** A 32-character hex GUID; accepts a pasted file name (with .sav) or hyphenated form. */
function normalizeGuid(input: string): string | null {
  const g = guid32(input.trim().replace(/\.sav$/i, ""));
  return /^[0-9A-F]{32}$/.test(g) ? g : null;
}

/** Short form for narrow places: first and last 6 characters. The full value is in `title`. */
function shortGuid(guid: string): string {
  return `${guid.slice(0, 6)}…${guid.slice(-6)}`;
}

// ---- State ----

const state = {
  mode: "toServer" as Mode,
  choices: null as WorldChoice[] | null,
  /** World dir -> name and in-game day from LevelMeta. Worlds that could not be read are absent. */
  descriptions: new Map<string, WorldDescription>(),
  world: null as LoadedWorld | null,
  hostGuid: "",
  newGuidInput: "",
  steamInput: "",
  /**
   * The Steam ID read off the save path and filled in for the user. While the input equals
   * it, the UI says so, so people know they can change it; once they edit it, picking
   * another world no longer overwrites what they typed.
   */
  autoSteamId: null as string | null,
  /** With -nosteam the ID derivation runs one extra mixing round; see core/player-id.ts. */
  noSteamServer: false,
  detected: null as GuidCandidate[] | null,
  busy: null as Busy,
  error: null as StepError | null,
  result: null as MigrateReport | null,
  /** Characters converted after the host. Crossplay friends have to join the server to get an ID; this is their path. */
  friendResults: [] as MigrateReport[],
  friendInputs: {} as Record<string, string>,
  /**
   * Player files the world holds **now**, as returned by the worker after each migration.
   * Chained friend conversions must check collisions against this, not the stale roster
   * from load time. The host run does not use it; see `targetTaken`.
   */
  livePlayerGuids: [] as string[],
};

/** The current world's worker. A new world means a new one; see the header. */
let client: PalSaveClient | null = null;
/**
 * The packed zip, cached. Clicking download twice does not re-run the zip (crc32 plus two
 * full copies over tens to hundreds of MB), and the object URL has a clear point of
 * release: revoking right after `a.click()` makes downloads **fail silently** in Safari and
 * in Firefox with large blobs, where the dispatch is asynchronous.
 */
let download: { url: string; name: string } | null = null;

// ---- Derived values ----

function derive() {
  const s = state;
  const steamId = extractSteamId64(s.steamInput);
  const steamFromPath = s.autoSteamId !== null && s.steamInput.trim() === s.autoSteamId;
  const steamDerived = steamId !== null ? serverPlayerId(steamId, s.noSteamServer) : null;

  // A typed or detected ID **wins over** a computed one: the former is a file name that
  // really exists on the server, the latter is a derivation. When both exist they are
  // compared; that is the only self-check this path has.
  const manualGuid = normalizeGuid(s.newGuidInput);
  const manualInvalid = s.newGuidInput !== "" && manualGuid === null;
  const steamAgrees =
    manualGuid !== null && steamDerived !== null ? manualGuid === steamDerived : null;

  const targetGuid = s.mode === "toServer" ? (manualGuid ?? steamDerived) : COOP_HOST_GUID;
  const sameAsHost = targetGuid !== null && targetGuid === s.hostGuid;
  const guidCollides = s.mode === "toServer" && sameAsHost;

  // The target collides with **another** player in this world. Not checking would delete
  // someone silently: the migration's "remove throwaway character" layer drops every entry
  // keyed to the target, and verification still passes. Checked against the roster at
  // load time, because the host run always starts from the untouched world.
  const targetTaken =
    s.mode === "toServer" &&
    targetGuid !== null &&
    targetGuid !== s.hostGuid &&
    s.world !== null &&
    s.world.playerGuids.includes(targetGuid);
  const takenBy =
    targetTaken && s.world
      ? (s.world.summary.players.find((p) => p.guid32 === targetGuid)?.nickname ?? targetGuid)
      : null;

  const hostIsAlreadyCoop = s.mode === "toCoop" && s.hostGuid === COOP_HOST_GUID;
  const targetValid = targetGuid !== null && !sameAsHost && !targetTaken;

  // Each step depends on the one before. The convert button reads these too, so a card can
  // never look locked while its button is clickable.
  const step1Done = s.world !== null;
  const step2Done = step1Done && !!s.hostGuid && !hostIsAlreadyCoop;
  const step3Done = step2Done && targetValid;
  const states: StepState[] = [
    step1Done ? "done" : "active",
    !step1Done ? "todo" : step2Done ? "done" : "active",
    !step2Done ? "todo" : step3Done ? "done" : "active",
    !step3Done ? "todo" : s.result ? "done" : "active",
  ];

  return {
    steamId,
    steamFromPath,
    manualGuid,
    manualInvalid,
    steamAgrees,
    targetGuid,
    guidCollides,
    takenBy,
    hostIsAlreadyCoop,
    targetValid,
    step3Done,
    states,
  };
}

const packName = () => state.world?.worldName ?? "world";

// ---- Static layout ----

const app = document.getElementById("app") as HTMLElement;

const mobileCopy = copyButton(t, () => window.location.href, t.copyLink);
const mobileHint = h(
  "div",
  { class: "mobile-hint card" },
  h("p", { class: "strong" }, t.mobileTitle),
  h("p", { class: "muted" }, t.mobileBody),
  mobileCopy,
);

const modeInputs = {} as Record<Mode, HTMLInputElement>;
const modeFieldset = h(
  "fieldset",
  { class: "modes" },
  h("legend", {}, t.modeTitle),
  ...(["toServer", "toCoop"] as const).map((m) => {
    const input = h("input", { type: "radio", name: "direction", class: "sr-only", value: m });
    input.checked = m === state.mode;
    input.addEventListener("change", () => onModeChange(m));
    modeInputs[m] = input;
    return h(
      "label",
      { class: "mode" },
      input,
      h("span", { class: "mode-title" }, t.modes[m].title),
      h("span", { class: "muted" }, t.modes[m].desc),
    );
  }),
);

function stepCard(index: number) {
  const badge = h("span", { class: "badge" }, String(index));
  const title = h("h2", { class: "step-title" });
  const hint = h("p", { class: "muted" });
  const body = h("div", { class: "step-content" });
  const root = h(
    "section",
    { class: "step" },
    badge,
    h("div", { class: "step-main" }, h("div", { class: "step-head" }, title, hint), body),
  );
  return { root, badge, title, hint, body, index };
}

const cards = [stepCard(1), stepCard(2), stepCard(3), stepCard(4)];

// Step 1
const wherePanel = h("div", { class: "where" });
const step1Row = h("div", { class: "step1-row" });
/** Rebuilt by renderMode, because its label depends on the direction. */
let worldDrop: ReturnType<typeof dropZone>;
const worldList = h("div", { class: "world-list" });
const step1Error = alertBox("error");
const loadedLine = h("p", {});
const undecodedAlert = alertBox("error");
const warningsAlert = alertBox("warn");
cards[0].body.append(step1Row, worldList, step1Error.root, loadedLine, undecodedAlert.root, warningsAlert.root);

// Step 2
const playerList = h("div", { class: "player-list" });
const alreadyCoop = h("p", { class: "danger" }, t.alreadyCoopHost);
cards[1].body.append(playerList, alreadyCoop);

// Step 3 (to server)
const steamInputEl = h("input", {
  id: "steam-id",
  class: "input mono",
  spellcheck: "false",
  autocomplete: "off",
  inputmode: "numeric",
  placeholder: "7656…",
});
const steamDesc = h("p", { class: "muted small" });
const resultBox = h("div", { class: "result-box" });
const resultIcon = h("span", { class: "result-icon", "aria-hidden": "true" });
const resultGuid = h("code", { class: "mono strong" });
const resultNote = h("span", { class: "small" });
resultBox.append(
  h("span", { class: "muted small" }, t.resultLabel),
  h("span", { class: "result-line" }, resultIcon, resultGuid),
  resultNote,
);
const steamAgreesEl = h("p", {}, t.steamAgrees);
const steamDisagrees = alertBox("error");
steamDisagrees.title.textContent = t.steamDisagreesTitle;
steamDisagrees.body.textContent = t.steamDisagreesBody;

const serverDrop = dropZone({
  label: t.pickServerFolder,
  filesLabel: t.pickFiles,
  hint: t.dropHint,
  onFiles: (files) => onPickServerWorld(files),
});
const detectedEl = h("p", {});
const manualInputEl = h("input", { id: "new-guid", class: "input mono", spellcheck: "false", autocomplete: "off" });
const manualDesc = h("p", { class: "muted small" });
const fallback = h(
  "details",
  { class: "fold" },
  h("summary", {}, t.fallbackTitle),
  h(
    "div",
    { class: "fold-body" },
    h("p", { class: "muted" }, t.fallbackHint),
    serverDrop.root,
    detectedEl,
    h("div", { class: "field" }, h("label", { for: "new-guid", class: "strong" }, t.manualLabel), manualInputEl, manualDesc),
  ),
);
const noSteamInput = h("input", { type: "checkbox" });
// -nosteam sits in the last fold: most hosted servers do not use it, and a visible checkbox
// only makes people hesitate over whether to tick it.
const advanced = h(
  "details",
  { class: "fold-plain" },
  h("summary", { class: "muted small" }, t.advancedTitle),
  h(
    "label",
    { class: "check" },
    noSteamInput,
    h("span", {}, h("span", { class: "strong" }, t.noSteamLabel), h("span", { class: "muted" }, t.noSteamHint)),
  ),
);
const toServerStep3 = h(
  "div",
  { class: "stack" },
  h("div", { class: "field" }, h("label", { for: "steam-id", class: "strong" }, t.steamLabel), steamInputEl, steamDesc),
  resultBox,
  steamAgreesEl,
  steamDisagrees.root,
  fallback,
  advanced,
);
const toCoopStep3 = stepList(
  t.flow.toCoop.prepare.map((text) => ({ text })),
  t,
);
cards[2].body.append(toServerStep3, toCoopStep3);

// Step 4
const convertBtn = h("button", { type: "button", class: "btn btn-primary btn-lg" });
const step4Error = alertBox("error");
const resultPanel = h("div", { class: "done card" });
cards[3].body.append(h("div", {}, convertBtn), step4Error.root, resultPanel);

// Rail
const railSteps = h("ol", { class: "rail-steps" });
const railWorld = h("div", {});
const rail = h(
  "aside",
  { class: "rail" },
  h("div", { class: "card" }, h("p", { class: "muted small strong" }, t.railTitle), railSteps),
  h("div", { class: "card" }, h("p", { class: "muted small strong" }, t.railWorldTitle), railWorld),
);

const footer = h(
  "footer",
  { class: "footer muted small" },
  h("p", {}, t.footer.credits, " ", h("a", { href: SOURCE_URL, rel: "noopener" }, t.footer.source), "."),
  h("p", {}, h("a", { href: HOSTED_URL, rel: "noopener" }, t.footer.maintained)),
);

app.append(
  h(
    "header",
    { class: "page-head" },
    h("h1", {}, t.title),
    h("p", { class: "lead" }, t.lead),
    h("p", { class: "trust" }, t.trust),
  ),
  mobileHint,
  modeFieldset,
  h("div", { class: "layout" }, h("div", { class: "steps" }, ...cards.map((c) => c.root)), rail),
  footer,
);

// ---- Inputs ----

steamInputEl.addEventListener("input", () => {
  state.steamInput = steamInputEl.value;
  dropResult();
  update();
});
manualInputEl.addEventListener("input", () => {
  state.newGuidInput = manualInputEl.value;
  dropResult();
  update();
});
noSteamInput.addEventListener("change", () => {
  state.noSteamServer = noSteamInput.checked;
  dropResult();
  update();
});
convertBtn.addEventListener("click", () => void onConvert());

// ---- Actions ----

/** Record a failure on a step. Aborted reads are swallowed: they only mean the user moved on. */
function failAt(step: StepError["step"], err: unknown) {
  if (isAborted(err)) return;
  state.error = { step, message: err instanceof Error ? err.message : String(err) };
}

function dropDownload() {
  if (download) URL.revokeObjectURL(download.url);
  download = null;
}

/** The migration output is void: drop the report and any packed zip. */
function dropResult() {
  state.result = null;
  state.friendResults = [];
  state.friendInputs = {};
  dropDownload();
  renderResult();
}

/** Start over: replace the worker too, so the previous world's bytes stay nowhere. */
function resetWorld() {
  client?.terminate();
  client = null;
  dropResult();
  Object.assign(state, {
    error: null,
    choices: null,
    descriptions: new Map(),
    world: null,
    hostGuid: "",
    newGuidInput: "",
    steamInput: "",
    autoSteamId: null,
    noSteamServer: false,
    detected: null,
    livePlayerGuids: [],
  });
  steamInputEl.value = "";
  manualInputEl.value = "";
  noSteamInput.checked = false;
  renderWorldList();
  renderPlayers();
}

/** Switching direction means starting over: nothing read for the previous flow is valid for the new one. */
function onModeChange(next: Mode) {
  if (next === state.mode) return;
  state.mode = next;
  resetWorld();
  renderMode();
  update();
}

async function loadWorld(choice: WorldChoice) {
  // Replace the worker first, then read. This voids the previous world's bytes, the
  // previous output, and any old request still in flight (it rejects with ABORTED).
  client?.terminate();
  const c = createPalSaveClient();
  client = c;

  dropResult();
  Object.assign(state, { error: null, world: null, hostGuid: "", newGuidInput: "", detected: null, busy: "reading" });
  manualInputEl.value = "";
  renderPlayers();
  update();

  try {
    const { world: loaded } = await c.load(choice.files, choice.name || null);
    if (loaded === null) {
      state.error = { step: 1, message: t.noLevelSav };
      return;
    }
    state.world = loaded;
    state.livePlayerGuids = loaded.playerGuids;
    // The Steam ID step 3 needs is right in the path the user just picked
    // (SaveGames/<SteamID64>/<world>/). Fill it in when recognised.
    const fromPath = state.mode === "toServer" ? steamIdFromWorldDir(choice.dir) : null;
    if (fromPath !== null) {
      const p = state.steamInput.trim();
      if (p === "" || p === state.autoSteamId) {
        state.steamInput = fromPath;
        steamInputEl.value = fromPath;
      }
      state.autoSteamId = fromPath;
    }
    // In a co-op save, preselect the host's placeholder UID: it is why this tool exists.
    // The reverse direction has no such anchor; take the first non-host character and let
    // the user recognise theirs by name and level.
    const players = loaded.summary.players;
    const host = players.find((p) => p.guid32 === COOP_HOST_GUID);
    state.hostGuid =
      state.mode === "toServer"
        ? (host?.guid32 ?? players[0]?.guid32 ?? "")
        : (players.find((p) => p.guid32 !== COOP_HOST_GUID)?.guid32 ?? "");
  } catch (err) {
    failAt(1, err);
  } finally {
    if (client === c) state.busy = null;
    renderPlayers();
    renderWorldList();
    update();
  }
}

async function onPickWorld(files: File[]) {
  if (files.length === 0) return;
  resetWorld();

  const found = findWorlds(files);
  if (found.length === 0) {
    state.error = { step: 1, message: t.noLevelSav };
    update();
    return;
  }
  // With only one world, do not make people click again; list them only when there are
  // several (someone dropped the whole SaveGames).
  state.choices = found;
  renderWorldList();
  if (found.length === 1) {
    await loadWorld(found[0]);
    return;
  }

  // With several worlds, read each LevelMeta first (about 2 KB, just name and in-game day).
  // **Worth waiting for**: directory names are hex, and picking the wrong world by name and
  // mtime alone goes unnoticed, at the cost of converting a different world. The describe
  // client takes the client slot: it holds no world bytes, and picking a world terminates
  // it in loadWorld, which is exactly the lifetime wanted.
  const c = createPalSaveClient();
  client = c;
  state.busy = "reading";
  update();
  try {
    const described = await c.describe(found.map((w) => ({ dir: w.dir, files: w.files })));
    if (client === c) state.descriptions = new Map(described.map((d) => [d.dir, d]));
  } catch (err) {
    // Missing names are not an error; the list falls back to directory names.
    if (!isAborted(err)) state.descriptions = new Map();
  } finally {
    if (client === c) state.busy = null;
    renderWorldList();
    update();
  }
}

// Synchronous, **no busy state**: findWorlds / detectNewGuid read names and mtimes only.
function onPickServerWorld(files: File[]) {
  if (files.length === 0 || !state.world) return;
  dropResult();
  state.error = null;
  // Accepts three shapes: the whole SaveGames (with several worlds, take the most recently
  // modified, i.e. the server the host just joined), one world directory, **or just the new
  // player file itself**, which is what the step 3 hint teaches people to look for.
  // So a missing Level.sav is not an error, only a narrower pool to search.
  const found = findWorlds(files);
  const pool = found.length > 0 ? found[0].files : files;
  const candidates = detectNewGuid(pool, state.world.playerGuids);
  state.detected = candidates;
  // Clear the previous ID even when nothing was found: otherwise the UI says "not found"
  // while convert still holds the previous server's ID and stays clickable, and the output
  // lands on the wrong ID with every self-check passing.
  state.newGuidInput = candidates.length > 0 ? candidates[0].guid : "";
  manualInputEl.value = state.newGuidInput;
  update();
}

async function onConvert() {
  const d = derive();
  const c = client;
  if (!c || !state.world || !d.step3Done || !d.targetGuid) return;
  state.busy = "converting";
  state.error = null;
  dropResult();
  update();
  try {
    const r = await c.migrate(state.hostGuid, d.targetGuid, true);
    state.result = r;
    state.livePlayerGuids = r.playerGuids;
  } catch (err) {
    failAt(4, err);
  } finally {
    if (client === c) state.busy = null;
    renderResult();
    update();
  }
}

/**
 * Convert one more character, chained onto those already converted. The worker folds each
 * migration into the world it holds, so this runs on the previous output rather than the
 * original bytes. Used by crossplay friends: their server IDs are not derived from Steam,
 * so they have to join once to get one.
 */
async function onConvertFriend(sourceGuid: string) {
  const c = client;
  const target = normalizeGuid(state.friendInputs[sourceGuid] ?? "");
  if (!c || target === null || state.busy !== null) return;
  if (target === sourceGuid || state.livePlayerGuids.includes(target)) return;

  state.busy = "converting";
  state.error = null;
  // The world changed, so any packed zip is void. The reports stay: those conversions happened.
  dropDownload();
  update();
  try {
    const r = await c.migrate(sourceGuid, target, false);
    state.friendResults = [...state.friendResults, r];
    state.livePlayerGuids = r.playerGuids;
  } catch (err) {
    failAt(4, err);
  } finally {
    if (client === c) state.busy = null;
    renderResult();
    update();
  }
}

async function onDownload() {
  const c = client;
  if (!c || !state.world || !state.result || state.busy !== null) return;
  state.error = null;
  try {
    if (!download) {
      // Packing also happens in the worker: buildZip runs crc32 over the whole world, which
      // on the main thread would freeze the page for seconds while the button still clicks.
      state.busy = "packing";
      update();
      const blob = await c.pack(packName());
      download = {
        url: URL.createObjectURL(blob),
        name: `${packName()}-${state.mode === "toServer" ? "server" : "coop"}.zip`,
      };
    }
    const a = document.createElement("a");
    a.href = download.url;
    a.download = download.name;
    a.rel = "noopener";
    // Attach before clicking: a detached <a> does not navigate in some browsers. The URL is
    // not revoked here; it lives with the cache until the world changes or the page closes.
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    failAt(4, err);
  } finally {
    if (client === c) state.busy = null;
    update();
  }
}

window.addEventListener("pagehide", () => {
  client?.terminate();
  dropDownload();
});

// ---- Rendering ----

/** Rebuild everything whose wording depends on the direction. */
function renderMode() {
  const m = state.mode;
  const f = t.flow[m];
  worldDrop = dropZone({
    label: f.pickFolder,
    filesLabel: t.pickFiles,
    hint: t.dropHint,
    primary: true,
    onFiles: (files) => void onPickWorld(files),
  });
  setChildren(
    wherePanel,
    h("p", { class: "strong" }, f.whereTitle),
    copyField(t, SAVE_PATHS[m]),
    stepList(f.where.map((text) => ({ text })), t),
    h("p", { class: "muted small" }, t.uploadPromptNote),
  );
  setChildren(step1Row, wherePanel, worldDrop.root);
  cards[0].title.textContent = f.step1Title;
  cards[0].hint.textContent = f.step1Hint;
  cards[1].title.textContent = t.step2Title;
  cards[1].hint.textContent = f.step2Hint;
  cards[2].title.textContent = f.step3Title;
  cards[2].hint.textContent = f.step3Hint;
  cards[3].title.textContent = t.step4Title;
  cards[3].hint.textContent = t.step4Hint;
  show(toServerStep3, m === "toServer");
  show(toCoopStep3, m === "toCoop");
}

/**
 * The world list, only when there are several. LevelMeta's world name comes first (the
 * directory name is hex nobody recognises); without it, the directory name plus in-game day
 * and last-modified time are what let people be sure which one they are picking.
 */
function renderWorldList() {
  const choices = state.choices;
  if (!choices || choices.length <= 1) {
    setChildren(worldList);
    return;
  }
  setChildren(
    worldList,
    h("p", { class: "strong" }, t.worldPickTitle),
    h("p", { class: "muted" }, t.worldPickHint),
    ...choices.map((c) => {
      const desc = state.descriptions.get(c.dir);
      const meta = [
        desc?.inGameDay != null ? t.worldDay(desc.inGameDay) : null,
        t.worldMeta(dateTime(c.lastModified)),
      ]
        .filter(Boolean)
        .join(" · ");
      return h(
        "button",
        { type: "button", class: "world", onclick: () => void loadWorld(c) },
        desc?.name ? h("span", { class: "strong" }, desc.name) : null,
        h("code", { class: desc?.name ? "mono muted small" : "mono small" }, c.name || c.dir),
        h("span", { class: "muted small" }, meta),
      );
    }),
  );
}

function renderPlayers() {
  const summary = state.world?.summary;
  if (!summary) {
    setChildren(playerList, h("p", { class: "muted" }, t.step2Placeholder));
    return;
  }
  setChildren(
    playerList,
    ...summary.players.map((p) => {
      const input = h("input", { type: "radio", name: "host", value: p.guid32 });
      input.checked = state.hostGuid === p.guid32;
      input.addEventListener("change", () => {
        state.hostGuid = p.guid32;
        dropResult();
        update();
      });
      return h(
        "label",
        { class: "player" },
        input,
        h(
          "span",
          { class: "player-main" },
          h("span", { class: "strong" }, t.characterOption(p.nickname, p.level ?? 0)),
          h("code", { class: "mono muted small", title: p.guid32 }, p.guid32),
        ),
        p.guid32 === COOP_HOST_GUID ? h("span", { class: "tag" }, t.hostIsCoop) : null,
      );
    }),
  );
}

let downloadBtn: HTMLButtonElement | null = null;
let friendButtons: Array<{ btn: HTMLButtonElement; ok: () => boolean }> = [];

/** The done panel. Rebuilt when a conversion finishes or is voided, not on every keystroke. */
function renderResult() {
  const r = state.result;
  downloadBtn = null;
  friendButtons = [];
  if (!r) {
    setChildren(resultPanel);
    show(resultPanel, false);
    return;
  }
  const m = state.mode;
  const f = t.flow[m];
  const summary = state.world?.summary;
  const nameOf = (guid: string) =>
    summary?.players.find((p) => p.guid32 === guid)?.nickname ?? shortGuid(guid);

  downloadBtn = h("button", { type: "button", class: "btn btn-primary btn-xl", onclick: () => void onDownload() });

  // The next steps come right here, with the world folder name filled in and copyable.
  const name = packName();
  const copies: Record<number, string> =
    m === "toServer" ? { 2: `DedicatedServerName=${name}` } : { 1: SAVE_PATHS.toServer };
  const next = stepList(
    f.next(name).map((text, i) => ({ text, copy: copies[i] })),
    t,
  );

  // Converting one more character. **Only in the forward direction**: going back to co-op
  // the target is the constant `...0001`, and only one character can hold it. Hidden when
  // the host is the only person in the world.
  const convertedFrom = new Set([r.oldGuid, ...state.friendResults.map((x) => x.oldGuid)]);
  const pendingFriends = (summary?.players ?? []).filter((p) => !convertedFrom.has(p.guid32));
  let friends: HTMLElement | null = null;
  if (m === "toServer" && (pendingFriends.length > 0 || state.friendResults.length > 0)) {
    friends = h(
      "div",
      { class: "section stack" },
      h("h3", {}, t.friendsTitle),
      h("p", { class: "muted" }, t.friendsHint),
    );
    if (pendingFriends.length === 0) {
      friends.append(h("p", { class: "muted" }, t.friendsNone));
    }
    for (const p of pendingFriends) {
      const input = h("input", {
        class: "input mono",
        spellcheck: "false",
        autocomplete: "off",
        "aria-label": t.manualLabel,
      });
      input.value = state.friendInputs[p.guid32] ?? "";
      const btn = h(
        "button",
        { type: "button", class: "btn btn-outline btn-sm", onclick: () => void onConvertFriend(p.guid32) },
        t.friendConvert,
      );
      const err = h("p", { class: "danger small" });
      const check = () => {
        const raw = state.friendInputs[p.guid32] ?? "";
        const target = normalizeGuid(raw);
        const taken = target !== null && state.livePlayerGuids.includes(target);
        const bad = raw !== "" && (target === null || taken);
        err.textContent = bad ? (taken ? t.friendTaken : t.invalidGuid) : "";
        show(err, bad);
        input.setAttribute("aria-invalid", String(bad));
        return target !== null && !taken;
      };
      input.addEventListener("input", () => {
        state.friendInputs[p.guid32] = input.value;
        btn.disabled = state.busy !== null || !check();
      });
      friendButtons.push({ btn, ok: check });
      friends.append(
        h(
          "div",
          { class: "friend card" },
          h("span", { class: "strong" }, t.characterOption(p.nickname, p.level ?? 0)),
          h("div", { class: "friend-row" }, input, btn),
          err,
        ),
      );
    }
  }

  setChildren(
    resultPanel,
    h("h3", { class: "ok" }, t.successTitle),
    h("p", { class: "muted" }, f.successBody(r.newGuid)),
    state.friendResults.length > 0
      ? h(
          "ul",
          { class: "friend-done" },
          ...state.friendResults.map((x) => h("li", {}, t.friendDone(nameOf(x.oldGuid), x.newGuid))),
        )
      : null,
    h("div", {}, downloadBtn),
    h("div", { class: "section stack" }, h("h3", {}, f.nextTitle), next),
    friends,
    h(
      "details",
      { class: "fold-plain" },
      h("summary", { class: "muted small" }, t.detailsToggle),
      h("p", { class: "muted small" }, t.detailsNote),
      // The per-layer report is English diagnostic output, like a log: shown verbatim.
      h("pre", { class: "report", lang: "en" }, r.report.join("\n")),
    ),
    h(
      "p",
      { class: "muted small hosted" },
      t.hostedLine.before,
      h("a", { href: HOSTED_URL, rel: "noopener" }, t.hostedLine.link),
      t.hostedLine.after,
    ),
  );
  show(resultPanel, true);
}

/** Sync every cheap, derived piece of the UI with state. */
function update() {
  const s = state;
  const d = derive();
  const summary = s.world?.summary ?? null;

  cards.forEach((c, i) => {
    const st = d.states[i];
    c.root.dataset.state = st;
    c.root.inert = st === "todo";
    if (st === "active") c.root.setAttribute("aria-current", "step");
    else c.root.removeAttribute("aria-current");
    c.badge.textContent = st === "done" ? "✓" : String(c.index);
  });

  // Step 1. The save location stays expanded until a world is read, then folds away so the
  // later steps are not pushed down.
  show(wherePanel, !s.world);
  step1Row.classList.toggle("split", !s.world);
  worldDrop.setBusy(s.busy === "reading");
  for (const b of worldList.querySelectorAll("button")) b.disabled = s.busy !== null;
  show(step1Error.root, s.error?.step === 1);
  if (s.error?.step === 1) {
    step1Error.title.textContent = t.readFailed;
    step1Error.body.textContent = s.error.message;
  }
  show(loadedLine, !!summary);
  if (summary) loadedLine.textContent = t.loadedWorld(packName(), summary.players.length, summary.palCount);
  // The parser's own anomalies are announced at step 1, not step 4: undecoded entries abort
  // the migration, and unknown structures mean "verification passed" proves nothing.
  show(undecodedAlert.root, !!summary && summary.undecoded > 0);
  if (summary && summary.undecoded > 0) {
    undecodedAlert.title.textContent = t.undecodedTitle;
    undecodedAlert.body.textContent = t.undecodedBody(summary.undecoded);
  }
  const showWarnings = !!summary && summary.undecoded === 0 && summary.warnings.length > 0;
  show(warningsAlert.root, showWarnings);
  if (summary && showWarnings) {
    warningsAlert.title.textContent = t.parserWarningsTitle;
    setChildren(
      warningsAlert.body,
      h("p", {}, t.parserWarningsBody(summary.warnings.length)),
      h("pre", { class: "report", lang: "en" }, summary.warnings.join("\n")),
    );
  }

  // Step 2
  for (const input of playerList.querySelectorAll<HTMLInputElement>("input[name=host]")) {
    input.checked = input.value === s.hostGuid;
  }
  show(alreadyCoop, d.hostIsAlreadyCoop);

  // Step 3
  const steamBad = s.steamInput.trim() !== "" && d.steamId === null;
  steamInputEl.setAttribute("aria-invalid", String(steamBad));
  steamDesc.textContent = steamBad ? t.steamInvalid : d.steamFromPath ? t.steamFromPath : t.steamHint;
  show(resultBox, s.mode === "toServer" && d.targetGuid !== null);
  if (d.targetGuid !== null) {
    resultBox.classList.toggle("bad", !d.targetValid);
    resultIcon.textContent = d.targetValid ? "✓" : "!";
    resultGuid.textContent = d.targetGuid;
    // Collision errors show here rather than under the manual field: the target may come
    // from the Steam derivation, and an error under an empty field would look like that
    // field was filled in wrong.
    resultNote.textContent = d.guidCollides
      ? t.guidCollides
      : d.takenBy !== null
        ? t.guidTakenByOther(d.takenBy)
        : d.manualGuid !== null
          ? t.resultFromManual
          : t.resultFromSteam;
  }
  show(steamAgreesEl, d.steamAgrees === true);
  show(steamDisagrees.root, d.steamAgrees === false);
  if (s.detected === null) {
    show(detectedEl, false);
  } else {
    show(detectedEl, true);
    detectedEl.textContent =
      s.detected.length === 0
        ? t.detectedNone
        : s.detected.length === 1
          ? t.detectedOne(s.detected[0].guid)
          : t.detectedMany(s.detected.length, s.detected[0].guid);
  }
  manualInputEl.setAttribute("aria-invalid", String(d.manualInvalid));
  manualDesc.textContent = d.manualInvalid ? t.invalidGuid : t.manualHint;

  // Step 4
  convertBtn.disabled = s.busy !== null || !d.step3Done;
  convertBtn.textContent = s.busy === "converting" ? t.converting : t.flow[s.mode].convert;
  show(step4Error.root, s.error?.step === 4);
  if (s.error?.step === 4) {
    step4Error.title.textContent = t.convertFailed;
    setChildren(step4Error.body, h("p", {}, t.convertFailedBody), h("code", { class: "mono small" }, s.error.message));
  }
  if (downloadBtn) {
    downloadBtn.disabled = s.busy !== null;
    downloadBtn.textContent = s.busy === "packing" ? t.packing : t.downloadZip;
  }
  for (const fb of friendButtons) fb.btn.disabled = s.busy !== null || !fb.ok();

  // Rail
  const titles = [t.flow[s.mode].step1Title, t.step2Title, t.flow[s.mode].step3Title, t.step4Title];
  setChildren(
    railSteps,
    ...d.states.map((st, i) =>
      h("li", { "data-state": st }, h("span", { class: "dot" }, st === "done" ? "✓" : String(i + 1)), titles[i]),
    ),
  );
  if (summary && s.world) {
    setChildren(
      railWorld,
      h("p", { class: "strong" }, packName()),
      h(
        "dl",
        { class: "stats" },
        ...(
          [
            [t.railPlayers, summary.players.length],
            [t.railPals, summary.palCount],
            [t.railGuilds, summary.guilds],
          ] as const
        ).flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, num(value))]),
      ),
      s.hostGuid
        ? h(
            "div",
            { class: "rail-host" },
            h("span", { class: "muted small" }, t.railHost),
            h("code", { class: "mono small", title: s.hostGuid }, shortGuid(s.hostGuid)),
            d.targetValid && d.targetGuid
              ? h("code", { class: "mono small", title: d.targetGuid }, `→ ${shortGuid(d.targetGuid)}`)
              : null,
          )
        : null,
    );
  } else {
    setChildren(railWorld, h("p", { class: "muted" }, t.railEmpty));
  }
}

renderMode();
renderPlayers();
renderResult();
update();
