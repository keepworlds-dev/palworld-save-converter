/**
 * A few map types missing from the vendor type table that we have verified ourselves.
 * **Imported only for its side effect.**
 *
 * When gvas meets a map that is not in its type table, it guesses a type, keeps going and
 * leaves a warning. The UI shows those warnings verbatim and tells the user that "passed
 * verification" proves nothing about the output. That warning has to stay for structures
 * nobody has seen, but the entries below are triggered by every 1.0 save that has been
 * through a dungeon; a fresh level-4 save already produces 270 of them. Asking every user
 * to decide whether to convert while staring at hundreds of opaque lines would make the
 * warning meaningless.
 *
 * Each entry has two independent grounds:
 *   1. oMaN-Rod/palworld-save-tools `paltypes.py` (the community fork that kept up with
 *      1.0) registers exactly this type;
 *   2. a real 1.0 save was run through parse -> write back and reproduced byte for byte,
 *      and none of these maps contain player IDs, so the conversion never touches them.
 *
 * `../vendor/gvas.js` is not edited: it is a verbatim GPL copy (see CONTRIBUTING.md). This
 * only adds **missing** keys to the table it exports and never touches keys upstream
 * already has. If upstream adds one of them, `scripts/check.mjs` will say to delete the
 * matching entry here.
 */
import { PALWORLD_TYPE_HINTS } from "../vendor/gvas.js";

export const VERIFIED_TYPE_HINTS: Readonly<Record<string, string>> = {
  ".worldSaveData.GuildExtraSaveDataMap.Key": "Guid",
  ".worldSaveData.GuildExtraSaveDataMap.Value": "StructProperty",
  ".worldSaveData.DungeonSaveData.DungeonSaveData.RewardSaveDataMap.Key": "Guid",
  ".worldSaveData.DungeonSaveData.DungeonSaveData.RewardSaveDataMap.Value": "StructProperty",
};

const table = PALWORLD_TYPE_HINTS as Record<string, string>;
for (const [path, type] of Object.entries(VERIFIED_TYPE_HINTS)) {
  if (!(path in table)) table[path] = type;
}
