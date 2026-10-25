select station, round(sum(rain_mm), 1) as rain_mm, max(wind_kmh) as gust_kmh
from '../data/daily.csv'
group by station
order by rain_mm desc
