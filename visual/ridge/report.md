# October report

The network logged {value: #totals#0.rain_mm} mm of rain in the first two weeks of October, most of it in three storms. The wettest station had <data value="queries/wettest.sql#0.rain_mm">52.6</data> mm, and the average temperature held at <data value="#totals#0.temp_c">9.4</data> °C.

```sql query totals
select round(sum(rain_mm), 1) as rain_mm, round(avg(temp_c), 1) as temp_c
from 'data/daily.csv'
```

## Rain by station

{table: queries/wettest.sql}

[North](stations/north.md) tops the table again; its gauge sits in the lee of the hut and reads a little high in a westerly.

## Daily rain

```vega-lite
{
  "data": {"url": "data/daily.csv"},
  "mark": {"type": "line", "point": true},
  "width": 560,
  "height": 220,
  "encoding": {
    "x": {"field": "date", "type": "temporal", "title": null},
    "y": {"field": "rain_mm", "type": "quantitative", "title": "Rain (mm)"},
    "color": {"field": "station", "type": "nominal", "title": "Station"}
  }
}
```

The storm of the 9th brought the month's heaviest day at every station.
