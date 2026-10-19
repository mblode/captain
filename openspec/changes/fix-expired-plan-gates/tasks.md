## 1. Implementation
- [x] 1.1 `screenGate` in `view.ts` detects a plan menu and a question menu (with its question as the hint) from the last 25 screen lines, and returns nothing for a scrolled-away or empty screen
- [x] 1.2 `rowOf` falls back to the screen gate only when no feed gate is pending, and `fleetRows` reads the screen only for those workspaces
- [x] 1.3 `captain approve` presses `enter` on an `onScreen` plan, sends no feed reply, and logs the note
- [x] 1.4 `captain approve` refuses with `PLAN_MENU_UNRECOGNISED`, writing no log, when option 1 is not the bypass approval
- [x] 1.5 `captain reject` presses `escape` on an `onScreen` plan, then sends the feedback
- [x] 1.6 Tests cover 1.1 to 1.5; `npm test`, `tsc --noEmit` and `ultracite check` pass
- [x] 1.7 AGENTS.md "Surface" section describes the screen fallback
