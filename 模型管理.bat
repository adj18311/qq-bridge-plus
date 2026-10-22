@echo off
rem ---------------------------------------------------------------------------
rem  Model manager bat -- double-click entry for scripts/model-tui.mjs
rem
rem  !!! KEEP THIS FILE ASCII-ONLY EXCEPT THE "title" LINE BELOW !!!
rem
rem  Why: with a ConPTY console (Windows Terminal / recent conhost) + chcp 65001,
rem  cmd mangles non-ASCII echo/rem lines and then executes the fragments as
rem  commands -- the user sees e.g.
rem      'on' is not recognized as an internal or external command,
rem      '<mojibake>' is not recognized as an internal or external command,
rem  Measured 2026-10-12 (real ConPTY, cmd /c with this bat): 2-3 fake commands
rem  with Chinese echo/rem lines, 0 after converting them to ASCII. A Chinese
rem  "title" line is safe (verified) and is kept so the window title stays nice.
rem  Non-TTY runs (pipes / CI) do NOT reproduce it -- cmd takes a different
rem  parsing path there, which is why line-by-line and whole-file tests passed.
rem
rem  Also: UTF-8 without BOM + CRLF; %~dp0 for relative paths; %* is passed
rem  through, so extra flags (e.g. --input number, --dry-run) work.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"
title 模型管理 - QQ bridge
node "%~dp0scripts\model-tui.mjs" %*
echo.
rem Pass node's exit code through to the caller: `pause` would overwrite
rem errorlevel with 0, which makes scripted/automated calls look successful.
rem   0=ok / 1=run failed or config.json was changed by someone else
rem   2=usage error or non-interactive stdin / 130=user pressed Ctrl+C
set "code=%errorlevel%"
pause
endlocal & exit /b 0%code%
