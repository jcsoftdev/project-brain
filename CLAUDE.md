<!-- project-brain:start -->
# Project: project-brain

This project is indexed with [project-brain](https://github.com/jcsoftdev/project-brain).

## project-brain MCP

You have access to the `project-brain` MCP server for codebase knowledge retrieval.

### Available Tools

- `search_context` — semantic search across indexed project knowledge
- `add_knowledge` — manually add context chunks
- `list_modules` — see all indexed modules
- `get_module` — retrieve all chunks for a module
- `delete_knowledge` — remove chunks by source
- `check_health` — verify embedding service and index status

### Usage

When answering questions about this codebase, always run `search_context` first to find semantically relevant context before reading files directly.

### Project Context

- **Project ID**: project-brain
- **Stack**: TypeScript — package manager: bun

## Module Documentation

Detected modules:
- --skip-index
- openspec
- src
- templates
- tests

For each module stub in docs/modules/:
1. Read the stub file.
2. Fill in each section (Purpose, Key Files, Dependencies, Data Flow, Gotchas, Last Updated).
3. Call add_knowledge with the filled content, source: "docs/modules/<name>.md",
   tags: ["module", "<name>"].
Do this automatically when you open a project session and a stub is unfilled.


<!-- project-brain:end -->
