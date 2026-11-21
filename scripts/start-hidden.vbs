' PowerApps Solution Migrator - starts the migrator without a console window.
'
' Used by the "PowerApps Solution Migrator" shortcut and by Start-Migrator.cmd.
' The server runs hidden (nothing in the taskbar) and stops by itself when you close the migrator
' tab in your browser. Its messages are written to data\logs\migrator.log.
'
'   wscript start-hidden.vbs           check Node.js and the components, then start hidden
'                                      (opens Start-Migrator.cmd in a window if an install is needed)
'   wscript start-hidden.vbs /server   start the server hidden right away (used by Start-Migrator.cmd)
Option Explicit

Dim sh, fso, root, logDir, logFile, rc, env, serverOnly, port
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

serverOnly = False
If WScript.Arguments.Count > 0 Then serverOnly = (LCase(WScript.Arguments(0)) = "/server")

' Already running (for example, the shortcut was opened twice)? Then just show it in the browser.
port = ReadPort()
If MigratorAnswers(port) Then
  sh.Run "http://localhost:" & port & "/", 1, False
  WScript.Quit 0
End If

If Not serverOnly Then
  ' Node.js installed and the components ready? Checked without showing a window.
  rc = sh.Run("cmd /c where node >nul 2>nul && node scripts\check-deps.js >nul 2>nul", 0, True)
  If rc <> 0 Then
    ' First run, after an update, or Node.js missing: Start-Migrator.cmd shows what it does
    ' (installing components, or a link to Node.js) in a window, then starts the server hidden.
    sh.Run """" & root & "\Start-Migrator.cmd""", 1, False
    WScript.Quit 0
  End If
  ' Shortcut markers missing (fresh copy): let Start-Migrator.cmd create the shortcuts.
  If Not fso.FileExists(root & "\data\.shortcut-v3") Then
    sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & root & "\scripts\create-shortcuts.ps1""", 0, False
  End If
End If

logDir = root & "\data\logs"
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder root & "\data"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = logDir & "\migrator.log"

Set env = sh.Environment("Process")
env("OPEN_BROWSER") = "1"
env("AUTO_EXIT") = "1"

' 0 = hidden window; True = wait, so a start-up error can be reported below.
rc = sh.Run("cmd /c node server.js > """ & logFile & """ 2>&1", 0, True)
If rc <> 0 Then
  MsgBox "The PowerApps Solution Migrator stopped because of an error." & vbCrLf & vbCrLf & _
         "Details are in:" & vbCrLf & logFile & vbCrLf & vbCrLf & _
         "Tip: double-click Start-Migrator.cmd to see the messages in a window.", vbExclamation, "PowerApps Solution Migrator"
End If

' The port from .env (PORT=...), or 3000.
Function ReadPort()
  Dim f, line, re, m
  ReadPort = "3000"
  If Not fso.FileExists(root & "\.env") Then Exit Function
  Set re = New RegExp
  re.Pattern = "^\s*PORT\s*=\s*[""']?(\d{2,5})"
  Set f = fso.OpenTextFile(root & "\.env", 1)
  Do Until f.AtEndOfStream
    line = f.ReadLine
    If re.Test(line) Then
      Set m = re.Execute(line)
      ReadPort = m(0).SubMatches(0)
    End If
  Loop
  f.Close
End Function

' True when the migrator already answers on this port.
Function MigratorAnswers(p)
  Dim http
  MigratorAnswers = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1500, 1500
  http.Open "GET", "http://127.0.0.1:" & p & "/api/config", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 And InStr(http.responseText, "mockMode") > 0 Then MigratorAnswers = True
  End If
  On Error GoTo 0
End Function
