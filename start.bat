@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" goto bridge-busy
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul 2>nul
rem "timeout" returns at once when stdin is not a console (e.g. a test harness pipes
rem it), so fall back to the ping timer: the wait stays bounded AND actually happens.
if errorlevel 1 ping -n 6 127.0.0.1 >nul
goto loop

rem --- guard: exit code 2 ------------------------------------------------------
rem src/bridge.js exits 2 when it believes another instance owns the lock or the
rem console port. The old branch was "pause" + "exit /b 2": this window - the only
rem thing that restarts the bridge - killed itself, and the bot stayed offline until
rem a human noticed (2026-10-04 21:16, ~21 minutes). Retry instead: the other holder
rem normally releases on its own, and the retry is what makes the guard a guard.
:bridge-busy
echo [%date% %time%] bridge exited (code 2): another instance or the console port is in use; retrying in 20 seconds...
timeout /t 20 /nobreak >nul 2>nul
rem "timeout" returns at once when stdin is not a console (e.g. a test harness pipes
rem it), so fall back to the ping timer: the wait stays bounded AND actually happens.
if errorlevel 1 ping -n 21 127.0.0.1 >nul
goto loop
