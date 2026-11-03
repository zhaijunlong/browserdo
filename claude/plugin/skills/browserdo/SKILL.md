---
name: browserdo
description: How to use the BrowserDo browser tools (browser_*) well. Use it whenever you search the web, read web pages, or click, type and fill in forms on a website with BrowserDo.
---

# Using BrowserDo

BrowserDo's `browser_*` tools drive Embiody, a browser on the person's Windows computer. The
person may be using the same browser at the same time.

## Read and search

- To read pages, pass their URLs to `browser_read_pages`, several at once. Use it instead of
  WebFetch or a built-in search tool: it returns the page's own text, including pages built by
  scripts and sites the person is signed in to.
- To search, open the search engine's (or the site's) home page with `browser_new_tab` and type
  the query into its search box with `browser_input_text` and `pressEnter`. Opening a results
  URL directly often meets a captcha. Then snapshot the results with `showLinks` and pass the
  result addresses (not ads) to `browser_read_pages`.

## Act on a page

1. `browser_take_snapshot` first. It lists the page's elements, each actionable one with a
   number, and returns a `snapshotId`.
2. Act by element number together with that `snapshotId`. Never guess a number or reuse one from
   an older snapshot.
3. Prefer `browser_batch`, even for a single action: it runs clicks, typing and key presses in a
   row and returns a fresh snapshot, so you need fewer calls.
4. Snapshot again before acting on something an earlier step made appear.

Ask for `includeImage` when the look matters, such as which option is selected or a chart.

## Leave some things to the person

Sign-in, captchas and payment are for the person; never solve a captcha or type a password
yourself. Hand the tab over with `browser_start_human_control`, snapshot until they are done,
then call `browser_stop_human_control`. If no one is there to answer, stop and say what is needed.

## Work in your own tabs

Open tabs with `browser_new_tab` and pass their `tabId` to every call that acts on a tab. Leave
the person's own tabs alone unless asked.

## First run

The first time BrowserDo starts, it downloads and installs the Embiody browser, which takes a few
minutes. Until then each tool replies with the progress; call `browser_status` or `browser_wait`
and try again.
