---
type: Gotcha
title: mockRejectedValueOnce builds its rejected promise eagerly
description: Adding an await to production code can fail an unrelated test as an unhandled rejection.
tags: [testing, bun, mocks]
resource: ../tests/parser/wasm.test.ts
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T00:00:00Z }
---

# Symptom

A test that was passing starts failing with an unhandled rejection reported at
the *mock setup line*, not at the call site — while the behaviour under test is
demonstrably still correct (the log line proving the error was handled is right
there in the output).

# Why

`spyOn(x, "y").mockRejectedValueOnce(new Error(...))` constructs the rejected
promise when the mock is **configured**, not when it is called. Until the code
under test invokes the mock, that promise sits with no handler attached.

That is harmless when the call happens in the same tick. It stops being harmless
the moment production code gains a real `await` before the call — here,
`ensureGrammar` began reading grammar bytes before calling `Language.load`, which
is required to load from `/$bunfs` in a compiled binary. Several microtask turns
passed with the rejection unhandled, and Bun flagged it.

# Fix

Build the rejection inside the call so it is tied to the invocation it simulates:

```ts
const loadSpy = spyOn(Language, "load").mockImplementationOnce(() =>
  Promise.reject(new Error("forced load failure"))
);
```

# The general shape

A failing test after a production change does not automatically mean the change
is wrong. Read *where* the failure is reported: an error attributed to a line
that only sets up a fixture is a signal about the fixture, not the code. Here the
production change was not only correct but necessary — see
[Language.load ignores Bun's /$bunfs](/gotchas/language-load-ignores-bunfs.md).
