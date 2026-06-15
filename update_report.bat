@echo off
cd /d "%~dp0"

echo === [1/5] Fetch daily quotes (last 7 days, skip existing/holidays) ===
node scripts\fetch_daily.mjs --backfill 7
if errorlevel 1 goto :fail

echo === [2/5] Fetch ex-rights reference prices ===
node scripts\fetch_exrights.mjs --backfill 7
if errorlevel 1 goto :fail

echo === [3/5] Fetch market indices ===
node scripts\fetch_index.mjs
if errorlevel 1 goto :fail

echo === [4/5] Build report ===
node scripts\build_report.mjs
if errorlevel 1 goto :fail

echo Done. Opening report...
start "" "%~dp0docs\index.html"

echo === [5/5] Commit and push ===
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo No changes to commit.
) else (
  git commit -m "Daily update (manual)"
  git push
  if errorlevel 1 (
    echo *** push failed - run "git push" manually later ***
    pause
  )
)
::pause
exit /b 0


:fail
echo.
echo *** FAILED - see error above ***
pause
exit /b 1
