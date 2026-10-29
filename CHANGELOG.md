# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `/archmap:export` command and `scripts/export.mjs`: Mermaid (flowchart, erDiagram, sequenceDiagram), PlantUML, Markdown summary and static SVG exports from the model, and PNG when headless Chromium is present. Exports are always clean (no issues); exit 1 invalid model, 2 usage or unreadable, 3 no Chromium for png.
- Repository scaffold: plugin manifest, local development marketplace, design brief (`docs/design.md`), CI skeleton.
