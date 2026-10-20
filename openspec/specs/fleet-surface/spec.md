# fleet-surface Specification

## Purpose
How `captain status`, `approve` and `reject` find the gates (plan and question menus) that need the human across the fleet.

## Requirements

### Requirement: Gates survive feed expiry
The surface SHALL report a plan or question gate for a workspace whose feed item has expired
when the agent's screen still shows the Claude plan or question menu.

#### Scenario: Expired plan item, menu on screen
- **WHEN** the workspace's newest `exitPlan` feed item is `expired` and its screen shows "Would you like to proceed?"
- **THEN** `captain status` lists it under NEEDS YOU with a plan gate

#### Scenario: Approve an on-screen plan
- **WHEN** `captain approve <id> --note "…"` targets an on-screen plan whose option 1 is the highlighted bypass approval
- **THEN** captain presses `enter` in that workspace and logs the note

#### Scenario: Unrecognised plan menu
- **WHEN** option 1 of the on-screen plan menu is not the bypass approval
- **THEN** `captain approve` exits with `PLAN_MENU_UNRECOGNISED`, presses nothing and logs nothing

#### Scenario: Reject an on-screen plan
- **WHEN** `captain reject <id> --note "…"` targets an on-screen plan
- **THEN** captain presses `escape` and then sends the feedback to the agent
