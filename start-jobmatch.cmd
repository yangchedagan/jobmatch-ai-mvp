@echo off
setlocal
cd /d "%~dp0"
set PORT=5180
echo Starting JobMatch AI MVP...
echo If 5180 is busy, the server will automatically try the next port.
"C:\Program Files\nodejs\node.exe" server.js
pause
