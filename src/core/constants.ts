// COOP_HOST_GUID is the placeholder UID the host gets in a co-op (invite-code) world.
// A dedicated server does not recognise it, which is exactly why the host character
// disappears after a move, and why this converter exists. The value is hard-coded by
// the game.
//
// It lives in a leaf module on purpose: `index.ts` spawns a Worker, and the worker side
// pulls in the vendor GVAS parser at the top level. Anything that only needs this
// constant must not drag that module graph along with it.
//
// So this file must not import anything.
export const COOP_HOST_GUID = "00000000000000000000000000000001";
