@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if defined TPMS_PYTHON (
  "%TPMS_PYTHON%" "%~dp0app.py" %*
) else if exist "D:\anaconda3\python.exe" (
  "D:\anaconda3\python.exe" "%~dp0app.py" %*
) else (
  python "%~dp0app.py" %*
)
set "TPMS_EXIT_CODE=%ERRORLEVEL%"
if not "%TPMS_EXIT_CODE%"=="0" pause
exit /b %TPMS_EXIT_CODE%
