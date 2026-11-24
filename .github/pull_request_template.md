## What changed

## Why

## How I tested it

- [ ] `npm.cmd test`
- [ ] `npm.cmd run test:windows` (engine, IPC, renderer, or Node runtime changes)
- [ ] `npm.cmd run test:windows:power` (power plan changes)
- [ ] `npm.cmd run test:windows:service` from an administrator terminal (native service changes)
- [ ] Tried the change in the running app

## Safety checklist

- [ ] The renderer makes no Windows calls, and new IPC methods check the sender and validate input
- [ ] Identity, fingerprints, and state are checked again right before each change to Windows
- [ ] No command lines, tokens, or secrets reach snapshots, logs, history, or the UI
- [ ] README and docs are updated if behavior changed
