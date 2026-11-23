[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/rrmmllnn/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/rrmmllnn/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

# csv-reader-speed-01-run-20261121

A faster drop-in for make.fun's own csv-reader 1.0.0: it reads broken CSV files
and returns exactly csv-reader's answer — `{columns, rows, errors}` — for every
case, in less CPU time.

## How it works

`main.ts` (the house driver) reads every case from `/input/cases.json`, answers
each one with `run()` from `solve.js`, and writes `/output/answers.json`.

`solve.js` keeps csv-reader's exact broken-row policy (BOM dropped, LF/CRLF
records, stray CRs reported and dropped, quoted fields with `""` escapes and
LF-normalised line breaks inside them, junk after a closing quote reported,
unterminated quotes read again as unquoted, short/long rows padded or cut to
the first record's width) but takes the fast path wherever the text allows it:

- a record that is one physical line with no quote and no stray CR is split in
  one native `String.split(',')` call;
- an unquoted field is one slice up to the next comma or LF, with stray CRs
  dropped in a single bounded pass over the slice;
- a quoted field with no doubled quote and no line break inside it is one slice
  up to its closing quote.

Only records that actually hold quotes, stray CRs, or multi-line quoted fields
pay for the careful per-character paths.

## Run locally

```sh
node main.ts
```

with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` standing in for `/input` and
`/output` outside a container. Node 22 or later, no dependencies to install.

## License

MIT — see [LICENSE](LICENSE).
