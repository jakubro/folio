# Ridge conventions

What the ridge folder's documents are, and the rules they keep. Each fenced block is a declaration folio reads for this folder and everything below it.

## Stations

A station is a page under `stations/`, carrying its status, its owner and when it was last calibrated as labelled lines.

```yaml folio
kinds:
  station:
    where: stations/*.md
    fields:
      status: {from: label}
      owner: {from: label}
      calibrated: {from: label, type: date}
```

## Rules

An active station needs someone answering for it.

```yaml folio
rules:
  owned:
    query: select path from kind.station where status = 'active' and owner is null
    message: An active station has no owner
```

## Attention

A station is calibrated at least every six months.

```yaml folio
attention:
  calibration:
    query: >
      select path, strftime(calibrated, '%d %B %Y') as last from kind.station
      where status = 'active' and calibrated < date '2026-05-01'
    message: Calibration due - last done {last}
```
