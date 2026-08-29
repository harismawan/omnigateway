/**
 * The tokens `codecIoFree.test.ts` scans for, present only as prose.
 *
 * Its sibling `transportProbe.ts` proves the scanner fires; this proves it does
 * not fire on a mention. Both halves are needed and they fail in opposite
 * directions: a scanner that never matched would report every plugin entry as
 * clean, and one that matched comment text would report the repository's own
 * docblocks as leaks — `scripts/dead-exports.ts` records that three instruments
 * here have read comment text as evidence about code, which is why its own rule
 * is that a source-reading instrument strips comments before it counts anything.
 *
 * So: this file talks about fetch( and new Request( and XMLHttpRequest and
 * WebSocket and import( at length, in a block comment, and calls none of them.
 */

// A trailing mention too, because `//` at a line start is the easy case and the
// hole that was found last time was a comment after code: fetch( and import(.
export const MENTIONS_ONLY = true; // WebSocket, XMLHttpRequest, new Request(
