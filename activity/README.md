# activity

Machine-written verification records. One file per day, plus a weekly digest.

These are not hand-edited. Each entry is produced by a scheduled workflow that
runs the test suite first and only writes the record when the suite passed:

| workflow | schedule | writes |
|---|---|---|
| `.github/workflows/daily.yml` | 06:17 UTC | `activity/YYYY-MM-DD.md` |
| `.github/workflows/nightly.yml` | 03:43 UTC | `activity/live/YYYY-MM-DD.md` |
| `.github/workflows/weekly.yml` | Mon 05:23 UTC | `activity/weekly/YYYY-Www.md` |

A day with no file means the run did not happen or the suite failed — that gap
is the point. The log is only as good as the test it gates on.
