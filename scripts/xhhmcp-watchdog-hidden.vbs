' Silent entry point for scheduled task QQBridge-XhhMCP-Watchdog.
' Running node.exe directly from Task Scheduler flashes a console window every
' minute; launching it through wscript with window style 0 keeps it invisible.
' Keep this file pure ASCII: VBScript reads .vbs as ANSI by default, and multi
' byte comments can swallow the following newline.
' Args: 0 = hidden window, False = do not wait for the child process.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\qq-bridge"
sh.Run """D:\Node\node.exe"" ""D:\qq-bridge\scripts\xhhmcp-watchdog.mjs"" --check", 0, False
