# Practice test data

Sample files for the scripting practice path. All names and emails are fake.

| File | Used by |
| --- | --- |
| students.csv | C5 CSV Roster Report (2 rows have a blank email on purpose) |
| sample.log | C6 Log Parser |
| book.txt | C4 Word Counter |
| config.json | C8 JSON Config (copy it to output first, then edit the copy) |
| hosts.txt | C9 Ping Sweep (the last host is fake on purpose) |

In scripts, use the environment variables POLY-ISE sets in both Learning and Live mode:

- POLY_DATA - this folder (read-only in Learning mode)
- POLY_OUTPUT - a writable folder for anything your script saves

PowerShell: `Import-Csv "$env:POLY_DATA\students.csv"`
Python: `os.path.join(os.environ["POLY_DATA"], "students.csv")`
