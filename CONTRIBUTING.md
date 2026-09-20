# Contributing

## Setup

```bash
git clone https://github.com/Samarty-1/countbone
cd countbone
pip install -e ".[api,dev]"
pytest
ruff check .
```

## The rule

**If a change requires editing `pipeline.py`, it is probably a plugin.**

The backbone is capture → pre-process → detect → identify → count → output, and it should stay
small enough to read in one sitting. New capabilities attach through hooks. See
[docs/PLUGINS.md](docs/PLUGINS.md).

New stage backends (detectors, identifiers) are welcome and belong in `stages/`, registered in
that module's `BACKENDS` dict.

## Tests

Every change needs a test. The suite runs in under a minute and needs no model weights, no GPU and
no network: `countbone.demo` renders synthetic footage with known ground truth, so the pipeline can
be scored rather than merely executed.

- `test_pipeline.py` — end-to-end, including a regression guard on count accuracy
- `test_counting.py` — the tracker and the three counting strategies
- `test_plugins.py` — the plugin contract: ordering, isolation, hooks
- `test_detect_identify.py` — the swappable middles
- `test_store.py`, `test_config.py`, `test_api.py`, `test_cli.py`

If you change counting behaviour, say what the demo error moved from and to.

## Style

- `ruff check .` must pass; line length 100.
- Comments explain *why*, not *what*. If a number was chosen for a reason, write the reason.
- Be honest in docs about what does not work. The review queue exists because the detector is
  fallible; pretending otherwise makes the product worse.
