Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh
!include WinVer.nsh

!ifndef VERSION
  !error "VERSION must be defined by build-installer.mjs"
!endif
!ifndef OUTFILE
  !error "OUTFILE must be defined by build-installer.mjs"
!endif
!ifndef PAYLOAD
  !error "PAYLOAD must be defined by build-installer.mjs"
!endif
!define PRODUCT "Strata Managed Models"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\StrataManagedModels"
!define OWNER_MARKER "StrataManagedModels:5B157B33-47AD-43CC-8E0F-42F5F91D8290"
!macro InstallLog Message
  ReadEnvStr $R8 STRATA_MANAGED_INSTALL_LOG
  ${If} $R8 != ""
    ClearErrors
    FileOpen $R9 "$R8" a
    ${IfNot} ${Errors}
      FileWrite $R9 "${Message}$\r$\n"
      FileClose $R9
    ${EndIf}
  ${EndIf}
!macroend
!macro Fail Message
  !insertmacro InstallLog "${Message}"
  MessageBox MB_OK|MB_ICONSTOP "${Message}" /SD IDOK
  SetErrorLevel 1
  Abort
!macroend
Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\StrataManaged"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
BrandingText "Strata Managed Models"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "Strata Managed Models per-user installer"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Niko1221, Strata contributors, and fork contributors"
!ifdef PRODUCT_ICON
  Icon "${PRODUCT_ICON}"
  UninstallIcon "${PRODUCT_ICON}"
!endif
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\StrataManaged.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_TEXT "Open Strata Managed Models"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PAYLOAD}\licenses\Strata-LICENSE.txt"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Japanese"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    !insertmacro Fail "This installer requires 64-bit Windows."
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    !insertmacro Fail "This installer requires Windows 10 or newer."
  ${EndIf}
FunctionEnd

; A junction or symbolic link in an old installation must never redirect a repair or removal.
!macro SafeTree Prefix
Function ${Prefix}CheckTree
  Exch $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
  ${If} $1 == -1
    Goto treeDone
  ${EndIf}
  IntOp $2 $1 & 0x400
  ${If} $2 != 0
    !insertmacro Fail "The application folder contains a link. No application files were removed or replaced."
  ${EndIf}
  IntOp $1 $1 & 0x10
  ${If} $1 == 0
    Goto treeDone
  ${EndIf}
  ClearErrors
  FindFirst $2 $3 "$0\*"
  IfErrors treeDone
  treeScan:
    ${If} $3 == ""
      Goto treeClose
    ${EndIf}
    ${If} $3 != "."
    ${AndIf} $3 != ".."
      Push "$0\$3"
      Call ${Prefix}CheckTree
    ${EndIf}
    FindNext $2 $3
    IfErrors treeClose
    Goto treeScan
  treeClose:
    FindClose $2
  treeDone:
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd
!macroend
!insertmacro SafeTree ""
!insertmacro SafeTree "un."

Function CheckInstallTarget
  !insertmacro InstallLog "Install target input: $INSTDIR"
  StrCpy $0 "$INSTDIR"
  ${If} $0 == ""
    !insertmacro Fail "Choose a dedicated application folder."
  ${EndIf}
  ; Unlike NSIS GetFullPathName, this Win32 call does not require existing parent directories.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i .r2'
  !insertmacro InstallLog "Install target normalized: $1 (length $2)"
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    !insertmacro Fail "The application folder could not be normalized."
  ${EndIf}
  StrCpy $INSTDIR "$1"
  ReadRegStr $0 HKCU "${UNINST_KEY}" "InstallLocation"
  ${If} $0 != ""
    GetFullPathName $0 "$0"
    ${If} $0 != $INSTDIR
      IfFileExists "$0\.strata-managed-install" priorInstallConflict 0
      IfFileExists "$0\StrataManaged.exe" priorInstallConflict 0
      IfFileExists "$0\resources\node\node.exe" priorInstallConflict 0
    ${EndIf}
  ${EndIf}
  Goto priorLocationChecked
  priorInstallConflict:
    !insertmacro Fail "Strata Managed Models is installed in another folder. Use that folder, or uninstall it before choosing a new location."
  priorLocationChecked:
  ${If} $INSTDIR == ""
  ${OrIf} $INSTDIR == "$PROFILE"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA\StrataManaged"
  ${OrIf} $INSTDIR == "$WINDIR"
  ${OrIf} $INSTDIR == "$PROGRAMFILES"
  ${OrIf} $INSTDIR == "$PROGRAMFILES64"
    !insertmacro Fail "Choose a dedicated application folder."
  ${EndIf}
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
    !insertmacro Fail "Strata cannot be installed directly in a drive root."
  ${EndIf}
  IfFileExists "$INSTDIR\.strata-managed-install" owned existingCheck
  owned:
    FileOpen $0 "$INSTDIR\.strata-managed-install" r
    FileRead $0 $1
    FileClose $0
    ${If} $1 != "${OWNER_MARKER}"
      !insertmacro Fail "This application folder has an unrecognized owner marker."
    ${EndIf}
    Push "$INSTDIR"
    Call CheckTree
    IfFileExists "$INSTDIR\StrataManaged.exe" 0 targetOK
    ExecWait '"$INSTDIR\StrataManaged.exe" --stop --wait' $0
    ${If} $0 != 0
      !insertmacro Fail "Close Strata Managed Models and try again. No application files were replaced."
    ${EndIf}
    Goto targetOK
  existingCheck:
    FindFirst $0 $1 "$INSTDIR\*"
    scan:
      ${If} $1 == ""
        Goto scanDone
      ${EndIf}
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        FindClose $0
        !insertmacro Fail "The selected folder is not empty. Choose a new folder for this application."
      ${EndIf}
      FindNext $0 $1
      IfErrors scanDone
      Goto scan
    scanDone:
      FindClose $0
  targetOK:
