@echo off
cd /d "%~dp0"

echo === [1/3] Fetch daily quotes (last 7 days, skip existing/holidays) ===
node scripts\fetch_daily.mjs --backfill 7
if errorlevel 1 goto :fail

echo === [2/3] Fetch ex-rights reference prices ===
node scripts\fetch_exrights.mjs --backfill 7
if errorlevel 1 goto :fail

echo === [3/3] Build report ===
node scripts\build_report.mjs
if errorlevel 1 goto :fail

echo.
echo Done. Opening report...
start "" "%~dp0docs\index.html"
exit /b 0

:fail
echo.
echo *** FAILED - see error above ***
pause
exit /b 1
