# pi-codex-usage

Pi extension providing `/codex-usage` for the currently selected Codex slot. It reports primary/secondary quota windows, subscription credits when supplied, and earned reset credits. In TUI/RPC mode, `/codex-usage` opens options to refresh usage or redeem a reset. Redemption presents a credit picker followed by explicit confirmation. `/codex-usage redeem` remains a shortcut to that flow.

The command uses the active model's `openai-codex` or `openai-codex-N` provider ID, resolves auth for that exact provider through Pi's model registry, and calls ChatGPT's usage and reset-credit endpoints. Redemption lets you choose a credit (soonest-expiring first), rechecks the selected credit after confirmation and the slot/account immediately before the consume request, and never retries an uncertain consume request automatically. Provider responses are capped at 64 KiB before JSON parsing. It does not read or write `auth.json` directly, cache credentials, or fall back to another account. Pi's auth resolver may refresh an expired OAuth credential as part of normal provider authentication.

## Install

From GitHub:

```sh
pi install git:github.com/a209m/pi-codex-usage
```

From npm (after publication):

```sh
pi install npm:@a209m/pi-codex-usage
```

For development from a local checkout:

```sh
pi install ~/.pi/agent/packages/pi-codex-usage
```

Install only one source at a time; remove an existing local-path or GitHub install before adding the npm package to avoid duplicate commands. Run `pi list` to find the existing source, then `pi remove <source>`.

This extension requires Pi's extension command and model-registry authentication APIs, an active `openai-codex` or numbered `openai-codex-N` provider, and that slot's ChatGPT OAuth login. Numbered providers come from a compatible multi-account setup; this package does not create them. It calls unofficial ChatGPT usage/reset endpoints, which may change without notice; this is not an OpenAI-endorsed integration. Test `/codex-usage` after Pi or provider updates. A reset consumes one earned credit only after you select a credit and confirm.

Run tests with `npm test` from this directory. No runtime dependencies required.

## License and attribution

MIT licensed; see [LICENSE](./LICENSE). The reset flow was adapted with reference to `pi-usage`, and numbered-slot behavior was informed by `pi-multi-codex`. Their copyright and MIT notices are preserved in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
