<h1 align="center">BetterDiscord Addon Analyzer</h1>

<p align="center">
  <a href="#overview">Overview</a> |
  <a href="#the-report">The Report</a> |
  <a href="#what-it-measures">What It Measures</a> |
  <a href="#running-locally">Running Locally</a> |
  <a href="#how-it-works">How It Works</a> |
  <a href="#development">Development</a>
</p>

<p align="center">
  Static analysis of every addon in the official <a href="https://betterdiscord.app/">BetterDiscord</a> store,
  <br/>
  turned into a weekly report for maintainer decision-making.
  <br/>
  <br/>
  <a href="https://betterdiscord.github.io/AddonAnalyzer/" target="_blank">
    <img src="https://img.shields.io/badge/report-live-green?labelColor=0c0d10&color=3a71c1&style=for-the-badge&logo=googleanalytics&logoColor=3a71c1" alt="Live Report"/>
  </a>
  <a href="https://github.com/BetterDiscord/AddonAnalyzer/actions/workflows/analyze.yml" target="_blank">
    <img src="https://img.shields.io/github/actions/workflow/status/BetterDiscord/AddonAnalyzer/analyze.yml?branch=main&labelColor=0c0d10&color=3a71c1&style=for-the-badge&logo=github&logoColor=3a71c1" alt="Weekly Analysis"/>
  </a>
  <a href="https://betterdiscord.app/invite" target="_blank">
    <img src="https://img.shields.io/badge/discord-join-green?labelColor=0c0d10&color=7289da&style=for-the-badge&logo=discord&logoColor=7289da" alt="Chat"/>
  </a>
  <a href="LICENSE" target="_blank">
    <img src="https://img.shields.io/github/license/BetterDiscord/AddonAnalyzer?labelColor=0c0d10&color=3a71c1&style=for-the-badge" alt="License"/>
  </a>
</p>

## Overview

BetterDiscord's plugin API carries years of legacy surface, its addons reach deep into Discord's internals, and its renderer would love a tighter Content Security Policy. Deciding what can be changed, deprecated, or removed requires knowing what addons *actually do* — not guessing.

This tool downloads the full official store corpus (~200 plugins, ~150 themes), parses every addon, and produces aggregate answers: how much each `BdApi` member is used, which Discord internals the ecosystem depends on, which remote hosts addons reach, and where the fragile or risky patterns are. The output is data for weighing changes before they ship — **it is not a linter for addon authors**, and its heuristics measure things like readability and coupling, not addon safety (the store's normal review process covers that).

## The Report

The self-contained HTML report is regenerated and published weekly: **[betterdiscord.github.io/AddonAnalyzer](https://betterdiscord.github.io/AddonAnalyzer/)**

Alongside the report, a dated snapshot of every run lands in [`history/`](history/), which powers the report's week-over-week deltas and trend sparklines — so a deprecation campaign or migration effort can be watched actually working.

## What It Measures

| Report section | The question it answers |
|---|---|
| BdApi usage | How much is each API member used, and by how many plugins? What's the blast radius of changing it? |
| Discord internals reliance | Which webpack module keys/stores do addons look up, and which methods do they patch? What breaks when Discord updates? |
| `require()` usage | Which modules flow through the require polyfill, and which plugins need migrating before it can be retired? |
| Environment coupling | Who touches `process`, `DiscordNative`, and friends directly? Which React APIs in use break on a React upgrade? |
| Network hosts | Which hosts do addons fetch, connect to, and reference from CSS — i.e., what would a real CSP allowlist need? |
| Meta health | Do addons carry well-formed meta blocks? Which fields are conventions vs. actually parsed? |
| Security signals | `innerHTML`/`eval` usage, self-installing plugins, and bundled/packed code that resists reading |

Static analysis is conservative by design: values only a running plugin could know are reported as dynamic rather than guessed, so counts are floors, not estimates.

## Running Locally

Requires [Bun](https://bun.sh) and network access (the corpus is downloaded from the store API, and theme `@import` chains are resolved live).

```sh
bun install
bun run analyze   # refresh the addon cache if stale, run all analyses, write results/ and the report
bun run report    # regenerate results/report.html from existing results without re-analyzing
bun run clear     # drop the addon cache to force a fresh download
```

A full run takes a couple of minutes. Everything under `results/` is a regenerable snapshot of the latest run; only `history/` is tracked in git.

## How It Works

Two layers:

1. **Pipeline** — downloads and caches the store corpus, runs every analysis per addon, then aggregates per-addon → per-author → global summary, and renders the report.
2. **AST engine** — parses each plugin with [meriyah](https://github.com/meriyah/meriyah) and runs declarative rules over a single walk. An alias tracker resolves the ecosystem's real-world patterns (`const Api = BdApi`, destructuring, `new BdApi("Name")` instances) so usage counts survive indirection, and a small constant-folding evaluator with scope tracking resolves computed values like ``fetch(`${BASE}/api/${version}`)`` down to their static hosts. Themes go through text rules instead of the parser.

The weekly [GitHub Actions workflow](.github/workflows/analyze.yml) pins the downloaded corpus per ISO week, commits a history snapshot on the scheduled run, and deploys the report to GitHub Pages.

## Development

Architecture details, engine conventions, and the accumulated footguns live in [AGENTS.md](AGENTS.md) — read it before touching the rules or the evaluator. The short version:

```sh
bunx tsc --noEmit && bunx eslint src   # the verification pass; keep both green
```

Analysis changes should be verified empirically against the corpus (synthetic edge-case snippets plus grep ground truth on real addons), not just by type-checking. Parse errors across the corpus should stay at zero.

## License

[Apache-2.0](LICENSE)
