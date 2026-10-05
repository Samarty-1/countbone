# Countbone client presentation

A one-page, scrolling pitch site with working mock-ups of the phone app and
the dashboard. Open `index.html` in any browser; no build step or server needed.

What you can try on the page:

- **Hero:** a shelf is counted live; click a blue (unsure) box to confirm it.
- **Phone app:** record, change walking pace, scan a bay label, go offline,
  swipe through reviews, start a recount.
- **Dashboard:** open a count and step through its frames; approve
  adjustments as counter / manager / admin; add catalog photos; verify a
  signed claim pack, then change one byte and verify again; filter bay labels.

All numbers in the mock-ups are example data. Test results quoted on the page
come from `docs/PRODUCT.md`.

Before sending it to a client, fill in the `[SGD __]` prices and connect the
booking form.

## Connecting "Book a pilot" to Google Forms

The form at the bottom of the page sends requests to a Google Form, and the
replies land in a Google Sheet. Nothing is emailed.

1. Open https://script.google.com, click **New project**, paste in
   `create-pilot-form.gs`, and click **Run**. Allow access when asked.
2. Open **Execution log**. It shows the form link, the replies sheet link, and
   a `const PILOT_FORM={...};` block.
3. In `index.html`, search for `const PILOT_FORM=` and replace that block
   (down to its closing `};`) with the one from the log.

How it sends:

- **Opened as its own page** (a local file, GitHub Pages or any website): the
  request goes straight into the Google Form without leaving the page.
- **Shown inside another page** (for example a claude.ai artifact preview):
  the page can't post on its own there, so it opens the Google Form with every
  answer already filled in, and the visitor presses Submit.
- **Not connected yet**: the page says so and sends nothing.
