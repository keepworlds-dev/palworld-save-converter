/**
 * A few small DOM helpers. The page is built once and then updated in place, rather than
 * re-rendered: re-creating the inputs on every change would drop focus and caret position
 * while someone is typing a Steam ID.
 */
import type { Strings } from "./strings";

type Attrs = Record<string, string | boolean | number | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

/** Replace all children. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function show(el: HTMLElement, visible: boolean): void {
  el.hidden = !visible;
}

/** Copy text and flip the button label to "Copied" briefly. */
export function copyButton(t: Strings, getText: () => string, label = t.copy): HTMLButtonElement {
  const btn = h("button", { type: "button", class: "btn btn-outline btn-sm" }, label);
  let timer = 0;
  btn.addEventListener("click", () => {
    void navigator.clipboard?.writeText(getText()).then(() => {
      btn.textContent = t.copied;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (btn.textContent = label), 1500);
    });
  });
  return btn;
}

/**
 * Text to paste elsewhere (a path, a config line) plus a Copy button.
 *
 * The button carries a word, not just an icon: most readers are seeing these paths for the
 * first time and may not recognise a lone icon as "copy". It is always visible because
 * touch screens have no hover.
 */
export function copyField(t: Strings, text: string): HTMLElement {
  const code = h("code", { class: "copy-text" });
  // Allow wrapping right after separators: breaking anywhere would split LOCALAPPDATA in the
  // middle and look like the path itself is broken.
  text.split(/(?<=[\\/=])/).forEach((part, i) => {
    if (i > 0) code.append(h("wbr"));
    code.append(part);
  });
  return h("div", { class: "copy-field" }, code, copyButton(t, () => text));
}

/** A numbered list of steps; `copy` is text that step says to paste somewhere verbatim. */
export function stepList(steps: { text: string; copy?: string }[], t: Strings): HTMLOListElement {
  return h(
    "ol",
    { class: "step-list" },
    ...steps.map((s, i) =>
      h(
        "li",
        {},
        h("span", { class: "step-num" }, `${i + 1}.`),
        h("span", { class: "step-body" }, h("span", {}, s.text), s.copy ? copyField(t, s.copy) : null),
      ),
    ),
  );
}

export function alertBox(kind: "error" | "warn"): {
  root: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
} {
  const title = h("p", { class: "alert-title" });
  const body = h("div", { class: "alert-body" });
  const root = h("div", { class: `alert alert-${kind}`, role: kind === "error" ? "alert" : "status" }, title, body);
  root.hidden = true;
  return { root, title, body };
}

function readDirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/**
 * Recursively read a dropped directory.
 *
 * Two traps, both only visible on big worlds:
 *   - `readEntries` returns at most 100 entries per call and must be called until it
 *     returns an empty array. Calling it once means worlds with many players **silently
 *     miss** some player files; the conversion still runs, and whoever was dropped finds
 *     out the next day.
 *   - Dropped `File`s always have an empty `webkitRelativePath`, while `findWorlds` and the
 *     worker both rely on it to find their way. Filling in the real path makes the picker
 *     and drag-and-drop go through the same code afterwards.
 */
async function walkEntry(entry: FileSystemEntry, prefix: string, out: File[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    out.push(file);
    return;
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await readDirEntries(reader);
    if (batch.length === 0) break;
    await Promise.all(batch.map((e) => walkEntry(e, path, out)));
  }
}

/**
 * Turn a drop event into a file list. A `DataTransferItemList` becomes invalid once the
 * event handler yields, so entries must be collected **synchronously** before recursing.
 */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of dt.items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  // Without webkitGetAsEntry, fall back to the flat file list: users can still select every
  // file inside the world directory and drop them, they just have to go into it first.
  if (entries.length === 0) return [...dt.files];

  const out: File[] = [];
  await Promise.all(entries.map((entry) => walkEntry(entry, "", out)));
  return out;
}

let inputSeq = 0;

/**
 * A drop zone. The `<input>`s live inside it, so the whole block is both the drop target
 * and the picker trigger.
 *
 * `primary` marks the main path for this step: the folder button is solid and the loose
 * files option is a text link. Two equal buttons side by side make people guess which one
 * to press, while almost everyone needs only one.
 */
export function dropZone(opts: {
  label: string;
  filesLabel: string;
  hint: string;
  primary?: boolean;
  onFiles: (files: File[]) => void;
}): { root: HTMLElement; setBusy: (busy: boolean) => void } {
  const id = `pick-${++inputSeq}`;
  const filesId = `${id}-files`;

  // Always clear the input's value, and do it **before** calling onFiles: otherwise, on the
  // path beginners hit most ("picked the wrong folder level"), picking the same folder again
  // fires no change event and the click appears to do nothing.
  const pick = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = "";
    opts.onFiles(picked);
  };

  // `webkitdirectory` is non-standard but implemented by all major browsers. Browsers
  // without it degrade to a plain multi-file picker, which is what `multiple` is for
  // (on phones neither main browser supports it, and that is the path they take).
  const folderInput = h("input", { id, type: "file", multiple: true, class: "sr-only", onchange: pick });
  folderInput.setAttribute("webkitdirectory", "");
  folderInput.setAttribute("directory", "");
  // A second input **without** webkitdirectory picks files, not a folder. Community guides
  // are full of "send me Level.sav and the .sav files in Players", so plenty of people only
  // have loose files and no folder to pick. `classifyWorldFile` understands that shape.
  const filesInput = h("input", {
    id: filesId,
    type: "file",
    multiple: true,
    accept: ".sav",
    class: "sr-only",
    onchange: pick,
  });

  const icon = h("span", { class: "drop-icon", "aria-hidden": "true" });
  const root = h(
    "div",
    { class: "drop-zone" },
    folderInput,
    filesInput,
    icon,
    // The trigger is a <label>: the browser forwards the click to the visually hidden input,
    // and keyboard focus lands on the input itself.
    h("label", { for: id, class: `btn btn-lg ${opts.primary ? "btn-primary" : "btn-outline"}` }, opts.label),
    h("span", { class: "muted small" }, opts.hint),
    h("label", { for: filesId, class: "link-muted small" }, opts.filesLabel),
  );

  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    root.classList.add("over");
  });
  root.addEventListener("dragleave", () => root.classList.remove("over"));
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    root.classList.remove("over");
    if (!e.dataTransfer) return;
    // Reading can fail: OneDrive / iCloud placeholder files and files locked by the game make
    // one file() call reject, and Promise.all rejects as a whole. Without catching it the UI
    // shows no reaction at all, and the user thinks the drop did not register.
    void filesFromDrop(e.dataTransfer).then(opts.onFiles, () => opts.onFiles([]));
  });

  return { root, setBusy: (busy) => icon.classList.toggle("spin", busy) };
}
