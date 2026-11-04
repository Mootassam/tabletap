@echo off
title TableTap
cd /d "%~dp0"
python -c "import flask, waitress, segno, PIL, tzdata" 2>nul || (
  echo Installing TableTap requirements...
  python -m pip install -r requirements.txt
)
set TABLETAP_OPEN_BROWSER=1
python server.py
pause
