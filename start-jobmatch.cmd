@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=5180"
set "QWEN_MODEL=qwen-plus"
set "QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1"
set "QWEN_TIMEOUT_MS=20000"
set "QWEN_JSON_RETRIES=3"

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo ========================================
echo JobMatch AI MVP
echo ========================================
echo.

if defined QWEN_API_KEY goto start

echo Enter DashScope API Key to enable Qwen analysis and Agent chat.
echo Leave it blank to start with rule-based fallback analysis.
echo.
for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$key = Read-Host 'DashScope API Key' -AsSecureString; $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }"`) do set "QWEN_API_KEY=%%A"

:start
echo.
if defined QWEN_API_KEY (
  echo Qwen analysis: enabled
  echo Model: %QWEN_MODEL%
) else (
  echo Qwen analysis: disabled
  echo The app will use rule-based fallback analysis.
)
echo.
echo Local URL: http://localhost:%PORT%
echo If %PORT% is busy, the server will automatically try the next port.
echo.

"%NODE_EXE%" --env-file-if-exists=.env server.js
pause
