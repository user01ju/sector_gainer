@echo off
cd /d "%~dp0"

echo === [1/4] Fetch daily quotes (last 7 days, skip existing/holidays) ===
node scripts\fetch_daily.mjs --backfill 7
if errorlevel 1 goto :fail

echo === [2/4] Fetch ex-rights reference prices ===
node scripts\fetch_exrights.mjs --backfill 7
if errorlevel 1 goto :fail

echo === [3/4] Build report ===
node scripts\build_report.mjs
if errorlevel 1 goto :fail

echo Done. Opening report...
start "" "%~dp0docs\index.html"

echo === [4/4] Commit and push ===
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
exit /b 0

:fail
echo.
echo *** FAILED - see error above ***
pause
exit /b 1
