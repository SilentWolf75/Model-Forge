; https://www.electron.build/nsis#custom-nsis-script
; ProgIDs in package.json `fileAssociations[].name` must match Capabilities\FileAssociations below.

!ifndef BUILD_UNINSTALLER
Var /GLOBAL wantDesktopShortcut
!endif

!macro customInit
  !ifndef BUILD_UNINSTALLER
  StrCpy $wantDesktopShortcut "0"
  !endif
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 customInit_done
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "An existing installation of ${PRODUCT_NAME} was found:$\r$\n$INSTDIR$\r$\n$\r$\n\
Install this version over the current one?$\r$\n$\r$\n\
• Yes — upgrade in place (recommended).$\r$\n\
• No — exit now. Uninstall the old version in Windows Settings → Apps first if you want a clean install, then run this installer again." \
    IDYES customInit_done
  Quit
customInit_done:
  !ifndef BUILD_UNINSTALLER
    IfSilent skip_desktop_question
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Create a desktop shortcut for ${PRODUCT_NAME}?$\r$\n$\r$\n\
• Yes — add an icon on the desktop (Start menu shortcut is always created).$\r$\n\
• No — only use the Start menu shortcut." \
      IDYES mf_desktop_yes
    StrCpy $wantDesktopShortcut "0"
    Goto mf_desktop_done
    mf_desktop_yes:
      StrCpy $wantDesktopShortcut "1"
    mf_desktop_done:
    skip_desktop_question:
  !endif
!macroend

; After registerFileAssociations — publish for Windows “Default apps” / Open with discovery.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_FILENAME}" "Software\${APP_FILENAME}\Capabilities"

  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities" "ApplicationDescription" "${APP_DESCRIPTION}"
  ; Match shortcut icons: always advertise the .exe icon (rcedit) so “Default apps” / shell don’t stick to an old icon.ico.
  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities" "ApplicationIcon" "$appExe,0"

  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities\FileAssociations" ".stl" "ModelForge.stl"
  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities\FileAssociations" ".obj" "ModelForge.obj"
  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities\FileAssociations" ".3mf" "ModelForge.3mf"
  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities\FileAssociations" ".step" "ModelForge.step"
  WriteRegStr SHELL_CONTEXT "Software\${APP_FILENAME}\Capabilities\FileAssociations" ".stp" "ModelForge.stp"

  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$appExe"

  ; Defined in FileAssociation.nsh (included before this macro runs).
  !insertmacro UPDATEFILEASSOC

  ${If} $wantDesktopShortcut == "1"
    ; Drop old .lnk so Explorer can’t keep a cached bitmap; same target/icon as electron-builder’s template.
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}

  ; When KeepShortcuts is true, addStartMenuLink skips recreating the Start menu .lnk — icon can stay stale after upgrades.
  ${If} ${FileExists} "$newStartMenuLink"
    Delete "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_FILENAME}"
  DeleteRegKey SHELL_CONTEXT "Software\${APP_FILENAME}"
  DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"

  WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
!macroend
