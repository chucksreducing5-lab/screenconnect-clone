Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d c:\Users\dell\Desktop\remote-support-web && node server.js", 0, False
