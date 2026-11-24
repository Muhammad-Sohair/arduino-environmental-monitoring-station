@echo off
title Environmental Monitoring Station - keep this window open
cd /d "%~dp0server"

set "PY="
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo.
  echo  Python is not installed. Get it from https://www.python.org/downloads/
  echo  and tick "Add python.exe to PATH" during install.
  echo.
  pause
  exit /b 1
)

if not exist "..\.venv\Scripts\python.exe" (
  echo Setting up for the first time, please wait...
  %PY% -m venv ..\.venv
)
"..\.venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r requirements.txt

rem open the dashboard in the browser a few seconds after the server starts
start "" cmd /c "timeout /t 4 >nul & start http://localhost:8000"

"..\.venv\Scripts\python.exe" server.py %*
pause
