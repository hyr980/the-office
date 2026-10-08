@echo off
cd /d "%~dp0"
echo === OfficeShell selftest ===
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "OfficeShell.ps1" -SelfTest
echo === exit=%ERRORLEVEL% ===
pause
