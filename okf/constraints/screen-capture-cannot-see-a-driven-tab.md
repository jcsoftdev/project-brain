---
type: Constraint
title: A recorder that captures the screen cannot record a browser it drives through CDP
description: The Chrome MCP drives a tab that is not frontmost, so the page reports outerWidth 0 and screen capture films whatever else is in front — a take that looks fine in every tool result and contains the wrong window.
tags: [skills, brain-record, browser, cdp, recording]
resource: ../templates/skills/brain-record/assets/record.mjs
sources:
  - resource: ../templates/skills/brain-record/references/pitfalls.md
    title: The measured evidence, kept next to the engine it justifies
status: stable
generated: { by: "human:jcsoftdev", at: 2026-09-08T00:00:00Z }
---

# What must hold

The thing that captures pixels and the thing that drives the browser must agree on
*where the page is*. Capture the PAGE (CDP `Page.startScreencast`) when a tool drives the
page. Capture the SCREEN only when a human drives it and the window is genuinely in
front.

# What breaks when it does not

The Chrome MCP automates a tab that is **not frontmost**. Measured, on a page it had just
loaded successfully:

    visibilityState: "hidden"
    hasFocus: false
    outerWidth: 0   outerHeight: 0
    screenX: 0      screenY: 0

Two failures follow, and neither announces itself.

The window rect read from the page is all zeros, so a crop computed from it is `0x0`.
That one at least fails loudly once something divides by it.

The second does not fail at all. `ffmpeg -f avfoundation` films the foreground, and the
foreground is a different tab — or a different application entirely. Capturing one frame
of each attached display, while the automation reported every click as successful,
confirmed the driven page was on neither. Every tool result says the flow worked. The
file contains someone's Slack.

This is not tuning. There is no framerate, no device index and no crop that makes a
screen recorder see a hidden tab.

# Why it is easy to get wrong

Screen capture wins the two comparisons a person naturally runs. It gives a true constant
30fps where CDP screencast is variable and caps near 25, and it composes with a browser
that already holds the user's logged-in sessions. Both are real advantages, and both are
irrelevant if the recording contains the wrong window. Visibility is the question that
decides the engine, and it is not the question that comes to mind first.

# The tell in the previous engine

`branch-demo`, this skill's predecessor, shipped a Python script whose job was to score
frames and drop the ones where another window had come to the front. That filter was
never a feature. It was a workaround for this constraint, written by someone who saw the
symptom and treated it as noise to be cleaned rather than as evidence the engine was
pointed at the wrong surface. In a page screencast no other window can ever appear, and
the entire filtering stage disappears.
