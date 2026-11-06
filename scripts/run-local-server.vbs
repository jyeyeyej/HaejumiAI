Option Explicit

Dim mode, root, nodePath, entryPath, workDir, logDir, logPath
Dim fso, shell, logFile, quote, innerCommand, command, exitCode

If WScript.Arguments.Count <> 1 Then WScript.Quit 2
mode = LCase(WScript.Arguments(0))
root = "C:\HaejumiAI"
nodePath = "C:\Program Files\nodejs\node.exe"
logDir = root & "\data\runtime-logs"

Select Case mode
  Case "backend"
    entryPath = root & "\backend\src\adapters\node-http\server.js"
    workDir = root
  Case "web"
    entryPath = root & "\web\node_modules\vite\bin\vite.js"
    workDir = root & "\web"
  Case Else
    WScript.Quit 2
End Select

Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(nodePath) Or Not fso.FileExists(entryPath) Then WScript.Quit 3
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logPath = logDir & "\" & mode & ".log"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workDir
quote = Chr(34)
innerCommand = quote & nodePath & quote & " " & quote & entryPath & quote & " >> " & quote & logPath & quote & " 2>&1"
command = "cmd.exe /d /s /c " & quote & innerCommand & quote

Do
  Set logFile = fso.OpenTextFile(logPath, 8, True)
  logFile.WriteLine Now & " START " & mode
  logFile.Close

  On Error Resume Next
  exitCode = shell.Run(command, 0, True)
  If Err.Number <> 0 Then exitCode = 4
  On Error GoTo 0

  Set logFile = fso.OpenTextFile(logPath, 8, True)
  logFile.WriteLine Now & " EXIT " & mode & " code=" & exitCode
  logFile.Close

  If exitCode = 0 Then WScript.Quit 0
  ' Wait only after a child process exits abnormally; no periodic port checks.
  WScript.Sleep 300000
Loop
