---
title: Calibration
owner: Station crew
interval: quarterly
instruments: [anemometer, rain gauge, thermometer]
last:
  anemometer: spring
  thermometer: summer
---

# Calibration

Each instrument is checked against a reference at the start of its season.

## Thermometer

Immerse the probe beside the reference in an ice bath and read both after five minutes.

```sh
logger calibrate --probe t1 --reference 0.00 --tolerance 0.15
```

## Rain gauge

Pour 500 ml through the funnel and count the tips. The logger flags a gauge as off when `tips != expected`.

```c
int expected = volume / gauge->tip_volume;
if (gauge->tips != expected && --retries > 0) {
    flag_gauge(gauge);
}
```

## Anemometer

Spin the cups by hand and confirm the logger reads above zero within a second.
