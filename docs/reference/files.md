# Files

| Kind | Extensions |
|---|---|
| Page | `.md`, `.markdown` |
| Diagram | `.mermaid`, `.mmd` |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.avif`, `.bmp`, `.ico` |
| Query | `.sql` |
| Data | `.csv`, `.tsv`, `.jsonl`, `.ndjson`, `.parquet`, `.json`, `.yaml`, `.yml`, `.sqlite`, `.sqlite3`, `.db`, `.duckdb` |

Other files are neither listed nor served. Data and query files are listed only while the tree's table button is pressed. Dot-files, dot-folders and `node_modules` are never listed, and a folder is listed only when something inside it can be shown. A folder lists its folders first, then its files, by name - digits read as numbers, case ignored - a file's name compared before its extension, so `step-2.md` comes before `step-10.md`, `plan.md` before `plan.b.md` and `notes.csv` before `notes.md`; <kbd>←</kbd> and <kbd>→</kbd> step through the pages in that order.
