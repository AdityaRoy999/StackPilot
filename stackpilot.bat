@echo off
setlocal
if exist "%~dp0.stackpilot-venv\Scripts\stackpilot.exe" goto installed
set "PYTHONPATH=%~dp0stackpilot-cli;%PYTHONPATH%"
python -m stackpilot_cli.cli %*
exit /b %errorlevel%
:installed
"%~dp0.stackpilot-venv\Scripts\stackpilot.exe" %*
exit /b %errorlevel%
