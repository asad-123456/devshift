# Security policy

DevShift stops and starts Windows services and processes, so security reports get priority.

## Report a vulnerability

Don't open a public issue. Instead, open the repository's **Security** tab and choose **Report a vulnerability**. This creates a private advisory that only the maintainers can see.

Include the affected version or commit, your Windows version and build, steps to reproduce, and what an attacker could achieve.

## Supported versions

DevShift is pre-1.0. Fixes go into the `main` branch and the latest release only.

## Scope

In scope:

- Bypassing the IPC sender or input checks, or escaping the renderer sandbox
- Making DevShift or its native helper act on a service, process, or power plan that the user didn't approve
- Privilege escalation through DevShift or its helper
- Tampering with the recovery journal to trigger unintended actions
- Leaking command lines, Node control keys, or other secrets into snapshots, logs, history, or the UI
- Weaknesses in the authenticated Node shutdown channel

Out of scope:

- Attacks that already require administrator rights, or code running as the same Windows user
- Vulnerabilities in Electron, Node.js, or .NET themselves. Report those upstream, and tell us if DevShift needs an update.