FunctionEnd

Section "Strata Managed Models" SEC_APP
  SectionIn RO
  Call CheckInstallTarget
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk" "$INSTDIR\StrataManaged.exe"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Models.lnk" "$INSTDIR\StrataManaged.exe" "--models"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\API connections.lnk" "$INSTDIR\StrataManaged.exe" "--api"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Tailscaleで共有.lnk" "$INSTDIR\StrataManaged.exe" "--tailscale"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Tailscale共有を停止.lnk" "$INSTDIR\StrataManaged.exe" "--tailscale-off"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Readme (Japanese).lnk" "$SYSDIR\notepad.exe" '"$INSTDIR\README.ja.txt"'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Strata Managed Models contributors"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\StrataManaged.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/bassmicrobe/Strata-Managed-Models"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  !ifdef ESTIMATED_SIZE
    WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" ${ESTIMATED_SIZE}
  !endif
SectionEnd

Section /o "Desktop shortcut" SEC_DESKTOP
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\StrataManaged.exe"
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Section "Uninstall"
  GetFullPathName $INSTDIR "$INSTDIR"
  ReadRegStr $0 HKCU "${UNINST_KEY}" "InstallLocation"
  ${If} $0 != $INSTDIR
    !insertmacro Fail "The installed application folder could not be verified."
  ${EndIf}
  IfFileExists "$INSTDIR\.strata-managed-install" 0 unrefuse
  FileOpen $0 "$INSTDIR\.strata-managed-install" r
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "${OWNER_MARKER}"
    Goto unrefuse
  ${EndIf}
  Push "$INSTDIR"
  Call un.CheckTree
  IfFileExists "$INSTDIR\StrataManaged.exe" 0 stopped
  ExecWait '"$INSTDIR\StrataManaged.exe" --tailscale-off --no-browser' $0
  ${If} $0 != 0
    !insertmacro Fail "Tailscale sharing could not be disabled. Check Tailscale, finish active requests, and try uninstalling again. Other Tailscale mappings were not removed."
  ${EndIf}
  ExecWait '"$INSTDIR\StrataManaged.exe" --stop --wait' $0
  ${If} $0 != 0
    !insertmacro Fail "Close Strata Managed Models before uninstalling."
  ${EndIf}
  stopped:
    SetOutPath "$TEMP"
    Delete "$DESKTOP\${PRODUCT}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT}\Models.lnk"
    Delete "$SMPROGRAMS\${PRODUCT}\API connections.lnk"
    Delete "$SMPROGRAMS\${PRODUCT}\Tailscaleで共有.lnk"
    Delete "$SMPROGRAMS\${PRODUCT}\Tailscale共有を停止.lnk"
    Delete "$SMPROGRAMS\${PRODUCT}\Readme (Japanese).lnk"
    RMDir "$SMPROGRAMS\${PRODUCT}"
    ; Only these installer-owned application folders are removed. User profiles/models are elsewhere.
    RMDir /r "$INSTDIR\host"
    RMDir /r "$INSTDIR\runtime"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\licenses"
    Delete "$INSTDIR\StrataManaged.exe"
    Delete "$INSTDIR\managed-install.json"
    Delete "$INSTDIR\README.ja.md"
    Delete "$INSTDIR\README.ja.txt"
    Delete "$INSTDIR\.strata-managed-install"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"
    DeleteRegKey HKCU "${UNINST_KEY}"
    Goto unend
  unrefuse:
    !insertmacro Fail "This folder was not installed by Strata Managed Models. No files were removed."
  unend:
SectionEnd
